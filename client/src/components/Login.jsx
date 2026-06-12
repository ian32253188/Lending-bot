import { useState } from 'react';

export default function Login({ onLogin }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data.error || '登入失敗');
                return;
            }

            localStorage.setItem('token', data.token);
            onLogin(data.token);
        } catch (err) {
            setError('連線失敗，請確認伺服器是否運行');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <form className="login-card" onSubmit={handleSubmit}>
                <h1>⚡ Lending Bot</h1>
                <p className="subtitle">Bitfinex 自動放貸機器人</p>

                {error && <div className="login-error">{error}</div>}

                <div className="form-group">
                    <label>管理員密碼</label>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="請輸入密碼"
                        autoFocus
                    />
                </div>

                <button type="submit" className="btn btn-primary" disabled={loading}>
                    {loading ? '登入中...' : '登入'}
                </button>
            </form>
        </div>
    );
}
