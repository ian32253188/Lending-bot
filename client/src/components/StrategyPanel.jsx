import { useState } from 'react';

export default function StrategyPanel({ status, token, onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [msg, setMsg] = useState('');
    const [suggestion, setSuggestion] = useState(null);

    const features = status?.features || {};
    const strategyConfig = status?.strategy?.config || {};
    const currentMode = status?.strategy?.mode || 'balanced';

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
                    {status?.running && !status?.paused && (
                        <button className="btn btn-outline btn-sm" onClick={() => engineAction('pause')} disabled={loading}>⏸️ 暫停</button>
                    )}
                    {status?.paused && (
                        <button className="btn btn-success btn-sm" onClick={() => engineAction('resume')} disabled={loading}>▶️ 恢復</button>
                    )}
                    {!status?.running && (
                        <button className="btn btn-success btn-sm" onClick={() => engineAction('start')} disabled={loading}>🚀 啟動放貸</button>
                    )}
                    {status?.running && (
                        <>
                            <button className="btn btn-outline btn-sm" onClick={() => engineAction('stop')} disabled={loading}>⏹️ 停止</button>
                            <button className="btn btn-danger btn-sm" onClick={() => engineAction('emergency-stop')} disabled={loading}>🚨 緊急停止</button>
                        </>
                    )}
                </div>
            </div>

            {msg && (
                <div style={{ fontSize: '0.82rem', padding: '6px 0', color: msg.startsWith('✅') ? 'var(--success)' : 'var(--danger)' }}>
                    {msg}
                </div>
            )}

            {/* 🌌 響應用戶需求：舊策略直接拿掉，只保留 3D_Hybrid 核心策略大卡片 */}
            <div style={{ margin: '8px 0 12px 0' }}>
                <div style={{
                    background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(5, 150, 105, 0.05) 100%)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    borderRadius: '10px',
                    padding: '14px 16px',
                    position: 'relative',
                    overflow: 'hidden'
                }}>
                    <div style={{ position: 'absolute', right: '-10px', top: '-10px', fontSize: '4.5rem', opacity: 0.08 }}>🌌</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: '1.05rem', fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
                            🌌 3D 防禦型自適應策略 (3D_Hybrid)
                        </span>
                        <span style={{
                            background: '#10b981',
                            color: '#fff',
                            fontSize: '0.68rem',
                            fontWeight: 'bold',
                            padding: '2px 8px',
                            borderRadius: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            boxShadow: '0 0 10px rgba(16, 185, 129, 0.4)'
                        }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff', display: 'inline-block', animation: 'pulse 1.5s infinite' }}></span>
                            核心已接管
                        </span>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        融合瓦爾拉斯供需均衡 (IBRR)、10分鐘誠信時間過濾 (防假單) 與三維動態分配 (底倉/深度/級聯)，全面阻斷高頻釣魚，極大化複利收益。
                    </div>
                </div>
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
                    ['預設期限', strategyConfig.defaultPeriod || '-'],
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
