import { useEffect, useState } from 'react';

export default function StrategyPanel({ status, token, onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [msg, setMsg] = useState('');
    const [suggestion, setSuggestion] = useState(null);
    const [strategySettingsError, setStrategySettingsError] = useState('');
    const [strategySettings, setStrategySettings] = useState({ rateStrategy: 'current_avg', periodDays: 2 });

    const features = status?.features || {};
    const strategyActive = status?.running && !status?.paused;

    async function fetchStrategySettings() {
        try {
            const res = await fetch('/api/lending/strategy-settings', { headers: { Authorization: `Bearer ${token}` } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `策略設定讀取失敗（HTTP ${res.status}）`);
            setStrategySettings({ rateStrategy: data.rateStrategy, periodDays: data.periodDays });
            setStrategySettingsError('');
        } catch (err) {
            setStrategySettingsError(err.message || '策略設定暫時無法讀取。');
        }
    }

    useEffect(() => {
        fetchStrategySettings();
    }, [token]);

    useEffect(() => {
        if (status?.strategySettings) {
            setStrategySettings({
                rateStrategy: status.strategySettings.rateStrategy || 'current_avg',
                periodDays: status.strategySettings.periodDays || 2,
            });
        }
    }, [status?.strategySettings?.rateStrategy, status?.strategySettings?.periodDays]);

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

    const apiCall = async (fn) => {
        setLoading(true);
        setMsg('');
        try {
            const r = await fn();
            if (r.message) setMsg(`✅ ${r.message}`);
            onRefresh?.();
        } catch (err) {
            setMsg(`❌ ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const engineAction = (action) => apiCall(() => post(`/api/lending/engine/${action}`));

    const saveStrategy = () => apiCall(() => post('/api/lending/strategy-settings', strategySettings));

    const toggleCompounding = () => apiCall(() =>
        post('/api/lending/compounding', { enabled: !features.compounding })
    );

    const toggleAutoTransfer = () => apiCall(() =>
        post('/api/lending/auto-transfer', { enabled: !features.autoTransfer, threshold: features.autoTransferThreshold || 500 })
    );

    const fetchSuggestion = async () => {
        setLoading(true);
        try {
            const r = await fetch('/api/dashboard/suggestions', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || `行情讀取失敗（HTTP ${r.status}）`);
            setSuggestion(data);
        } catch (err) {
            setSuggestion({ available: false, error: err.message, rates: {}, suggestions: [] });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="card">
            <div className="card-header">
                <span className="card-title">⚙️ 策略控制</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {!strategyActive && (
                        <button className="btn btn-success btn-sm" onClick={() => engineAction('start')} disabled={loading}>🚀 啟動放貸</button>
                    )}
                    {strategyActive && (
                        <button className="btn btn-outline btn-sm" onClick={() => engineAction('stop')} disabled={loading}>⏹️ 停止</button>
                    )}
                </div>
            </div>

            {msg && (
                <div style={{ fontSize: '0.82rem', padding: '6px 0', color: msg.startsWith('✅') ? 'var(--success)' : 'var(--danger)' }}>
                    {msg}
                </div>
            )}

            <div className="strategy-settings-box">
                <div className="strategy-settings-title">fUSD 策略基準</div>
                {strategySettingsError && !status?.strategySettings && <div className="market-error" role="alert"><strong>策略設定暫不可用</strong><span>{strategySettingsError}；下方選項是預設值，尚未確認為已儲存設定。</span><button type="button" className="btn btn-sm btn-outline" onClick={fetchStrategySettings}>重新載入</button></div>}
                <div className="strategy-choice-grid">
                    {[
                        ['current_avg', '目前成交均值'],
                        ['high_24h', '24 小時最高'],
                        ['high_30d', '30 日最高'],
                    ].map(([value, label]) => (
                        <button key={value} type="button" className={`strategy-choice ${strategySettings.rateStrategy === value ? 'selected' : ''}`} onClick={() => setStrategySettings({ ...strategySettings, rateStrategy: value })} disabled={loading}>
                            {label}
                        </button>
                    ))}
                </div>
                <div className="strategy-settings-title" style={{ marginTop: 12 }}>放貸期限</div>
                <div className="strategy-choice-grid period-grid">
                    {[2, 10, 30, 60, 90, 120].map(days => (
                        <button key={days} type="button" className={`strategy-choice ${strategySettings.periodDays === days ? 'selected' : ''}`} onClick={() => setStrategySettings({ ...strategySettings, periodDays: days })} disabled={loading}>
                            {days} 天
                        </button>
                    ))}
                </div>
                <div className="strategy-settings-footnote">掛單金額：Funding Wallet 當下全部可用餘額（不含已放貸中的資金）</div>
                <button type="button" className="btn btn-primary btn-sm" onClick={saveStrategy} disabled={loading} style={{ marginTop: 10 }}>💾 儲存策略設定</button>
            </div>

            {/* Phase 2: 功能開關 */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 8 }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Phase 2 智慧功能</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                        className={`btn btn-sm ${features.compounding ? 'btn-success' : 'btn-ghost'}`}
                        onClick={toggleCompounding}
                        disabled={loading}
                        title="到期資金自動重新掛單"
                    >
                        {features.compounding ? '♻️ 複利 ON' : '♻️ 複利 OFF'}
                    </button>
                    <button
                        className={`btn btn-sm ${features.autoTransfer ? 'btn-success' : 'btn-ghost'}`}
                        onClick={toggleAutoTransfer}
                        disabled={loading}
                        title="Exchange 錢包餘額自動轉入 Funding"
                    >
                        {features.autoTransfer ? '🔄 自動轉帳 ON' : '🔄 自動轉帳 OFF'}
                    </button>
                    <button
                        className="btn btn-sm btn-ghost"
                        onClick={fetchSuggestion}
                        disabled={loading}
                    >
                        💡 輪動建議
                    </button>
                </div>

                {/* 幣種輪動建議 */}
                {suggestion && (
                    <div style={{ marginTop: 10, fontSize: '0.82rem' }}>
                        <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
                            {Object.entries(suggestion.rates || {}).map(([cur, rate]) => (
                                rate !== null && rate !== undefined && Number.isFinite(Number(rate)) && <span key={cur}>
                                    <span className="badge">{cur}</span>
                                    {' '}{(Number(rate) * 100).toFixed(4)}%/天
                                </span>
                            ))}
                        </div>
                        {suggestion.source && <div style={{ color: 'var(--text-tertiary)', marginBottom: 6 }}>來源：{suggestion.source}{suggestion.updatedAt ? `｜更新 ${new Date(suggestion.updatedAt).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}` : ''}</div>}
                        {suggestion.error && <div role="alert" style={{ color: 'var(--warning)', marginBottom: 6 }}>{suggestion.error}</div>}
                        {suggestion.suggestions?.length > 0 ? (
                            suggestion.suggestions.map((s, i) => (
                                <div key={i} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px', color: 'var(--warning)', fontSize: '0.8rem' }}>
                                    💡 {s.reason}
                                </div>
                            ))
                        ) : suggestion.available ? (
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>目前利率相近，無需切換</div>
                        ) : (
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>行情尚未更新或已過期，暫不提供輪動建議。</div>
                        )}
                    </div>
                )}
            </div>

        </div>
    );
}
