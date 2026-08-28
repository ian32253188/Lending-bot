import { useEffect, useState } from 'react';

const PERIODS = [
    { label: '今日', key: 'today' },
    { label: '本週', key: 'week' },
    { label: '本月', key: 'month' },
    { label: '今年', key: 'year' },
    { label: '累計', key: 'allTime' },
];

export default function EarningsPanel({ token, embedded = false }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchStats();
        const interval = setInterval(fetchStats, 60000);
        return () => clearInterval(interval);
    }, []);

    async function fetchStats() {
        try {
            const res = await fetch('/api/dashboard/earnings/stats', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            setStats(data);
        } catch (err) {
            console.error('收益統計載入失敗', err);
        } finally {
            setLoading(false);
        }
    }

    async function resetEarnings() {
        if (!window.confirm('確定要清空所有的歷史收益紀錄嗎？此動作無法復原。')) return;

        setLoading(true);
        try {
            const res = await fetch('/api/dashboard/earnings/reset', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({}) // 沒傳幣種代表全刪
            });
            if (res.ok) {
                await fetchStats();
                window.location.reload(); // 重新載入以刷新熱力圖等其他元件
            } else {
                alert('清除失敗，請稍後再試');
            }
        } catch (err) {
            console.error('清除紀錄失敗', err);
            alert('清除失敗，請稍後再試');
        } finally {
            setLoading(false);
        }
    }

    if (loading) return <div className={`${embedded ? 'earnings-panel-content' : 'panel'} loading-shimmer`} style={{ height: 180 }} />;
    if (!stats) return null;

    const accumulated = stats.allTime || { total: 0, byCurrency: {} };
    const formatEarnings = value => `$${Number(value || 0).toFixed(4)}`;

    return (
        <div className={embedded ? 'earnings-panel-content' : 'panel'}>
            <div className="panel-header">
                <h3>💰 收益統計</h3>
                <button
                    className="btn btn-sm btn-outline"
                    onClick={resetEarnings}
                    title="清空所有歷史收益紀錄"
                >
                    🔄 重置紀錄
                </button>
            </div>

            <div className="earnings-periods" aria-label="各期間收益">
                {PERIODS.map(period => (
                    <div key={period.key} className={`earnings-period-card ${period.key === 'allTime' ? 'featured' : ''}`}>
                        <span>{period.label}收益</span>
                        <strong>{formatEarnings(stats[period.key]?.total)}</strong>
                    </div>
                ))}
            </div>

            <div className="earnings-grid">
                <div className="earnings-main">
                    <div className="earnings-label">累積收益明細</div>
                    <div className="earnings-breakdown">
                        {Object.entries(accumulated.byCurrency || {}).map(([cur, amount]) => (
                            <div key={cur} className="earnings-currency">
                                <span className="badge">{cur}</span>
                                <span>{formatEarnings(amount)}</span>
                            </div>
                        ))}
                        {Object.keys(accumulated.byCurrency || {}).length === 0 && (
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                                目前暫無收益紀錄
                            </div>
                        )}
                    </div>
                </div>

                {/* 資金利用率 */}
                <div className="utilization-panel">
                    <div className="panel-label">資金利用率</div>
                    {Object.entries(stats.utilization || {}).map(([cur, rate]) => (
                        <div key={cur} className="utilization-item">
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                <span>{cur}</span>
                                <span>{(rate * 100).toFixed(1)}%</span>
                            </div>
                            <div className="progress-bar">
                                <div
                                    className="progress-fill"
                                    style={{
                                        width: `${Math.min(100, rate * 100)}%`,
                                        background: rate > 0.8 ? 'var(--success)' : rate > 0.5 ? 'var(--warning)' : 'var(--accent)',
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
