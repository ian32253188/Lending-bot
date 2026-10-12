import { useEffect, useState } from 'react';

const RATE_STRATEGIES = [
    ['current_avg', '目前成交均值'],
    ['high_24h', '24 小時最高'],
    ['high_30d', '30 日最高'],
];
const PERIOD_DAYS = [2, 10, 30, 60, 90, 120];

export default function StrategyPanel({ status, token, onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [confirmAction, setConfirmAction] = useState(null);
    const [strategySettingsError, setStrategySettingsError] = useState('');
    const [strategySettings, setStrategySettings] = useState({ rateStrategy: 'current_avg', periodDays: 2 });
    const [savedStrategySettings, setSavedStrategySettings] = useState({ rateStrategy: 'current_avg', periodDays: 2 });

    const strategyActive = status?.running && !status?.paused;
    const strategyDirty = JSON.stringify(strategySettings) !== JSON.stringify(savedStrategySettings);
    const availableUsd = status?.wallets?.USD?.available;
    const strategyName = RATE_STRATEGIES.find(([key]) => key === strategySettings.rateStrategy)?.[1] || '目前成交均值';

    async function fetchStrategySettings() {
        try {
            const res = await fetch('/api/lending/strategy-settings', { headers: { Authorization: `Bearer ${token}` } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `策略設定讀取失敗（HTTP ${res.status}）`);
            const next = { rateStrategy: data.rateStrategy, periodDays: data.periodDays };
            setStrategySettings(next);
            setSavedStrategySettings(next);
            setStrategySettingsError('');
        } catch (err) {
            setStrategySettingsError(err.message || '策略設定暫時無法讀取。');
        }
    }

    useEffect(() => {
        fetchStrategySettings();
    }, [token]);

    useEffect(() => {
        if (!status?.strategySettings || strategyDirty) return;
        const next = {
            rateStrategy: status.strategySettings.rateStrategy || 'current_avg',
            periodDays: status.strategySettings.periodDays || 2,
        };
        setStrategySettings(next);
        setSavedStrategySettings(next);
    }, [status?.strategySettings?.rateStrategy, status?.strategySettings?.periodDays, strategyDirty]);

    const post = async (url, body = {}) => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `操作失敗（HTTP ${res.status}）`);
        return data;
    };

    const apiCall = async fn => {
        setLoading(true);
        setMessage('');
        try {
            const result = await fn();
            if (result?.message) setMessage(result.message);
            onRefresh?.();
        } catch (err) {
            setMessage(err.message || '操作失敗，請稍後重試。');
        } finally {
            setLoading(false);
        }
    };

    const engineAction = action => apiCall(async () => {
        const result = await post(`/api/lending/engine/${action}`);
        setConfirmAction(null);
        return result;
    });

    const saveStrategy = () => apiCall(async () => {
        const result = await post('/api/lending/strategy-settings', strategySettings);
        setSavedStrategySettings({ ...strategySettings });
        return result;
    });

    return (
        <div className="card strategy-panel">
            <div className="card-header">
                <span className="card-title">策略控制</span>
                <div className="strategy-engine-actions">
                    {!strategyActive && (
                        <button className="btn btn-success btn-sm" onClick={() => setConfirmAction('start')} disabled={loading}>
                            {status?.running && status?.paused ? '恢復放貸' : '啟動放貸'}
                        </button>
                    )}
                    {status?.running && (
                        <button className="btn btn-outline btn-sm" onClick={() => setConfirmAction('stop')} disabled={loading}>
                            停止機器人
                        </button>
                    )}
                </div>
            </div>

            {confirmAction && (
                <div className="strategy-confirmation" role="group" aria-label={confirmAction === 'start' ? '確認啟動放貸' : '確認停止機器人'}>
                    {confirmAction === 'start' ? (
                        <>
                            <strong>{status?.running && status?.paused ? '恢復放貸前確認' : '啟動前確認'}</strong>
                            <p>
                                {availableUsd == null
                                    ? '帳戶餘額尚未同步；機器人連線後會讀取可用 USD。'
                                    : `Funding Wallet 可用 USD ${Number(availableUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}；可用金額嚴格大於 $150 時，全部餘額會以單筆掛單，依「${strategyName}」基準及 ${strategySettings.periodDays} 天期限送出。複利固定開啟。`}
                            </p>
                            {strategyDirty && <p role="alert">策略有尚未儲存的變更。請先儲存，再啟動。</p>}
                            <div className="strategy-confirmation-actions">
                                <button type="button" className="btn btn-success btn-sm" onClick={() => engineAction('start')} disabled={loading || strategyDirty}>
                                    {status?.running && status?.paused ? '確認恢復' : '確認啟動'}
                                </button>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmAction(null)}>取消</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <strong>停止後會停止新增自動掛單。</strong>
                            <p>已掛出的 USD 掛單和放貸中的合約會留在 Bitfinex，不會自動取消或提前結束。</p>
                            <div className="strategy-confirmation-actions">
                                <button type="button" className="btn btn-outline btn-sm" onClick={() => engineAction('stop')} disabled={loading}>確認停止</button>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmAction(null)}>取消</button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {message && <div className="strategy-message" role="status" aria-live="polite">{message}</div>}

            <div className="strategy-settings-box">
                <div className="strategy-settings-title">USD 放貸策略</div>
                {strategySettingsError && !status?.strategySettings && (
                    <div className="market-error" role="alert">
                        <strong>策略設定暫不可用</strong>
                        <span>{strategySettingsError}；下方選項是預設值，尚未確認為已儲存設定。</span>
                        <button type="button" className="btn btn-sm btn-outline" onClick={fetchStrategySettings}>重新載入</button>
                    </div>
                )}
                <div className="strategy-choice-grid">
                    {RATE_STRATEGIES.map(([value, label]) => (
                        <button key={value} type="button" className={`strategy-choice ${strategySettings.rateStrategy === value ? 'selected' : ''}`} onClick={() => setStrategySettings({ ...strategySettings, rateStrategy: value })} disabled={loading}>
                            {label}
                        </button>
                    ))}
                </div>
                <div className="strategy-settings-title" style={{ marginTop: 12 }}>放貸期限</div>
                <div className="strategy-choice-grid period-grid">
                    {PERIOD_DAYS.map(days => (
                        <button key={days} type="button" className={`strategy-choice ${strategySettings.periodDays === days ? 'selected' : ''}`} onClick={() => setStrategySettings({ ...strategySettings, periodDays: days })} disabled={loading}>
                            {days} 天
                        </button>
                    ))}
                </div>
                <div className="strategy-settings-footnote">掛單方式：Funding Wallet 可用 USD 嚴格大於 $150 時，將全部可用餘額以單筆掛單送出；利率直接採用所選基準，複利固定開啟。</div>
                <button type="button" className="btn btn-primary btn-sm" onClick={saveStrategy} disabled={loading || !strategyDirty} style={{ marginTop: 10 }}>
                    {strategyDirty ? '儲存策略變更' : '策略已儲存'}
                </button>
            </div>
        </div>
    );
}
