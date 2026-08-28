import { useEffect, useState } from 'react';

export default function StrategyPanel({ status, token, onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [msg, setMsg] = useState('');
    const [suggestion, setSuggestion] = useState(null);
    const [strategySettings, setStrategySettings] = useState({ rateStrategy: 'current_avg', periodDays: 2 });

    const features = status?.features || {};
    const strategyConfig = status?.strategy?.config || {};
    const currentMode = status?.strategy?.mode || 'balanced';
    const strategyActive = status?.running && !status?.paused;

    useEffect(() => {
        fetch('/api/lending/strategy-settings', { headers: { Authorization: `Bearer ${token}` } })
            .then(res => res.ok ? res.json() : null)
            .then(data => data && setStrategySettings({ rateStrategy: data.rateStrategy, periodDays: data.periodDays }))
            .catch(() => {});
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
        return res.json();
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
            setSuggestion(await r.json());
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
                                <span key={cur}>
                                    <span className="badge">{cur}</span>
                                    {' '}{(rate * 100).toFixed(4)}%/天
                                </span>
                            ))}
                        </div>
                        {suggestion.suggestions?.length > 0 ? (
                            suggestion.suggestions.map((s, i) => (
                                <div key={i} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px', color: 'var(--warning)', fontSize: '0.8rem' }}>
                                    💡 {s.reason}
                                </div>
                            ))
                        ) : (
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>目前利率相近，無需切換</div>
                        )}
                    </div>
                )}
            </div>

            {/* 當前策略參數 */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
                {[
                    ['FRR Delta', strategyConfig.frrDelta != null ? `${strategyConfig.frrDelta > 0 ? '+' : ''}${(strategyConfig.frrDelta * 100).toFixed(4)}%` : '-'],
                    ['單筆金額', strategyConfig.orderUnit ? `$${strategyConfig.orderUnit} USD` : '-'],
                    ['選定期限', `${strategySettings.periodDays || 2} 天`],
                    ['預留資金', `${((strategyConfig.reserveRatio || 0) * 100).toFixed(0)}%`],
                    ['防假單過濾 (Spoofing)', currentMode === 'balanced' ? '🟢 ON (10min誠信過濾)' : '❌ OFF'],
                    ['時空深度分佈 (3D)', currentMode === 'balanced' ? '60%底倉 / 20%深度 / 20%級聯' : '100%空間單一'],
                ].map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px dashed var(--border-light)' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                        <span style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>{v}</span>
                    </div>
                ))}
            </div>

            {/* 📖 策略運作機制深入介紹 */}
            <div style={{
                marginTop: 14,
                padding: '12px 14px',
                background: 'var(--surface-2)',
                borderRadius: '8px',
                fontSize: '0.78rem',
                border: '1px solid var(--border)'
            }}>
                <div style={{ fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                    📖 3D_Hybrid 運作機制與優勢：
                </div>
                <ul style={{ paddingLeft: 16, margin: 0, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <li>
                        <strong style={{ color: 'var(--text-primary)' }}>🛡️ 10分鐘誠信過濾 (Harmonia)：</strong>
                        排除最近 10 分鐘內建立的委託單，徹底擠乾訂單簿內高頻釣魚假單的「水分」，還原真實供需。
                    </li>
                    <li>
                        <strong style={{ color: 'var(--text-primary)' }}>🧱 阻力牆繞道避讓：</strong>
                        實時檢測占比大於 25% 的大資金阻力牆，定價自動搶先在牆前 2% 利率插隊，確保高效成交不踏空。
                    </li>
                    <li>
                        <strong style={{ color: 'var(--text-primary)' }}>📈 空間底倉 (60% - Cubic網格)：</strong>
                        以均衡出清利率為基底，採立方緩和曲線向上拉升 12% 溢價網格，金額隨機微幅抖動，完美規避莊家檢測。
                    </li>
                    <li>
                        <strong style={{ color: 'var(--text-primary)' }}>🔬 深度與時間雙探針 (各20%)：</strong>
                         Percent Depth 捕捉訂單簿 15% 交易量深度的溢價防線；級聯天價探針 (2.5x 息) 隨時間指數衰減降息以釣魚天價。
                    </li>
                    <li>
                        <strong style={{ color: 'var(--text-primary)' }}>📅 期限彈性拉伸：</strong>
                        依據 Bitfinex 全網平均成交期限自適應拉伸 (2~30天)，低息借 2 天保留流動性，高息鎖 30 天鎖定超額暴利。
                    </li>
                </ul>
            </div>
        </div>
    );
}
