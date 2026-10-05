export default function StatusPanel({ status }) {
    if (!status) return <div className="card">載入中...</div>;

    const { wallets, activeOffers, activeCredits } = status;
    const usdWallet = wallets?.USD;
    const usdOffers = activeOffers?.USD;
    const usdCredits = activeCredits?.USD;
    const privateDataAvailable = status.accountDataAvailable ?? (status.running || status.authenticated);
    const privateValue = value => privateDataAvailable && value != null ? value : '—';

    return (
        <div className="status-panel-content">
            {/* 統計卡片 */}
            <div className="grid grid-4">
                {/* 錢包餘額 */}
                {usdWallet && ([['USD', usdWallet]]).map(([cur, w]) => (
                    <div className="card" key={cur}>
                        <div className="card-header">
                            <span className="card-title">{cur} Funding 錢包</span>
                        </div>
                        <div className="stat-value green">
                            {privateDataAvailable && w.balance != null ? Number(w.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                        </div>
                        <div className="stat-label">
                            可用: {privateDataAvailable
                                ? w.available != null
                                    ? Number(w.available).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                    : '—'
                                : '尚未連接 Bitfinex 私有 API'}
                        </div>
                    </div>
                ))}

            </div>

            {/* 放貸概覽 */}
            <div className="grid grid-2 status-summary-grid" style={{ marginTop: 20 }}>
                <div className="card">
                    <div className="card-header">
                        <span className="card-title">活躍掛單</span>
                    </div>
                    {([['USD', usdOffers]]).map(([cur, count]) => (
                        <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{cur}</span>
                            <span className="stat-value" style={{ fontSize: 20 }}>{privateValue(count)}</span>
                        </div>
                    ))}
                </div>

                <div className="card">
                    <div className="card-header">
                        <span className="card-title">放貸中</span>
                    </div>
                    {([['USD', usdCredits]]).map(([cur, count]) => (
                        <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{cur}</span>
                            <span className="stat-value cyan" style={{ fontSize: 20 }}>{privateValue(count)}</span>
                        </div>
                    ))}
                </div>

            </div>
            {privateDataAvailable ? (
                <div className="status-data-note">
                    {status.accountDataStale
                        ? 'Bitfinex 暫時無法更新；以下保留上次成功讀取的資料。'
                        : status.accountDataError
                            ? 'Bitfinex 私有帳戶資料同步不完整；未讀到的欄位以「—」顯示。'
                            : status.running
                                ? 'Bitfinex 私有帳戶資料已連線。'
                                : '放貸引擎目前停止；以上數據由 Bitfinex 私有 API 唯讀同步，不會啟動策略或送出交易。'}
                    {status.accountDataError ? ` ${status.accountDataError}` : ''}
                    {status.accountDataUpdatedAt && ` 更新時間：${new Date(status.accountDataUpdatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`}
                </div>
            ) : (
                <div className="status-data-note">
                    {status.accountDataError
                        ? `Bitfinex 私有帳戶資料無法讀取：${status.accountDataError}`
                        : 'Bitfinex 私有帳戶資料尚未連線；公開市場資料不包含你的個人放貸部位。'}
                </div>
            )}
        </div>
    );
}
