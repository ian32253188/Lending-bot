#!/usr/bin/env python3
"""Train and evaluate versioned USD shadow models from PostgreSQL research data.

The final 15-day interval is a sealed first-pass test. Hyperparameters are selected
only on days 31-45; test labels crossing the split boundary are purged. This script
never contacts Bitfinex or places/cancels orders.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor, Json
from postgres_connection import postgres_host_tls, require_verified_tls_dsn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import HuberRegressor, QuantileRegressor, Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import StandardScaler

FEATURE_NAMES = [
    'frr', 'fundingVwap', 'frrChange5m', 'frrChange15m', 'frrChange1h', 'frrChange6h',
    'frrVolatility5m', 'frrVolatility15m', 'frrVolatility1h', 'frrVolatility6h',
    'vwapChange5m', 'vwapChange15m', 'vwapChange1h', 'vwapChange6h',
    'vwapVolatility5m', 'vwapVolatility15m', 'vwapVolatility1h', 'vwapVolatility6h',
    'bestBid', 'bestAsk', 'spread', 'spreadRelative', 'bidDepth5', 'askDepth5', 'bookImbalance5',
    'tradeVolume', 'tradeCount', 'tenorMean', 'tenorShortShare', 'tenorMediumShare', 'tenorLongShare',
    'hourSin', 'hourCos', 'weekdaySin', 'weekdayCos',
]
DAY = dt.timedelta(days=1)
MAX_FIT_ROWS_PER_SPLIT = 5_000


def connect():
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        host = os.environ.get('PGHOST') or os.environ.get('POSTGRES_HOST')
        password = os.environ.get('PGPASSWORD') or os.environ.get('POSTGRES_PASSWORD')
        if not host or not password:
            raise RuntimeError('請設定 DATABASE_URL 或 PGHOST、PGUSER、PGPASSWORD、PGDATABASE。')
        return psycopg2.connect(host=host, port=os.environ.get('PGPORT', 5432),
                                user=os.environ.get('PGUSER', 'postgres'), password=password,
                                dbname=os.environ.get('PGDATABASE', 'lending_bot'),
                                **postgres_host_tls(host))
    return psycopg2.connect(require_verified_tls_dsn(dsn))


def load_env_file(path):
    if not path or not path.exists():
        return
    for raw_line in path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def scalar_features(value):
    return [float(value.get(name) or 0) for name in FEATURE_NAMES]


def load_rows(connection, start, warmup_end, validation_end, test_end):
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute("""
            SELECT d.decision_at, b.features, d.actual_rate, d.label_at
            FROM research_decisions d
            JOIN research_market_bars b ON b.currency = d.currency AND b.minute_at = d.decision_at
            WHERE d.currency = 'USD' AND d.model_id = 'persistence'
              AND d.actual_rate IS NOT NULL AND d.label_at IS NOT NULL
              AND d.decision_at >= %s AND d.decision_at < %s
            ORDER BY d.decision_at ASC
        """, (start, test_end))
        rows = cursor.fetchall()
        cursor.execute("""
            SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE offer_matched) AS matched
            FROM research_funding_fills WHERE currency = 'USD'
              AND executed_at >= %s AND executed_at < %s
        """, (start, test_end))
        fills = cursor.fetchone()
        cursor.execute("""
            SELECT COUNT(*) FILTER (WHERE minute_at >= %s AND minute_at < %s
                AND features->'dataQuality'->>'tickerFresh' = 'true'
                AND features->'dataQuality'->>'bookFresh' = 'true'
                AND features->'dataQuality'->>'tradeFresh' = 'true') AS complete
            FROM research_market_bars WHERE currency = 'USD'
        """, (start, test_end))
        coverage = int(cursor.fetchone()['complete'] or 0)

    train, validation, test = [], [], []
    for row in rows:
        item = (scalar_features(row['features']), float(row['actual_rate']), row['decision_at'], row['label_at'])
        when, label_at = row['decision_at'], row['label_at']
        # Purge outcomes that cross a split end. Validation labels never enter training;
        # test labels never enter parameter selection or model fitting.
        if start <= when < warmup_end and label_at <= warmup_end:
            train.append(item)
        elif warmup_end <= when < validation_end and label_at <= validation_end:
            validation.append(item)
        elif validation_end <= when < test_end and label_at <= test_end:
            test.append(item)
    return train, validation, test, dict(fills), coverage


def bounded(rows, limit=MAX_FIT_ROWS_PER_SPLIT):
    if len(rows) <= limit:
        return rows
    indices = np.linspace(0, len(rows) - 1, num=limit, dtype=int)
    return [rows[index] for index in indices]


def pinball(y, pred, quantile):
    residual = np.asarray(y) - np.asarray(pred)
    return float(np.mean(np.maximum(quantile * residual, (quantile - 1) * residual)))


def arrays(rows):
    bounded_rows = bounded(rows)
    return (np.asarray([row[0] for row in bounded_rows], dtype=float),
            np.asarray([row[1] for row in bounded_rows], dtype=float))


def export_linear(model, scaler, version):
    return {
        'kind': 'linear', 'version': version,
        'mean': [float(v) for v in scaler.mean_],
        'scale': [float(v) for v in scaler.scale_],
        'coefficients': [float(v) for v in model.coef_],
        'intercept': float(model.intercept_),
    }


def export_hgb(model, version):
    trees = []
    for iteration in model._predictors:
        tree_predictor = iteration[0] if isinstance(iteration, (list, tuple)) else iteration
        exported = []
        for node in tree_predictor.nodes:
            exported.append({
                'feature': int(node['feature_idx']) if not node['is_leaf'] else -1,
                'threshold': float(node['num_threshold']),
                'left': int(node['left']), 'right': int(node['right']),
                'value': float(node['value']), 'isLeaf': bool(node['is_leaf']),
            })
        trees.append(exported)
    return {
        'kind': 'histGradientBoosting', 'version': version,
        'baseline': float(model._baseline_prediction[0, 0]),
        'learningRate': float(model.learning_rate), 'trees': trees,
    }


def choose_linear(train, validation, model_name):
    x_train, y_train = arrays(train)
    x_valid, y_valid = arrays(validation)
    scaler = StandardScaler().fit(x_train)
    xtr, xva = scaler.transform(x_train), scaler.transform(x_valid)
    candidates = []
    if model_name == 'ridge':
        for alpha in (0.1, 1.0, 10.0):
            model = Ridge(alpha=alpha).fit(xtr, y_train)
            candidates.append({'loss': float(mean_absolute_error(y_valid, model.predict(xva))), 'parameters': {'alpha': alpha}})
    else:
        for epsilon in (1.2, 1.35, 1.5):
            model = HuberRegressor(epsilon=epsilon, max_iter=1000).fit(xtr, y_train)
            candidates.append({'loss': float(mean_absolute_error(y_valid, model.predict(xva))), 'parameters': {'epsilon': epsilon}})
    params = min(candidates, key=lambda candidate: candidate['loss'])['parameters']
    combined = bounded(train + validation)
    x_all, y_all = arrays(combined)
    scaler_final = StandardScaler().fit(x_all)
    final_x = scaler_final.transform(x_all)
    if model_name == 'ridge':
        final_model = Ridge(alpha=params['alpha']).fit(final_x, y_all)
    else:
        final_model = HuberRegressor(epsilon=params['epsilon'], max_iter=1000).fit(final_x, y_all)
    final_scaler = scaler_final
    if model_name == 'ridge':
        val_model = Ridge(alpha=params['alpha']).fit(xtr, y_train)
    else:
        val_model = HuberRegressor(epsilon=params['epsilon'], max_iter=1000).fit(xtr, y_train)
    return export_linear(final_model, final_scaler, model_name), params, candidates


def evaluate_and_export(connection, output_path):
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute("SELECT MIN(minute_at) AS first_at FROM research_market_bars WHERE currency = 'USD'")
        start = cursor.fetchone()['first_at']
        cursor.execute("SELECT MAX(horizon_minutes) AS horizon FROM research_decisions WHERE model_id = 'persistence'")
        horizon_minutes = cursor.fetchone()['horizon']
    if not start:
        raise RuntimeError('尚無 USD 分鐘行情資料。')
    warmup_end, validation_end, test_end = start + 30 * DAY, start + 45 * DAY, start + 60 * DAY
    train, validation, test, fills, complete_minutes = load_rows(connection, start, warmup_end, validation_end, test_end)
    if len(train) < 500 or len(validation) < 100 or len(test) < 100:
        raise RuntimeError(f'標籤樣本不足：train={len(train)}, validation={len(validation)}, test={len(test)}。需要延長收集。')
    expected = 60 * 24 * 60
    coverage = min(1.0, complete_minutes / expected)
    matched = int(fills['matched'] or 0)
    if coverage < 0.9 or matched < 50:
        raise RuntimeError(f'資料不足，暫不發布模型：60 天完整度 {coverage:.1%}，配對成交 {matched} 筆。')

    digest = hashlib.sha256(f'{start.isoformat()}:{dt.datetime.now(dt.timezone.utc).isoformat()}'.encode()).hexdigest()[:12]
    version = f'usd-shadow-{digest}'
    artifact = {'schemaVersion': 1, 'version': version, 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'horizonMinutes': int(horizon_minutes) if horizon_minutes else 24 * 60,
                'featureNames': FEATURE_NAMES, 'models': {}}
    metric_rows = []
    y_test = np.asarray([row[1] for row in bounded(test)])
    x_test = np.asarray([row[0] for row in bounded(test)], dtype=float)

    for model_name in ('ridge', 'huber'):
        exported, params, validation_trials = choose_linear(train, validation, model_name)
        artifact['models'][model_name] = exported
        scaler_val = StandardScaler().fit(arrays(train)[0])
        x_train_val, y_train_val = arrays(train)
        x_valid, y_valid = arrays(validation)
        if model_name == 'ridge':
            val_model = Ridge(alpha=params['alpha']).fit(scaler_val.transform(x_train_val), y_train_val)
            final_scaler = StandardScaler().fit(arrays(train + validation)[0])
            final_model = Ridge(alpha=params['alpha']).fit(final_scaler.transform(arrays(train + validation)[0]), arrays(train + validation)[1])
        else:
            val_model = HuberRegressor(epsilon=params['epsilon'], max_iter=1000).fit(scaler_val.transform(x_train_val), y_train_val)
            final_scaler = StandardScaler().fit(arrays(train + validation)[0])
            final_model = HuberRegressor(epsilon=params['epsilon'], max_iter=1000).fit(final_scaler.transform(arrays(train + validation)[0]), arrays(train + validation)[1])
        valid_mae = float(mean_absolute_error(y_valid, val_model.predict(scaler_val.transform(x_valid))))
        test_mae = float(mean_absolute_error(y_test, final_model.predict(final_scaler.transform(x_test))))
        metric_rows.append((model_name, params, valid_mae, {'mae': test_mae}, validation_trials))

    x_train, y_train = arrays(train)
    x_valid, y_valid = arrays(validation)
    hgb_candidates = []
    for leaf_nodes in (7, 15):
        model = HistGradientBoostingRegressor(max_iter=80, learning_rate=0.05,
                    max_leaf_nodes=leaf_nodes, l2_regularization=1.0, random_state=17).fit(x_train, y_train)
        hgb_candidates.append({'loss': float(mean_absolute_error(y_valid, model.predict(x_valid))),
                               'parameters': {'max_leaf_nodes': leaf_nodes, 'max_iter': 80}})
    best_hgb = min(hgb_candidates, key=lambda candidate: candidate['loss'])
    valid_mae, best_nodes = best_hgb['loss'], best_hgb['parameters']['max_leaf_nodes']
    combined = bounded(train + validation)
    x_all, y_all = arrays(combined)
    hgb_final = HistGradientBoostingRegressor(max_iter=80, learning_rate=0.05,
                    max_leaf_nodes=best_nodes, l2_regularization=1.0, random_state=17).fit(x_all, y_all)
    x_test_raw = np.asarray([row[0] for row in bounded(test)], dtype=float)
    test_mae = float(mean_absolute_error(y_test, hgb_final.predict(x_test_raw)))
    artifact['models']['hist_gradient_boosting'] = export_hgb(hgb_final, version)
    metric_rows.append(('hist_gradient_boosting', best_hgb['parameters'], float(valid_mae), {'mae': test_mae}, hgb_candidates))

    quantile_choices = []
    xtr, ytr = arrays(train)
    xva, yva = arrays(validation)
    quantile_scaler = StandardScaler().fit(xtr)
    for alpha in (0.001, 0.01):
        losses = []
        for q in (0.1, 0.5, 0.9):
            model = QuantileRegressor(quantile=q, alpha=alpha, solver='highs').fit(quantile_scaler.transform(xtr), ytr)
            losses.append(pinball(yva, model.predict(quantile_scaler.transform(xva)), q))
        quantile_choices.append({'loss': float(np.mean(losses)), 'parameters': {'alpha': alpha},
                                 'quantilePinball': losses})
    best_quantile = min(quantile_choices, key=lambda candidate: candidate['loss'])
    quantile_validation_loss, alpha = best_quantile['loss'], best_quantile['parameters']['alpha']
    x_all, y_all = arrays(train + validation)
    quantile_final_scaler = StandardScaler().fit(x_all)
    final_models, quantile_test_predictions, quantile_metrics = {}, {}, {}
    for q, key in ((0.1, 'p10'), (0.5, 'p50'), (0.9, 'p90')):
        model = QuantileRegressor(quantile=q, alpha=alpha, solver='highs').fit(quantile_final_scaler.transform(x_all), y_all)
        final_models[key] = export_linear(model, quantile_final_scaler, version)
        quantile_test_predictions[key] = model.predict(quantile_final_scaler.transform(x_test))
        quantile_metrics[f'pinball_{key}'] = pinball(y_test, quantile_test_predictions[key], q)
    quantile_metrics['interval_coverage'] = float(np.mean((y_test >= quantile_test_predictions['p10']) & (y_test <= quantile_test_predictions['p90'])))
    quantile_metrics['mae_p50'] = float(mean_absolute_error(y_test, quantile_test_predictions['p50']))
    artifact['models']['quantile'] = {'kind': 'quantile', 'version': version, 'models': final_models}
    metric_rows.append(('quantile', {'alpha': alpha}, float(quantile_validation_loss), quantile_metrics, quantile_choices))

    with connection.cursor() as cursor:
        for model_id, params, validation_metric, test_metrics, validation_trials in metric_rows:
            for index, trial in enumerate(validation_trials):
                trial_key = f'{version}:{model_id}:validation:{index + 1}'
                cursor.execute("""
                    INSERT INTO research_experiments (
                        experiment_key, model_id, model_version, stage, started_at, finished_at,
                        train_start, train_end, validation_start, validation_end,
                        metrics, status)
                    VALUES (%s, %s, %s, 'validation', NOW(), NOW(), %s, %s, %s, %s, %s, 'completed')
                    ON CONFLICT (experiment_key) DO UPDATE SET
                        finished_at = NOW(), metrics = EXCLUDED.metrics, status = 'completed'
                """, (trial_key, model_id, version, start, warmup_end, warmup_end, validation_end,
                      Json({'parameters': trial['parameters'], 'primary_loss': trial['loss'],
                            'quantilePinball': trial.get('quantilePinball'), 'samples': len(validation)})))
            metrics = {'parameters': params, 'validation_primary_loss': validation_metric,
                       'test': test_metrics, 'train_samples': len(train),
                       'validation_samples': len(validation), 'test_samples': len(test),
                       'fit_rows_per_split': MAX_FIT_ROWS_PER_SPLIT,
                       'coverage60Days': coverage, 'matchedFills': matched,
                       'purgeEmbargo': 'labels must mature inside each time window'}
            experiment_key = f'{version}:{model_id}:sealed-test'
            cursor.execute("""
                INSERT INTO research_experiments (
                    experiment_key, model_id, model_version, stage, started_at, finished_at,
                    train_start, train_end, validation_start, validation_end, test_start, test_end,
                    metrics, status)
                VALUES (%s, %s, %s, 'sealed_test', NOW(), NOW(), %s, %s, %s, %s, %s, %s, %s, 'completed')
                ON CONFLICT (experiment_key) DO UPDATE SET
                    finished_at = NOW(), metrics = EXCLUDED.metrics, status = 'completed'
            """, (experiment_key, model_id, version, start, warmup_end, warmup_end, validation_end,
                  validation_end, test_end, Json(metrics)))
        cursor.execute("UPDATE research_model_artifacts SET active = FALSE WHERE active = TRUE")
        cursor.execute("""
            INSERT INTO research_model_artifacts (version, artifact, active)
            VALUES (%s, %s, TRUE)
            ON CONFLICT (version) DO UPDATE SET artifact = EXCLUDED.artifact, active = TRUE
        """, (version, Json(artifact)))
    connection.commit()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(artifact, indent=2), encoding='utf-8')
    temporary.replace(output_path)
    return metric_rows, coverage, matched, (len(train), len(validation), len(test))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'server' / 'data' / 'research-models.json')
    parser.add_argument('--env-file', type=Path, default=Path(__file__).resolve().parents[1] / '.env',
                        help='載入 PostgreSQL 連線設定；內容不會輸出或保存到研究資料。')
    args = parser.parse_args()
    load_env_file(args.env_file)
    with connect() as connection:
        metrics, coverage, matched, counts = evaluate_and_export(connection, args.output)
    print(f'輸出模型：{args.output}')
    print(f'60 天完整度：{coverage:.1%}；精確配對成交：{matched}；樣本 train/validation/test={counts}；每區間最多使用 {MAX_FIT_ROWS_PER_SPLIT:,} 筆等距樣本')
    for model, params, validation_loss, test, _ in metrics:
        print(f'{model}: validation_loss={validation_loss:.10g}; sealed_test={json.dumps(test, ensure_ascii=False)}; params={params}')


if __name__ == '__main__':
    main()
