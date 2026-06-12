import { useState, useEffect, useCallback } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';

const RANGES = [
    { label: '1天', hours: 24 },
    { label: '3天', hours: 72 },
    { label: '7天', hours: 168 },
    { label: '30天', hours: 720 },
];

const CURRENCIES = ['USD', 'USDT'];
const COLORS = { USD: '#7c6af5', USDT: '#26d0a3' };

function formatTime(dateStr, hours) {
    const d = new Date(dateStr);
    if (hours <= 24) return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit' });
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
    const [range, setRange] = useState(RANGES[1]);
    const [data, setData] = useState({ USD: [], USDT: [] });
    const [loading, setLoading] = useState(true);
    const [selectedCurrencies, setSelectedCurrencies] = useState(new Set(CURRENCIES));

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const results = await Promise.all(
                CURRENCIES.map(cur =>
                    fetch(`/api/dashboard/rate-history/${cur}?hours=${range.hours}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    }).then(r => r.json())
                )
            );
            const newData = {};
            CURRENCIES.forEach((cur, i) => { newData[cur] = results[i] || []; });
            setData(newData);
        } catch (err) {
            console.error('利率歷史載入失敗', err);
        } finally {
            setLoading(false);
        }
    }, [range, token]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, [fetchData]);

    // 合併兩幣種資料為單一陣列供 Recharts 使用
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
            .map(d => ({ ...d, timeLabel: formatTime(d.time, range.hours) }));
    })();

    const toggleCurrency = (cur) => {
        const s = new Set(selectedCurrencies);
        if (s.has(cur)) { if (s.size > 1) s.delete(cur); }
        else s.add(cur);
        setSelectedCurrencies(s);
    };

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>📈 FRR 利率走勢</h3>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {CURRENCIES.map(cur => (
                        <button
                            key={cur}
                            className={`btn btn-sm ${selectedCurrencies.has(cur) ? '' : 'btn-ghost'}`}
                            style={selectedCurrencies.has(cur) ? { background: COLORS[cur] + '33', color: COLORS[cur], border: `1px solid ${COLORS[cur]}` } : {}}
                            onClick={() => toggleCurrency(cur)}
                        >
                            {cur}
                        </button>
                    ))}
                    <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
                    {RANGES.map(r => (
                        <button
                            key={r.label}
                            className={`btn btn-sm ${range.label === r.label ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setRange(r)}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>
            </div>

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
                        {CURRENCIES.filter(c => selectedCurrencies.has(c)).map(cur => (
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
