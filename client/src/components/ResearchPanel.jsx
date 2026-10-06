import { useEffect, useState } from 'react';

const MODEL_ROWS = [
    ['live_strategy', '現行策略基準'],
    ['persistence', '持續性基準'],
    ['hour_mean', '近一小時均值'],
    ['ridge', 'Ridge regression'],
    ['huber', 'Huber regression'],
    ['hist_gradient_boosting', 'HistGradientBoosting'],
    ['quantile', 'Quantile regression'],
];

const STAGE_LABELS = {
    warmup: '資料收集與預測期間校準',
    validation: '驗證區間',
    sealed_initial_review: '鎖定初評區間',
    initial_review: '初評完成',
    extend_collection: '延長資料收集',
};

function formatDate(value) {
    if (!value) return '尚無資料';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-TW', { hour12: false }) : '尚無資料';
}

function formatRate(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 365 * 100).toFixed(3)}%`;
}

function formatMetric(value, digits = 2) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(digits)}%`;
}

function formatLoss(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toExponential(2);
}

function formatAge(seconds) {
    if (!Number.isFinite(Number(seconds))) return '尚無資料';
    if (Number(seconds) < 60) return `${Math.round(seconds)} 秒前`;
    return `${Math.floor(Number(seconds) / 60)} 分鐘前`;
}

export default function ResearchPanel({ token }) {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        let active = true;
        const refresh = async () => {
            try {
                const response = await fetch('/api/research/status', {
                    headers: { Authorization: `Bearer ${token}` },
                    cache: 'no-store',
                });
                if (!response.ok) throw new Error('研究狀態服務暫時無法讀取');
                const data = await response.json();
                if (active) {
                    setStatus(data);
                    setError('');
                }
            } catch (err) {
                if (active) setError(err.message || '研究狀態服務暫時無法讀取');
            }
        };
        refresh();
        const interval = setInterval(refresh, 60_000);
        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [token]);

    const modelStats = new Map();
    for (const row of status?.models || []) {
        if (!modelStats.has(row.model_id)) modelStats.set(row.model_id, row);
    }
    const collectionState = status?.collection?.state;
    const isHealthy = status?.market?.fresh && collectionState === 'healthy';
    const stage = STAGE_LABELS[status?.evaluation?.stage] || '等待第一筆行情資料';
    const sealedQuantile = status?.experiments?.find(row => row.model_id === 'quantile' && row.stage === 'sealed_test' && row.status === 'completed')?.metrics?.test;

    return (
        <section className="research-panel" aria-labelledby="research-title">
            <div className="research-heading">
                <div>
                    <h2 id="research-title">USD 影子研究</h2>
                    <p>逐分鐘保存市場特徵並比較候選模型；所有建議只在模擬資金中評分，不會送出或取消訂單。</p>
                </div>
                <span className={`research-state ${isHealthy ? 'is-healthy' : 'is-waiting'}`}>
                    <span aria-hidden="true" />
                    {isHealthy ? '行情收集中' : collectionState === 'error' ? '收集有問題' : '等待資料'}
                </span>
            </div>

            {error && <p className="research-error" role="status">{error}</p>}
            {status?.databaseReady === false && <p className="research-error" role="status">PostgreSQL 尚未啟用，研究資料不會保存在本機記憶體以外。</p>}

            <dl className="research-metrics">
                <div>
                    <dt>最新行情</dt>
                    <dd>{formatAge(status?.market?.ageSeconds)}</dd>
                    <small>{formatDate(status?.market?.latestAt)}</small>
                </div>
                <div>
                    <dt>近 60 天完整度</dt>
                    <dd>{formatMetric(status?.market?.coverage60Days, 1)}</dd>
                    <small>{Number(status?.market?.count || 0).toLocaleString('zh-TW')} 筆分鐘資料</small>
                </div>
                <div>
                    <dt>Funding 成交配對</dt>
                    <dd>{Number(status?.fills?.matched || 0).toLocaleString('zh-TW')} / {Number(status?.fills?.count || 0).toLocaleString('zh-TW')}</dd>
                    <small>使用 OFFER_ID 精確關聯</small>
                </div>
                <div>
                    <dt>評估階段</dt>
                    <dd className="research-stage">{stage}</dd>
                    <small>{Number(status?.evaluation?.elapsedDays || 0).toFixed(1)} / 60 天</small>
                </div>
            </dl>

            <div className="research-meta-line">
                <span>預測期間：{status?.horizon?.locked ? `${(Number(status.horizon.minutes) / 60).toFixed(1)} 小時` : '暫用 24 小時，30 天後校準'}</span>
                <span>每模型情境：14 筆 × $500，共 $7,000；期限 {status?.simulation?.periodDays || 2} 天</span>
                <span>資料保留：{status?.retentionDays || 180} 天</span>
                <span>近 24 小時缺口：{Number(status?.market?.gaps24h || 0)}；收集錯誤：{Number(status?.market?.collectionErrors24h || 0)}</span>
            </div>

            {status?.evaluation?.insufficientData && (
                <p className="research-note">60 天初評條件尚未達成：需要至少 90% 行情完整度與 50 筆精確配對成交，收集會繼續。</p>
            )}
            {status?.evaluation?.pendingSealedReview && (
                <p className="research-note">資料門檻已達成，尚未執行鎖定測試；執行離線訓練後才會發布候選模型。</p>
            )}
            {status?.privateTrades?.state === 'not_configured' && (
                <p className="research-note">未設定 Bitfinex 帳戶憑證，成交配對尚未啟動。</p>
            )}
            {status?.privateTrades?.state === 'error' && (
                <p className="research-error" role="status">私有 Funding Trades 暫時無法讀取；請確認 API Key 有帳戶讀取權限。</p>
            )}

            <div className="research-table-wrap">
                <table className="research-table">
                    <thead>
                        <tr>
                            <th scope="col">候選模型</th>
                            <th scope="col">預測數</th>
                            <th scope="col">成熟標籤</th>
                            <th scope="col">MAE（年化）</th>
                            <th scope="col">P10–P90 涵蓋率</th>
                            <th scope="col">Pinball P10 / P50 / P90</th>
                        </tr>
                    </thead>
                    <tbody>
                        {MODEL_ROWS.map(([id, label]) => {
                            const row = modelStats.get(id);
                            const isReady = id === 'live_strategy' || id === 'persistence' || id === 'hour_mean' || Boolean(status?.collection?.modelArtifactLoaded);
                            return (
                                <tr key={id}>
                                    <th scope="row">
                                        <span>{label}</span>
                                        {!isReady && <small className="research-model-state">等待離線訓練</small>}
                                    </th>
                                    <td>{Number(row?.predictions || 0).toLocaleString('zh-TW')}</td>
                                    <td>{Number(row?.labeled || 0).toLocaleString('zh-TW')}</td>
                                    <td>{row?.mae == null ? '—' : formatRate(row.mae)}</td>
                                    <td>{id === 'quantile' ? formatMetric(row?.interval_coverage ?? sealedQuantile?.interval_coverage) : '—'}</td>
                                    <td>{id === 'quantile' ? `${formatLoss(sealedQuantile?.pinball_p10)} / ${formatLoss(sealedQuantile?.pinball_p50)} / ${formatLoss(sealedQuantile?.pinball_p90)}` : '—'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="research-footnote">現行策略基準沿用真實決策紀錄；其他模型各自使用獨立假想資金。誤差、涵蓋率與影子模擬都不代表真實收益。</p>
        </section>
    );
}
