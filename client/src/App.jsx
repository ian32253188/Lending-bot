import { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
    const [token, setToken] = useState(localStorage.getItem('token'));
    const [authenticated, setAuthenticated] = useState(false);
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const { status, connected, refresh: refreshStatus } = useWebSocket(authenticated ? token : null);

    const clearAuthState = useCallback(() => {
        localStorage.removeItem('token');
        setToken(null);
        setAuthenticated(false);
        setUser(null);
    }, []);

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
    };

    // 初始化檢查 Token 有效性
    useEffect(() => {
        const savedToken = localStorage.getItem('token');
        if (!savedToken) {
            setLoading(false);
            return;
        }

        fetch('/api/auth/verify', {
            headers: {
                Authorization: `Bearer ${savedToken}`,
            },
        })
            .then((res) => {
                if (!res.ok) throw new Error('Token 驗證失敗');
                return res.json();
            })
            .then((data) => {
                if (data.valid && data.user) {
                    setToken(savedToken);
                    setUser(data.user);
                    setAuthenticated(true);
                } else {
                    clearAuthState();
                }
            })
            .catch(() => {
                clearAuthState();
            })
            .finally(() => {
                setLoading(false);
            });
    }, [clearAuthState]);

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
