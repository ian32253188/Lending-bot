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
    const [error, setError] = useState('');

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
            if (!res.ok) throw new Error(data.error || `收益統計讀取失敗（HTTP ${res.status}）`);
            setStats(data);
            setError('');
        } catch (err) {
            console.error('收益統計載入失敗', err);
            setError(err.message || '收益統計暫不可用。');
        } finally {
            setLoading(false);
        }
    }

    async function resetEarnings() {
        if (!window.confirm('確定要清空 USD 歷史收益紀錄嗎？此動作無法復原。')) return;

        setLoading(true);
        try {
            const res = await fetch('/api/dashboard/earnings/reset', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ currency: 'USD' })
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
    if (!stats) return <div className={embedded ? 'earnings-panel-content' : 'panel'} role="alert" style={{ color: 'var(--danger)' }}>
        收益統計暫不可用：{error || '尚未取得資料'} <button type="button" className="btn btn-sm btn-outline" onClick={fetchStats}>重新載入</button>
    </div>;

    const usdUtilization = Object.entries(stats.utilization || {}).find(([cur]) => cur === 'USD');
    const formatEarnings = value => `$${Number(value || 0).toFixed(4)}`;

    return (
        <div className={embedded ? 'earnings-panel-content' : 'panel'}>
            {error && <div className="market-error" role="alert"><strong>收益統計暫時無法更新</strong><span>{error}；畫面保留上次成功資料。</span></div>}
            <div className="panel-header">
                <h3>收益統計</h3>
                <button
                    className="btn btn-sm btn-outline"
                    onClick={resetEarnings}
                    title="清空所有歷史收益紀錄"
                >
                    重置 USD 紀錄
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

            <div className="earnings-support">
                <div className="utilization-panel">
                    <div className="utilization-summary">
                        <span className="panel-label">資金利用率 <span className="utilization-currency">USD</span></span>
                        {usdUtilization && (
                            <strong>{(usdUtilization[1] * 100).toFixed(1)}%</strong>
                        )}
                    </div>
                    {usdUtilization && (
                        <div
                            className="progress-bar"
                            role="meter"
                            aria-label="USD 資金利用率"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            aria-valuenow={Math.min(100, Math.max(0, usdUtilization[1] * 100))}
                        >
                            <div
                                className="progress-fill"
                                style={{
                                    width: `${Math.min(100, Math.max(0, usdUtilization[1] * 100))}%`,
                                    background: usdUtilization[1] > 0.8 ? 'var(--success)' : usdUtilization[1] > 0.5 ? 'var(--warning)' : 'var(--accent)',
                                }}
                            />
                        </div>
                    )}
                    {!stats.utilizationDataAvailable && (
                        <div role="status" className="utilization-error">
                            {stats.utilizationError || '個人帳戶資料不可用；利用率不顯示為 0。'}
                        </div>
                    )}
                </div>
                <div className="earnings-source-notes">
                    {stats.utilizationDataAvailable && <span>利用率來源：{stats.utilizationDataSource}</span>}
                    {stats.dataSource && <span>收益來源：{stats.dataSource}</span>}
                </div>
            </div>
        </div>
    );
}
