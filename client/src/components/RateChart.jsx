import { useState, useEffect, useCallback } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';

const CURRENCIES = ['USD'];
const COLORS = { USD: '#53d5c3' };

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

function formatTime(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', timeZone: 'Asia/Taipei' });
}

const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div style={{
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem',
        }}>
            <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
            {payload.map(p => (
                <div key={p.dataKey} style={{ color: p.color }}>
                    {p.name}: {(p.value * 100).toFixed(4)}%/天
                    <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
                        (年化 {(p.value * 365 * 100).toFixed(2)}%)
                    </span>
                </div>
            ))}
        </div>
    );
};

export default function RateChart({ token }) {
    const [data, setData] = useState({ USD: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const results = await Promise.all(
                CURRENCIES.map(cur =>
                    fetch(`/api/dashboard/rate-history/${cur}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    }).then(async response => {
                        const payload = await readJsonResponse(response);
                        if (!response.ok) throw new Error(payload.error || `無法載入 ${cur} 歷史資料`);
                        return payload;
                    })
                )
            );
            const newData = {};
            CURRENCIES.forEach((cur, i) => { newData[cur] = results[i] || []; });
            setData(newData);
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

    // 整理 USD 歷史資料供 Recharts 使用
    const chartData = (() => {
        const merged = {};
        for (const cur of CURRENCIES) {
            for (const row of data[cur]) {
                const key = row.recorded_at;
                if (!merged[key]) merged[key] = { time: key };
                merged[key][cur] = row.frr;
            }
        }
        return Object.values(merged)
            .sort((a, b) => a.time.localeCompare(b.time))
            .map(d => ({ ...d, timeLabel: formatTime(d.time) }));
    })();

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>USD FRR 利率走勢</h3>
                <span className="market-note">近 30 天</span>
            </div>

            {error && <div className="market-error" role="alert"><strong>歷史資料同步失敗</strong><span>{error}</span><button type="button" className="btn btn-sm btn-outline" onClick={fetchData}>重新同步</button></div>}
            {loading ? (
                <div className="loading-shimmer" style={{ height: 240, borderRadius: 8 }} />
            ) : chartData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-secondary)' }}>
                    尚無利率歷史數據（機器人運行後會自動收集）
                </div>
            ) : (
                <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis
                            dataKey="timeLabel"
                            tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            tickFormatter={v => `${(v * 100).toFixed(3)}%`}
                            tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                            width={65}
                        />
                        <Tooltip content={<CustomTooltip />} />
                        {CURRENCIES.map(cur => (
                            <Line
                                key={cur}
                                type="monotone"
                                dataKey={cur}
                                name={cur}
                                stroke={COLORS[cur]}
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 5 }}
                                connectNulls
                            />
                        ))}
                    </LineChart>
                </ResponsiveContainer>
            )}
        </div>
    );
}
