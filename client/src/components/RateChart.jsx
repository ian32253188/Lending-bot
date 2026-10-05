import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Area, AreaChart, CartesianGrid, Line, ResponsiveContainer,
    Tooltip, XAxis, YAxis,
} from 'recharts';

const CHART_COLOR = '#53d5c3';
const TAIPEI_ZONE = 'Asia/Taipei';

async function readJsonResponse(response) {
    const contentType = response.headers?.get?.('content-type') || '';
    if (!response.text && response.json) return response.json();
    if (contentType.includes('json') && response.json) return response.json();
    const body = response.text ? await response.text() : '';
    if (!body.trim()) return {};
    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`利率歷史服務暫時無法使用（HTTP ${response.status || 'unknown'}）`);
    }
}

function dateInTaipei(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TAIPEI_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function dateLabel(date) {
    const [, month, day] = date.split('-');
    return `${Number(month)}/${Number(day)}`;
}

function annualized(rate) {
    return Number.isFinite(rate) ? rate * 365 * 100 : null;
}

function formatPercent(value) {
    return Number.isFinite(value) ? `${value.toFixed(4)}%` : '—';
}

function formatChange(value) {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(4)} 個百分點`;
}

function normalizeDailyRows(rows) {
    const byDate = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const date = dateInTaipei(row?.local_date || row?.recorded_at);
        const rawAverage = row?.avg_rate ?? row?.frr;
        if (rawAverage === null || rawAverage === undefined || rawAverage === '') continue;
        const avg = annualized(Number(rawAverage));
        if (!date || !Number.isFinite(avg)) continue;
        const low = annualized(Number(row?.low_rate ?? rawAverage));
        const high = annualized(Number(row?.high_rate ?? rawAverage));
        const rangeLow = Number.isFinite(low) ? low : avg;
        const rangeHigh = Number.isFinite(high) ? high : avg;
        byDate.set(date, {
            date,
            averageAnnualized: avg,
            lowAnnualized: Math.min(rangeLow, rangeHigh),
            highAnnualized: Math.max(rangeLow, rangeHigh),
            sampleCount: Number.isFinite(Number(row?.sample_count)) ? Number(row.sample_count) : 0,
        });
    }
    for (const point of byDate.values()) {
        point.rangeAnnualized = Math.max(0, point.highAnnualized - point.lowAnnualized);
    }
    const observed = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
    if (observed.length < 2) return observed.map(point => ({ ...point, timeLabel: dateLabel(point.date) }));

    const filled = [];
    const start = new Date(`${observed[0].date}T00:00:00Z`);
    const end = new Date(`${observed[observed.length - 1].date}T00:00:00Z`);
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const date = cursor.toISOString().slice(0, 10);
        filled.push({
            date,
            timeLabel: dateLabel(date),
            ...(byDate.get(date) || {
                averageAnnualized: null,
                lowAnnualized: null,
                highAnnualized: null,
                rangeAnnualized: null,
                sampleCount: 0,
            }),
        });
    }
    return filled;
}

function CustomTooltip({ active, payload }) {
    const point = payload?.[0]?.payload;
    if (!active || !point || !Number.isFinite(point.averageAnnualized)) return null;

    return (
        <div className="rate-chart-tooltip">
            <strong>{point.date}</strong>
            <span>每日均值 <b>{formatPercent(point.averageAnnualized)}</b></span>
            <span>日內範圍 <b>{formatPercent(point.lowAnnualized)} – {formatPercent(point.highAnnualized)}</b></span>
            <span>樣本數 <b>{point.sampleCount.toLocaleString('zh-TW')}</b></span>
        </div>
    );
}

export default function RateChart({ token }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [fetchedAt, setFetchedAt] = useState(null);

    const fetchData = useCallback(async () => {
        try {
            const response = await fetch('/api/dashboard/rate-history/USD', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const payload = await readJsonResponse(response);
            if (!response.ok) throw new Error(payload.error || '無法載入 USD 歷史資料');
            setRows(Array.isArray(payload) ? payload : []);
            setFetchedAt(new Date());
            setError('');
        } catch (err) {
            console.error('利率歷史載入失敗', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, [fetchData]);

    const chartData = useMemo(() => normalizeDailyRows(rows), [rows]);
    const observedData = useMemo(() => chartData.filter(point => Number.isFinite(point.averageAnnualized)), [chartData]);
    const firstPoint = observedData[0];
    const latestPoint = observedData[observedData.length - 1];
    const change = firstPoint && latestPoint
        ? latestPoint.averageAnnualized - firstPoint.averageAnnualized
        : null;
    const chartDomain = useMemo(() => {
        const values = observedData.flatMap(point => [point.lowAnnualized, point.highAnnualized]);
        if (!values.length) return ['auto', 'auto'];
        const min = Math.min(...values);
        const max = Math.max(...values);
        const padding = Math.max((max - min) * 0.16, Math.abs(max) * 0.015, 0.005);
        return [min - padding, max + padding];
    }, [observedData]);
    const today = dateInTaipei(new Date());
    const latestIsPartial = latestPoint?.date === today;
    const fetchedLabel = fetchedAt
        ? fetchedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TAIPEI_ZONE })
        : '';

    return (
        <section className="panel rate-chart-panel" aria-labelledby="rate-chart-title">
            <div className="rate-chart-heading">
                <div>
                    <h3 id="rate-chart-title">USD FRR 利率走勢</h3>
                    <p className="rate-chart-subtitle">每日均值與日內高低範圍 · 年化</p>
                </div>
                <span className="rate-chart-period">近 30 天</span>
            </div>

            {error && (
                <div className="market-error" role="alert">
                    <strong>歷史資料同步失敗</strong>
                    <span>{error}</span>
                    <button type="button" className="btn btn-sm btn-outline" onClick={fetchData}>重新同步</button>
                </div>
            )}

            {loading && chartData.length === 0 ? (
                <div className="loading-shimmer rate-chart-loading" aria-label="正在載入利率歷史" />
            ) : chartData.length === 0 ? (
                <div className="market-empty rate-chart-empty">
                    尚無利率歷史資料；機器人開始收集後會顯示於此。
                </div>
            ) : (
                <>
                    <div className="rate-chart-summary" aria-label="利率摘要">
                        <div>
                            <span>最新年化利率</span>
                            <strong>{formatPercent(latestPoint?.averageAnnualized)}</strong>
                            {latestPoint && <small>{latestPoint.date}{latestIsPartial ? ' · 今日未完' : ''}</small>}
                        </div>
                        <div>
                            <span>30 日變動</span>
                            <strong>{formatChange(change)}</strong>
                            <small>相較區間首筆資料</small>
                        </div>
                    </div>

                    <p className="rate-chart-scale-note">縱軸採局部刻度，以呈現日間變化；高低帶為日內 FRR 範圍。</p>
                    <div className="rate-chart-plot" role="group" aria-label="USD FRR 最近 30 天每日均值與日內範圍圖表">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart
                                accessibilityLayer
                                data={chartData}
                                margin={{ top: 8, right: 8, bottom: 2, left: 0 }}
                            >
                                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
                                <XAxis
                                    dataKey="timeLabel"
                                    tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                                    tickLine={false}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    interval="preserveStartEnd"
                                    minTickGap={24}
                                />
                                <YAxis
                                    domain={chartDomain}
                                    tickFormatter={value => `${Number(value).toFixed(2)}%`}
                                    tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                                    tickLine={false}
                                    axisLine={false}
                                    width={66}
                                    tickCount={5}
                                    allowDataOverflow
                                />
                                <Tooltip content={<CustomTooltip />} />
                                <Area
                                    type="linear"
                                    dataKey="lowAnnualized"
                                    stackId="intraday-range"
                                    stroke="none"
                                    fill="transparent"
                                    connectNulls={false}
                                    isAnimationActive={false}
                                    tooltipType="none"
                                />
                                <Area
                                    type="linear"
                                    dataKey="rangeAnnualized"
                                    stackId="intraday-range"
                                    stroke="none"
                                    fill={CHART_COLOR}
                                    fillOpacity={0.18}
                                    connectNulls={false}
                                    isAnimationActive={false}
                                />
                                <Line
                                    type="linear"
                                    dataKey="averageAnnualized"
                                    name="每日均值"
                                    stroke={CHART_COLOR}
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4, fill: CHART_COLOR, stroke: 'var(--bg-card)', strokeWidth: 2 }}
                                    connectNulls={false}
                                    isAnimationActive={false}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="rate-chart-footer">
                        <span><i aria-hidden="true" />每日均值　<i className="rate-chart-band-key" aria-hidden="true" />日內高低</span>
                        {fetchedLabel && <span>更新於 {fetchedLabel}（台北）</span>}
                    </div>

                    <details className="rate-chart-data">
                        <summary>查看每日數據</summary>
                        <div className="rate-chart-table-wrap">
                            <table>
                                <caption className="visually-hidden">USD FRR 最近 30 天每日年化均值、日內高低與樣本數</caption>
                                <thead>
                                    <tr><th scope="col">日期</th><th scope="col">每日均值</th><th scope="col">日內範圍</th><th scope="col">樣本數</th></tr>
                                </thead>
                                <tbody>
                                    {chartData.slice().reverse().map(point => (
                                        <tr key={point.date}>
                                            <th scope="row">{point.date}</th>
                                            <td>{formatPercent(point.averageAnnualized)}</td>
                                            <td>{Number.isFinite(point.lowAnnualized) && Number.isFinite(point.highAnnualized)
                                                ? `${formatPercent(point.lowAnnualized)} – ${formatPercent(point.highAnnualized)}`
                                                : '無資料'}</td>
                                            <td>{point.sampleCount ? point.sampleCount.toLocaleString('zh-TW') : '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </details>
                </>
            )}
        </section>
    );
}
