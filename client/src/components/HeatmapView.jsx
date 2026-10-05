import { useState, useEffect } from 'react';

function getIntensityColor(amount, max) {
    if (!amount || !max) return 'var(--surface-2)';
    const ratio = Math.min(1, amount / max);
    if (ratio < 0.2) return '#1a3f2b';
    if (ratio < 0.4) return '#1f6435';
    if (ratio < 0.6) return '#26a04a';
    if (ratio < 0.8) return '#2dc95a';
    return '#26d0a3';
}

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const DAYS = ['日', '一', '二', '三', '四', '五', '六'];

export default function HeatmapView({ token }) {
    const [heatmap, setHeatmap] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tooltip, setTooltip] = useState(null);

    useEffect(() => {
        async function fetchHeatmap() {
            try {
                const res = await fetch('/api/dashboard/earnings/heatmap?days=365', {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || `收益日曆讀取失敗（HTTP ${res.status}）`);
                if (!Array.isArray(data)) throw new Error('收益日曆服務回傳格式異常。');
                setHeatmap(data);
                setError('');
            } catch (err) {
                console.error('熱力圖載入失敗', err);
                setError(err.message || '收益日曆暫時無法讀取。');
            } finally {
                setLoading(false);
            }
        }
        fetchHeatmap();
    }, [token]);

    if (loading) return <div className="panel loading-shimmer" style={{ height: 180 }} />;
    if (error) return <div className="panel market-error" role="alert"><strong>收益日曆暫不可用</strong><span>{error}；不代表沒有收益紀錄。</span></div>;

    // 建立日期對應 map
    const amountByDate = {};
    let maxAmount = 0;
    for (const { date, amount } of heatmap) {
        amountByDate[date] = amount;
        if (amount > maxAmount) maxAmount = amount;
    }

    // 產生過去 52 週的日曆格
    const today = new Date();
    const weeks = [];
    const startDay = new Date(today);
    startDay.setDate(today.getDate() - 364);
    // 對齊到當週日
    startDay.setDate(startDay.getDate() - startDay.getDay());

    let current = new Date(startDay);
    while (current <= today) {
        const week = [];
        for (let d = 0; d < 7; d++) {
            const dateStr = current.toISOString().slice(0, 10);
            week.push({
                date: dateStr,
                amount: amountByDate[dateStr] || 0,
                isFuture: current > today,
            });
            current.setDate(current.getDate() + 1);
        }
        weeks.push(week);
    }

    const totalEarned = heatmap.reduce((s, r) => s + r.amount, 0);
    const activeDays = heatmap.filter(r => r.amount > 0).length;

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>收益日曆</h3>
                <div style={{ display: 'flex', gap: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    <span>累計 <strong style={{ color: 'var(--success)' }}>${totalEarned.toFixed(4)}</strong></span>
                    <span>活躍 <strong>{activeDays}</strong> 天</span>
                </div>
            </div>

            <div className="heatmap-container" style={{ overflowX: 'auto', paddingBottom: 8 }}>
                {/* 月份標籤 */}
                <div style={{ display: 'flex', paddingLeft: 28, marginBottom: 4 }}>
                    {weeks.map((week, wi) => {
                        const firstOfMonth = week.find(d => d.date.endsWith('-01'));
                        if (firstOfMonth) {
                            const month = parseInt(firstOfMonth.date.slice(5, 7)) - 1;
                            return <div key={wi} style={{ width: 14, fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>{MONTHS[month]}</div>;
                        }
                        return <div key={wi} style={{ width: 14, flexShrink: 0 }} />;
                    })}
                </div>

                <div style={{ display: 'flex', gap: 2 }}>
                    {/* 星期標籤 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 4 }}>
                        {[0, 1, 2, 3, 4, 5, 6].map(d => (
                            <div key={d} style={{ height: 12, width: 22, fontSize: 9, color: 'var(--text-secondary)', lineHeight: '12px', textAlign: 'right' }}>
                                {d % 2 === 1 ? DAYS[d] : ''}
                            </div>
                        ))}
                    </div>

                    {/* 熱力格 */}
                    {weeks.map((week, wi) => (
                        <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {week.map(({ date, amount, isFuture }) => (
                                <div
                                    key={date}
                                    style={{
                                        width: 12,
                                        height: 12,
                                        borderRadius: 2,
                                        background: isFuture ? 'transparent' : getIntensityColor(amount, maxAmount),
                                        cursor: amount > 0 ? 'pointer' : 'default',
                                        position: 'relative',
                                        border: '1px solid rgba(255,255,255,0.04)',
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isFuture) {
                                            setTooltip({ date, amount, x: e.clientX, y: e.clientY });
                                        }
                                    }}
                                    onMouseLeave={() => setTooltip(null)}
                                />
                            ))}
                        </div>
                    ))}
                </div>

                {/* 圖例 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 10, justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>少</span>
                    {[0, 0.2, 0.4, 0.6, 0.8, 1].map(r => (
                        <div key={r} style={{
                            width: 12, height: 12, borderRadius: 2,
                            background: r === 0 ? 'var(--surface-2)' : getIntensityColor(r * maxAmount, maxAmount),
                        }} />
                    ))}
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>多</span>
                </div>
            </div>

            {/* Tooltip */}
            {tooltip && (
                <div style={{
                    position: 'fixed', left: tooltip.x + 10, top: tooltip.y - 40,
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '6px 10px', fontSize: '0.78rem',
                    pointerEvents: 'none', zIndex: 9999,
                }}>
                    {tooltip.date}：${tooltip.amount.toFixed(6)}
                </div>
            )}
        </div>
    );
}
