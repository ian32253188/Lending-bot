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
        avg: ((row.minApy || 0) + (row.maxApy || 0)) / 2,
        high: row.maxApy || 0,
        low: row.minApy || 0,
    }));
}

function MarketChart({ points }) {
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

    return (
        <div className="market-chart-wrap">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="fUSD 30 日利率走勢">
                <polygon points={band} fill="rgba(148, 163, 184, 0.2)" />
                <polyline points={line('avg')} fill="none" stroke="#18a999" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="market-chart-axis"><span>{points[0].label}</span><span>{points[Math.floor(points.length / 2)].label}</span><span>{points[points.length - 1].label}</span></div>
        </div>
    );
}

export default function FundingMarketDashboard({ token }) {
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

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
                    {(summary?.hourlyMatches || []).map(row => (
                        <div className="market-table-row" key={row.timestamp}>
                            <span>{new Date(row.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
                            <strong>{fmt(row.minApy)} - {fmt(row.maxApy)}</strong>
                            <span>{fmtAmount(row.amount)}</span>
                        </div>
                    ))}
                    {!summary?.hourlyMatches?.length && <div className="market-empty">目前沒有最近 24 小時成交紀錄</div>}
                </div>
            </div>
            {error && <div className="market-error">{error}</div>}
        </div>
    );
}
