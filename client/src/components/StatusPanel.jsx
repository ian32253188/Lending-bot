export default function StatusPanel({ status }) {
    if (!status) return <div className="card">載入中...</div>;

    const { wallets, activeOffers, activeCredits } = status;
    const usdWallet = wallets?.USD;
    const usdOffers = activeOffers?.USD;
    const usdCredits = activeCredits?.USD;
    const privateDataAvailable = status.accountDataAvailable ?? (status.running || status.authenticated);
    const privateValue = value => privateDataAvailable && value != null ? value : '—';

    return (
        <div className={`status-panel-content ${usdWallet ? '' : 'status-without-wallet'}`}>
            {usdWallet && (
                <div className="status-wallet">
                    <span className="card-title">USD Funding 錢包</span>
                    <div className="stat-value green">
                        {privateDataAvailable && usdWallet.balance != null ? Number(usdWallet.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                    </div>
                    <div className="stat-label">
                        可用：{privateDataAvailable
                            ? usdWallet.available != null
                                ? Number(usdWallet.available).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                : '—'
                            : '尚未連接 Bitfinex 私有 API'}
                    </div>
                </div>
            )}

            <div className="status-summary-grid" aria-label="USD 放貸概覽">
                <div className="status-metric">
                    <span className="card-title">活躍掛單 · USD</span>
                    <div className="status-metric-value">{privateValue(usdOffers)}</div>
                </div>
                <div className="status-metric">
                    <span className="card-title">放貸中 · USD</span>
                    <div className="status-metric-value cyan">{privateValue(usdCredits)}</div>
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
