import { useState, useEffect } from 'react';

export default function SettingsPanel({ token }) {
    const [settings, setSettings] = useState({
        bitfinex_api_key: '',
        bitfinex_api_secret: '',
        telegram_bot_token: '',
        telegram_chat_id: '',
        min_offer_amount: 150,
        compounding_enabled: true,
        auto_transfer_enabled: false,
        auto_transfer_threshold: 500,
        lending_currencies: ['USD', 'USDT'],
        rateStrategy: 'current_avg',
        periodDays: 2,
    });

    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState({ type: '', text: '' });

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/lending/settings', {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                if (data) {
                    setSettings({
                        bitfinex_api_key: data.bitfinex_api_key || '',
                        bitfinex_api_secret: data.bitfinex_api_secret || '',
                        telegram_bot_token: data.telegram_bot_token || '',
                        telegram_chat_id: data.telegram_chat_id || '',
                        min_offer_amount: data.min_offer_amount ?? 150,
                        compounding_enabled: data.compounding_enabled ?? true,
                        auto_transfer_enabled: data.auto_transfer_enabled ?? false,
                        auto_transfer_threshold: data.auto_transfer_threshold ?? 500,
                        lending_currencies: data.lending_currencies || ['USD', 'USDT'],
                        rateStrategy: data.strategy_config?.rateStrategy || 'current_avg',
                        periodDays: data.strategy_config?.periodDays || 2,
                    });
                }
            }
        } catch (err) {
            setMsg({ type: 'error', text: '無法讀取放貸設定：' + err.message });
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMsg({ type: '', text: '' });

        try {
            // Keep strategy fields inside strategy_config. The previous code
            // referenced accountSettings/rateStrategy/periodDays from the
            // fetchSettings scope, which caused every save to throw before
            // the request was sent.
            const { rateStrategy, periodDays, ...accountSettings } = settings;
            const res = await fetch('/api/lending/settings', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    ...accountSettings,
                    strategy_config: { rateStrategy, periodDays, useAllAvailable: true },
                }),
            });

            const data = await res.json();
            if (res.ok) {
                setMsg({ type: 'success', text: '✅ 設定已成功更新！' });
                fetchSettings();
            } else {
                setMsg({ type: 'error', text: '❌ 更新失敗：' + (data.error || '未知錯誤') });
            }
        } catch (err) {
            setMsg({ type: 'error', text: '❌ 連線錯誤：' + err.message });
        } finally {
            setSaving(false);
        }
    };

    const handleCheckboxChange = (currency) => {
        const current = [...settings.lending_currencies];
        const idx = current.indexOf(currency);
        if (idx > -1) {
            current.splice(idx, 1);
        } else {
            current.push(currency);
        }
        setSettings({ ...settings, lending_currencies: current });
    };

    if (loading) {
        return <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>載入設定中...</div>;
    }

    return (
        <div className="settings-container" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <form onSubmit={handleSave} className="card">
                <div className="card-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                    <span className="card-title">⚙️ 放貸系統設定</span>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>配置您交易所 API 金鑰與放貸策略參數</span>
                </div>

                <div style={{ padding: '20px 0' }}>
                    {msg.text && (
                        <div style={{
                            padding: '12px 16px',
                            borderRadius: '6px',
                            marginBottom: '20px',
                            background: msg.type === 'success' ? 'rgba(63, 185, 80, 0.15)' : 'rgba(248, 81, 73, 0.15)',
                            border: `1px solid ${msg.type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)'}`,
                            color: msg.type === 'success' ? '#3fb950' : '#f85149',
                            fontSize: '0.9rem'
                        }}>
                            {msg.text}
                        </div>
                    )}

                    {/* Section 1: API */}
                    <div style={{ marginBottom: 30 }}>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: 16, color: 'var(--accent-blue)', borderBottom: '1px solid rgba(88, 166, 255, 0.15)', paddingBottom: 6 }}>
                            🔑 Bitfinex 交易所 API 設定
                        </h3>
                        <div className="grid grid-2" style={{ gap: 16 }}>
                            <div className="form-group">
                                <label>Bitfinex API Key</label>
                                <input
                                    type="text"
                                    value={settings.bitfinex_api_key}
                                    onChange={(e) => setSettings({ ...settings, bitfinex_api_key: e.target.value })}
                                    placeholder="輸入 API 金鑰 (唯讀+放貸權限)"
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Bitfinex API Secret</label>
                                <input
                                    type="password"
                                    value={settings.bitfinex_api_secret}
                                    onChange={(e) => setSettings({ ...settings, bitfinex_api_secret: e.target.value })}
                                    placeholder="輸入 API 密鑰"
                                    required
                                />
                            </div>
                        </div>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: -6 }}>
                            僅查看錢包與放貸部位需要 Wallet Read、Funding Read；若要讓 Bot 建立或取消掛單，才需要 Margin Funding Write。請勿開啟 Withdrawal 權限。保存設定不會啟動已停止的策略；金鑰會在伺服器端加密保存於 Oracle PostgreSQL，不會以明文回傳前端。
                        </p>
                    </div>

                    {/* Section 2: Telegram */}
                    <div style={{ marginBottom: 30 }}>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: 16, color: 'var(--accent-cyan)', borderBottom: '1px solid rgba(57, 210, 192, 0.15)', paddingBottom: 6 }}>
                            ✈️ Telegram 通知設定
                        </h3>
                        <div className="grid grid-2" style={{ gap: 16 }}>
                            <div className="form-group">
                                <label>Telegram Bot Token</label>
                                <input
                                    type="text"
                                    value={settings.telegram_bot_token}
                                    onChange={(e) => setSettings({ ...settings, telegram_bot_token: e.target.value })}
                                    placeholder="例如 8556906741:AAHW..."
                                />
                            </div>
                            <div className="form-group">
                                <label>Telegram Chat ID</label>
                                <input
                                    type="text"
                                    value={settings.telegram_chat_id}
                                    onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })}
                                    placeholder="例如 6794252109"
                                />
                            </div>
                        </div>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: -6 }}>
                            💡 設定後，系統會在成功掛單、撮合成交、或帳戶異常時向您發送即時 Telegram 通知。若不需通知可留空。
                        </p>
                    </div>

                    {/* Section 3: Lending Params */}
                    <div style={{ marginBottom: 20 }}>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: 16, color: 'var(--accent-green)', borderBottom: '1px solid rgba(63, 185, 80, 0.15)', paddingBottom: 6 }}>
                            ⚙️ 放貸策略與參數
                        </h3>

                        <div className="form-group" style={{ marginBottom: 20 }}>
                            <label style={{ display: 'block', marginBottom: 8 }}>放貸幣種選擇</label>
                            <div style={{ display: 'flex', gap: 24, padding: '4px 0' }}>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.95rem' }}>
                                    <input
                                        type="checkbox"
                                        style={{ width: 'auto', cursor: 'pointer' }}
                                        checked={settings.lending_currencies.includes('USD')}
                                        onChange={() => handleCheckboxChange('USD')}
                                    />
                                    USD 美金
                                </label>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.95rem' }}>
                                    <input
                                        type="checkbox"
                                        style={{ width: 'auto', cursor: 'pointer' }}
                                        checked={settings.lending_currencies.includes('USDT')}
                                        onChange={() => handleCheckboxChange('USDT')}
                                    />
                                    USDT 泰達幣
                                </label>
                            </div>
                        </div>

                        <div className="grid grid-2" style={{ gap: 16 }}>
                            <div className="form-group">
                                <label>fUSD 利率策略</label>
                                <select value={settings.rateStrategy} onChange={(e) => setSettings({ ...settings, rateStrategy: e.target.value })}>
                                    <option value="current_avg">目前成交均值</option>
                                    <option value="high_24h">24 小時最高</option>
                                    <option value="high_30d">30 日最高</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>放貸天數</label>
                                <select value={settings.periodDays} onChange={(e) => setSettings({ ...settings, periodDays: Number(e.target.value) })}>
                                    {[2, 10, 30, 60, 90, 120].map(days => <option key={days} value={days}>{days} 天</option>)}
                                </select>
                            </div>
                        </div>

                        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: 16 }}>
                            💰 掛單金額固定使用 Funding Wallet 當下全部可用餘額；已放貸中的資金不會重複掛單。
                        </div>

                        <div className="grid grid-2" style={{ gap: 16 }}>
                            <div className="form-group">
                                <label>最低放貸單位 (Min Offer Amount)</label>
                                <input
                                    type="number"
                                    value={settings.min_offer_amount}
                                    onChange={(e) => setSettings({ ...settings, min_offer_amount: parseInt(e.target.value) || 150 })}
                                    min="150"
                                    placeholder="最低 150 美元"
                                />
                                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Bitfinex 單筆掛單最低限制為 150</span>
                            </div>
                            <div className="form-group">
                                <label>自動複利模式 (Compounding)</label>
                                <div style={{ display: 'flex', alignItems: 'center', height: '40px' }}>
                                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.95rem' }}>
                                        <input
                                            type="checkbox"
                                            style={{ width: 'auto', cursor: 'pointer' }}
                                            checked={settings.compounding_enabled}
                                            onChange={(e) => setSettings({ ...settings, compounding_enabled: e.target.checked })}
                                        />
                                        啟用自動複利（將利息自動滾入下一次放貸）
                                    </label>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-2" style={{ gap: 16, marginTop: 12 }}>
                            <div className="form-group" style={{ display: 'flex', alignItems: 'center', height: '40px' }}>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.95rem' }}>
                                    <input
                                        type="checkbox"
                                        style={{ width: 'auto', cursor: 'pointer' }}
                                        checked={settings.auto_transfer_enabled}
                                        onChange={(e) => setSettings({ ...settings, auto_transfer_enabled: e.target.checked })}
                                    />
                                    啟用自動轉帳 (Auto-transfer)
                                </label>
                            </div>
                            {settings.auto_transfer_enabled && (
                                <div className="form-group">
                                    <label>自動轉帳觸發門檻 (Threshold)</label>
                                    <input
                                        type="number"
                                        value={settings.auto_transfer_threshold}
                                        onChange={(e) => setSettings({ ...settings, auto_transfer_threshold: parseInt(e.target.value) || 500 })}
                                        min="1"
                                        placeholder="例如 500"
                                    />
                                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>當交易錢包餘額超過此金額時自動轉入融資錢包</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: 16, marginTop: 10 }}>
                    <button type="submit" className="btn btn-primary" style={{ width: 'auto', minWidth: '150px' }} disabled={saving}>
                        {saving ? '正在儲存...' : '💾 儲存並套用設定'}
                    </button>
                </div>
            </form>
        </div>
    );
}
