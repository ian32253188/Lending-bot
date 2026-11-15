import { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
    const [token, setToken] = useState(localStorage.getItem('token'));
    const [authenticated, setAuthenticated] = useState(false);
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [verificationError, setVerificationError] = useState('');
    const [verificationAttempt, setVerificationAttempt] = useState(0);
    const { status, connected, refresh: refreshStatus } = useWebSocket(authenticated ? token : null);

    const clearAuthState = useCallback(() => {
        localStorage.removeItem('token');
        setToken(null);
        setAuthenticated(false);
        setUser(null);
        setVerificationError('');
    }, []);

    const retryTokenVerification = () => {
        setVerificationError('');
        setLoading(true);
        setVerificationAttempt((attempt) => attempt + 1);
    };

    const handleLogout = useCallback(async () => {
        const activeToken = localStorage.getItem('token');
        if (!activeToken) {
            clearAuthState();
            return;
        }
        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST',
                keepalive: true,
                headers: { Authorization: `Bearer ${activeToken}` },
            });
            if (!response.ok && response.status !== 401) {
                throw new Error('伺服器未能確認撤銷工作階段');
            }
            clearAuthState();
        } catch (error) {
            window.alert('登出尚未完成，伺服器未確認撤銷登入工作階段。請保持此頁開啟，確認服務恢復後再試一次。');
        }
    }, [clearAuthState]);

    useEffect(() => {
        const clearRevokedSession = () => clearAuthState();
        window.addEventListener('lending-session-revoked', clearRevokedSession);
        return () => window.removeEventListener('lending-session-revoked', clearRevokedSession);
    }, [clearAuthState]);

    const handleLoginSuccess = (newToken, newUser) => {
        localStorage.setItem('token', newToken);
        setToken(newToken);
        setUser(newUser);
        setAuthenticated(true);
        setVerificationError('');
    };

    // 初始化檢查 Token 有效性
    useEffect(() => {
        let active = true;
        const savedToken = localStorage.getItem('token');
        if (!savedToken) {
            setLoading(false);
            return () => { active = false; };
        }

        fetch('/api/auth/verify', {
            headers: {
                Authorization: `Bearer ${savedToken}`,
            },
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!active) return;
                if (res.status === 401 || res.status === 403) {
                    clearAuthState();
                    return;
                }
                if (!res.ok) {
                    setVerificationError(`目前無法確認登入狀態（HTTP ${res.status}）。請稍後重試；登入資料已保留。`);
                    return;
                }
                if (data.valid && data.user) {
                    setToken(savedToken);
                    setUser(data.user);
                    setAuthenticated(true);
                    setVerificationError('');
                } else {
                    clearAuthState();
                }
            })
            .catch(() => {
                if (active) setVerificationError('目前無法連線確認登入狀態。請稍後重試；登入資料已保留。');
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [clearAuthState, verificationAttempt]);

    if (loading) {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: '100vh',
                background: '#0d1117',
                color: '#8b949e',
                fontSize: '1.2rem',
                fontFamily: 'sans-serif'
            }}>
                ⚡ Lending Bot 載入中...
            </div>
        );
    }

    if (!authenticated) {
        if (verificationError) {
            return (
                <div role="status" style={{ display: 'grid', placeContent: 'center', gap: '1rem', minHeight: '100vh', padding: '2rem', background: '#0d1117', color: '#c9d1d9', textAlign: 'center', fontFamily: 'sans-serif' }}>
                    <p>{verificationError}</p>
                    <button type="button" onClick={retryTokenVerification} style={{ justifySelf: 'center', padding: '0.65rem 1rem', cursor: 'pointer' }}>
                        重試驗證
                    </button>
                </div>
            );
        }
        return <Login onLoginSuccess={handleLoginSuccess} />;
    }

    return (
        <Dashboard
            status={status}
            connected={connected}
            token={token}
            onLogout={handleLogout}
            onRefresh={refreshStatus}
        />
    );
}
