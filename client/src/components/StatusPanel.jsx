export default function StatusPanel({ status }) {
    if (!status) return <div className="card">載入中...</div>;

    const { wallets, activeOffers, activeCredits, marketData } = status;
    const privateDataAvailable = status.accountDataAvailable ?? (status.running || status.authenticated);
    const privateValue = value => privateDataAvailable && value != null ? value : '—';

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
                            {privateDataAvailable && w.balance != null ? w.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                        </div>
                        <div className="stat-label">
                            可用: {privateDataAvailable && w.available != null ? w.available.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '尚未連接 Bitfinex 私有 API'}
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
            <div className="grid grid-2 status-summary-grid" style={{ marginTop: 20 }}>
                <div className="card">
                    <div className="card-header">
                        <span className="card-title">📋 活躍掛單</span>
                    </div>
                    {Object.entries(activeOffers || {}).map(([cur, count]) => (
                        <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{cur}</span>
                            <span className="stat-value" style={{ fontSize: 20 }}>{privateValue(count)}</span>
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
                            <span className="stat-value cyan" style={{ fontSize: 20 }}>{privateValue(count)}</span>
                        </div>
                    ))}
                </div>

            </div>
            {!privateDataAvailable && (
                <div className="status-data-note">錢包、活躍掛單與放貸中屬於 Bitfinex 私有資料；目前策略尚未啟動，因此先顯示「—」。啟動策略後會建立私有連線並同步。</div>
            )}
        </>
    );
}
