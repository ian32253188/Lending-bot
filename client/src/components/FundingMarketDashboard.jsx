import { useEffect, useMemo, useState } from 'react';

const fmt = (value, digits = 2) => value == null ? '—' : `${Number(value).toFixed(digits)}%`;
const fmtAmount = value => value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });

function toPoints(summary) {
    const history = (summary?.history || []).filter(row => row.avgRate != null);
    if (history.length > 1) {
        return history.map(row => ({
            label: new Date(row.timestamp).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }),
            avg: row.avgRate * 365 * 100,
            high: (row.highRate ?? row.avgRate) * 365 * 100,
            low: (row.lowRate ?? row.avgRate) * 365 * 100,
        }));
    }
    return (summary?.hourlyMatches || []).slice().reverse().map(row => ({
        label: new Date(row.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
        avg: row.count ? ((row.minApy + row.maxApy) / 2) : null,
        high: row.maxApy,
        low: row.minApy,
    })).filter(point => point.avg != null);
}

function MarketChart({ points }) {
    const [hoveredIndex, setHoveredIndex] = useState(null);
    if (!points.length) return <div className="market-empty">等待公開市場歷史資料…</div>;

    const width = 720;
    const height = 190;
    const values = points.flatMap(point => [point.high, point.low, point.avg]).filter(Number.isFinite);
    const min = Math.max(0, Math.min(...values) * 0.9);
    const max = Math.max(...values) * 1.1 || 1;
    const x = index => points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = value => height - ((value - min) / (max - min || 1)) * height;
    const line = key => points.map((point, index) => `${x(index)},${y(point[key])}`).join(' ');
    const band = `${points.map((point, index) => `${x(index)},${y(point.high)}`).join(' ')} ${points.slice().reverse().map((point, reverseIndex) => {
        const index = points.length - 1 - reverseIndex;
        return `${x(index)},${y(point.low)}`;
    }).join(' ')}`;
    const hovered = hoveredIndex == null ? null : points[hoveredIndex];
    const handleMouseMove = event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
        setHoveredIndex(Math.round(ratio * (points.length - 1)));
    };

    return (
        <div className="market-chart-wrap">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="fUSD 30 日利率走勢" onMouseMove={handleMouseMove} onMouseLeave={() => setHoveredIndex(null)}>
                <polygon points={band} fill="rgba(148, 163, 184, 0.2)" />
                <polyline points={line('avg')} fill="none" stroke="#18a999" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                {hovered && (
                    <>
                        <line x1={x(hoveredIndex)} x2={x(hoveredIndex)} y1="0" y2={height} stroke="#cbd5e1" strokeDasharray="4 4" />
                        <circle cx={x(hoveredIndex)} cy={y(hovered.avg)} r="5" fill="#18a999" stroke="#fff" strokeWidth="2" />
                    </>
                )}
            </svg>
            {hovered && (
                <div className="market-tooltip" style={{ left: `${(x(hoveredIndex) / width) * 100}%` }}>
                    <strong>{hovered.label}</strong>
                    <span><b>最高</b> {fmt(hovered.high)}</span>
                    <span><b>平均</b> {fmt(hovered.avg)}</span>
                    <span><b>最低</b> {fmt(hovered.low)}</span>
                </div>
            )}
            <div className="market-chart-axis"><span>{points[0].label}</span><span>{points[Math.floor(points.length / 2)].label}</span><span>{points[points.length - 1].label}</span></div>
        </div>
    );
}

export default function FundingMarketDashboard({ token }) {
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selectedHour, setSelectedHour] = useState(null);

    const load = async () => {
        try {
            const response = await fetch('/api/dashboard/funding-market', { headers: { Authorization: `Bearer ${token}` } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '市場資料讀取失敗');
            setSummary(data);
            setError('');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        const timer = setInterval(load, 60 * 1000);
        return () => clearInterval(timer);
    }, [token]);

    const points = useMemo(() => toPoints(summary), [summary]);
    const hourlyMatches = summary?.hourlyMatches24 || summary?.hourlyMatches || [];
    if (loading && !summary) return <div className="card market-dashboard">載入 fUSD 市場資料中…</div>;

    return (
        <div className="card market-dashboard">
            <div className="market-header">
                <div>
                    <div className="market-title">🏦 USD 融資市場 <span className="market-live">● Live</span></div>
                    <div className="market-subtitle">24H 成交額 {summary?.volume24h == null ? '—' : `${fmtAmount(summary.volume24h)} USD`}</div>
                </div>
                <div className="market-top-rate">{fmt(summary?.high24hApy)}<small>近 24 小時最高借出利率</small></div>
            </div>
            <div className="market-metrics">
                <div><strong>{fmt(summary?.currentApy)}</strong><span>目前成交均值</span></div>
                <div><strong>{fmt(summary?.average30dApy)}</strong><span>30 天平均</span></div>
                <div><strong>{fmt(summary?.high30dApy)}</strong><span>30 天最高</span></div>
                <div><strong>{fmt(summary?.low30dApy)}</strong><span>30 天最低</span></div>
            </div>
            <div className="market-body">
                <div className="market-chart-column">
                    <h3>⌁ 近 30 日利率走勢</h3>
                    <MarketChart points={points} />
                    <div className="market-note">灰色區間代表每日最低至最高成交利率，綠線為平均利率。</div>
                </div>
                <div className="market-matches">
                    <h3>◷ 過去每小時撮合</h3>
                    <div className="market-table-head"><span>時間</span><span>成交利率</span><span>借量</span></div>
                    <div className="market-table-scroll">
                        {hourlyMatches.map(row => (
                            <button className="market-table-row" key={row.timestamp} type="button" onClick={() => setSelectedHour(row)}>
                                <span>{new Date(row.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
                                <strong>{row.count ? `${fmt(row.minApy)} - ${fmt(row.maxApy)}` : '—'}</strong>
                                <span>{fmtAmount(row.amount)}</span>
                            </button>
                        ))}
                    </div>
                    {!hourlyMatches.length && <div className="market-empty">目前沒有最近 24 小時成交紀錄</div>}
                </div>
            </div>
            {error && <div className="market-error">{error}</div>}
            {selectedHour && (
                <div className="market-detail-backdrop" role="presentation" onClick={() => setSelectedHour(null)}>
                    <div className="market-detail-modal" role="dialog" aria-modal="true" aria-labelledby="market-detail-title" onClick={event => event.stopPropagation()}>
                        <div className="market-detail-header">
                            <h3 id="market-detail-title">{new Date(selectedHour.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 撮合明細（USD）</h3>
                            <button type="button" className="market-detail-close" onClick={() => setSelectedHour(null)} aria-label="關閉">×</button>
                        </div>
                        <div className="market-detail-table market-detail-table-head"><span>時間</span><span>金額</span><span>天數</span><span>成交利率</span></div>
                        {selectedHour.details?.length ? selectedHour.details.map((detail, index) => (
                            <div className="market-detail-table market-detail-row" key={`${detail.id}-${detail.timestamp}-${index}`}>
                                <span>{new Date(detail.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
                                <strong>{fmtAmount(detail.amount)}</strong>
                                <span>{detail.period}d</span>
                                <strong>{fmt(detail.apy)}</strong>
                            </div>
                        )) : <div className="market-empty market-detail-empty">這個時段目前沒有撮合成交。</div>}
                    </div>
                </div>
            )}
        </div>
    );
}
