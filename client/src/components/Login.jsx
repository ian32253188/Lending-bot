import { useState } from 'react';

export default function Login({ supabase }) {
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleGoogleLogin = async () => {
        setError('');
        setLoading(true);
        try {
            if (!supabase) {
                setError('資料庫連接未準備就緒');
                setLoading(false);
                return;
            }
            const { error: err } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: window.location.origin
                }
            });
            if (err) {
                setError(err.message);
                setLoading(false);
            }
        } catch (err) {
            setError('第三方登入失敗：' + err.message);
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <h1 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    ⚡ Lending Bot
                </h1>
                <p className="subtitle">Bitfinex 自動放貸平台 (SaaS)</p>

                {error && <div className="login-error">{error}</div>}

                <div style={{ marginTop: 20, marginBottom: 20 }}>
                    <button 
                        type="button" 
                        className="btn btn-primary" 
                        onClick={handleGoogleLogin} 
                        disabled={loading}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '10px',
                            background: '#4285F4',
                            border: 'none',
                            color: 'white',
                            fontWeight: 'bold',
                            padding: '12px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            width: '100%'
                        }}
                    >
                        <svg width="18" height="18" viewBox="0 0 18 18" style={{ fill: 'white' }}>
                            <path d="M17.64 9.2c0-.63-.06-1.25-.16-1.84H9v3.47h4.84c-.21 1.12-.84 2.07-1.79 2.7v2.24h2.9c1.69-1.55 2.69-3.84 2.69-6.57z"/>
                            <path d="M9 18c2.43 0 4.47-.8 5.96-2.23l-2.9-2.24c-.8.54-1.84.87-3.06.87-2.35 0-4.34-1.58-5.05-3.71H.92v2.3C2.4 16 5.45 18 9 18z"/>
                            <path d="M3.95 10.7a5.4 5.4 0 0 1 0-3.4V5H.92a9 9 0 0 0 0 8l3.03-2.3z"/>
                            <path d="M9 3.58c1.32 0 2.5.45 3.44 1.35L15 2.4C13.46.98 11.42 0 9 0 5.45 0 2.4 2 1.05 4.97l3.03 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
                        </svg>
                        使用 Google 帳號登入
                    </button>
                </div>
                
                <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', textAlign: 'center', marginTop: 10 }}>
                    SaaS 版本支援多帳號獨立運行與 RLS 資料隔離
                </p>
            </div>
        </div>
    );
}
