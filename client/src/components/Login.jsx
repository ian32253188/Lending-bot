import { useState } from 'react';

export default function Login({ onLoginSuccess }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!password) {
            setError('請輸入管理員密碼');
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || '登入失敗，請確認密碼是否正確');
            }

            if (data.token) {
                if (onLoginSuccess) {
                    onLoginSuccess(data.token, data.user);
                }
            } else {
                throw new Error('伺服器未回傳有效 Token');
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚡</div>
                    <h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: '700', letterSpacing: '-0.5px' }}>
                        Lending Bot
                    </h1>
                    <p className="subtitle" style={{ margin: '6px 0 0 0', color: 'var(--text-secondary, #8b949e)', fontSize: '0.9rem' }}>
                        Bitfinex 自動放貸平台 (Oracle 自託管)
                    </p>
                </div>

                {error && (
                    <div className="login-error" style={{
                        padding: '10px 14px',
                        background: 'rgba(239, 68, 68, 0.15)',
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        borderRadius: '8px',
                        color: '#f87171',
                        fontSize: '0.85rem',
                        marginBottom: '18px',
                        textAlign: 'center'
                    }}>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '18px' }}>
                        <label
                            htmlFor="admin-password"
                            style={{
                                display: 'block',
                                marginBottom: '8px',
                                fontSize: '0.85rem',
                                color: 'var(--text-secondary, #c9d1d9)',
                                fontWeight: '500'
                            }}
                        >
                            管理員密碼
                        </label>
                        <input
                            id="admin-password"
                            type="password"
                            placeholder="請輸入系統管理員密碼"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={loading}
                            autoFocus
                            style={{
                                width: '100%',
                                boxSizing: 'border-box',
                                padding: '12px 14px',
                                borderRadius: '8px',
                                border: '1px solid var(--border-color, #30363d)',
                                background: 'rgba(13, 17, 23, 0.8)',
                                color: '#f0f6fc',
                                fontSize: '0.95rem',
                                outline: 'none',
                                transition: 'border-color 0.2s, box-shadow 0.2s',
                            }}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="btn btn-primary"
                        style={{
                            width: '100%',
                            padding: '12px',
                            borderRadius: '8px',
                            border: 'none',
                            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                            color: '#ffffff',
                            fontWeight: '600',
                            fontSize: '0.95rem',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            opacity: loading ? 0.7 : 1,
                            transition: 'all 0.2s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)'
                        }}
                    >
                        {loading ? '驗證中...' : '登入儀表板'}
                    </button>
                </form>

                <div style={{ marginTop: '24px', textAlign: 'center', borderTop: '1px solid var(--border-color, #21262d)', paddingTop: '16px' }}>
                    <p style={{ fontSize: '0.75rem', color: '#6e7681', margin: 0 }}>
                        資料庫直連 Oracle VM 本機 PostgreSQL，無雲端配額限制
                    </p>
                </div>
            </div>
        </div>
    );
}
