export default function StatusPanel({ status }) {
    if (!status) return <div className="card">載入中...</div>;

    const { wallets, activeOffers, activeCredits, marketData, stats, strategy } = status;

    return (
        <>
            {/* 統計卡片 */}
            <div className="grid grid-4">
                {/* 錢包餘額 */}
                {Object.entries(wallets || {}).map(([cur, w]) => (
                    <div className="card" key={cur}>
                        <div className="card-header">
                            <span className="card-title">💰 {cur} Funding</span>
                        </div>
                        <div className="stat-value green">
                            {(w.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div className="stat-label">
                            可用: {(w.available || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                    </div>
                ))}

                {/* FRR 利率 */}
                {Object.entries(marketData || {}).map(([cur, md]) => (
                    md && md.frr ? (
                        <div className="card" key={`frr-${cur}`}>
                            <div className="card-header">
                                <span className="card-title">📈 {cur} FRR</span>
                            </div>
                            <div className="stat-value blue">
                                {(md.frr * 100).toFixed(4)}%
                            </div>
                            <div className="stat-label">
                                年化: {(md.frr * 365 * 100).toFixed(2)}%
                            </div>
                        </div>
                    ) : null
                ))}
            </div>

            {/* 放貸概覽 */}
            <div className="grid grid-3" style={{ marginTop: 20 }}>
                <div className="card">
                    <div className="card-header">
                        <span className="card-title">📋 活躍掛單</span>
                    </div>
                    {Object.entries(activeOffers || {}).map(([cur, count]) => (
                        <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{cur}</span>
                            <span className="stat-value" style={{ fontSize: 20 }}>{count}</span>
                        </div>
                    ))}
                </div>

                <div className="card">
                    <div className="card-header">
                        <span className="card-title">🔗 放貸中</span>
                    </div>
                    {Object.entries(activeCredits || {}).map(([cur, count]) => (
                        <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{cur}</span>
                            <span className="stat-value cyan" style={{ fontSize: 20 }}>{count}</span>
                        </div>
                    ))}
                </div>

                <div className="card">
                    <div className="card-header">
                        <span className="card-title">📊 統計</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>掛單數</span>
                        <span>{stats?.offersPlaced || 0}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>取消數</span>
                        <span>{stats?.offersCancelled || 0}</span>
                    </div>
                    {Object.entries(stats?.totalEarned || {}).map(([cur, earned]) => (
                        <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{cur} 收益</span>
                            <span className="stat-value green" style={{ fontSize: 16 }}>
                                {(earned || 0).toFixed(4)}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}
