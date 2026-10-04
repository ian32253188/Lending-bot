export function getEngineBadge(status) {
    if (!status?.running) {
        return { label: '⛹️ 放貸停止', className: 'disconnected', title: '放貸引擎已停止' };
    }
    if (status.paused) {
        return { label: '⏸️ 策略已暫停', className: 'paused', title: '放貸策略已暫停' };
    }
    if (status.accountDataError || status.authenticated === false) {
        return {
            label: '⚠️ 帳戶同步異常',
            className: 'degraded',
            title: '引擎程序已啟動，但 Bitfinex 帳戶未能正常驗證或同步；不可視為正常放貸。',
        };
    }
    if (status.accountDataComplete === false) {
        return { label: '🟡 帳戶同步中', className: 'degraded', title: '正在同步 Bitfinex 私有帳戶資料' };
    }
    return { label: '🟢 放貸中', className: 'connected', title: '放貸引擎運作中' };
}
