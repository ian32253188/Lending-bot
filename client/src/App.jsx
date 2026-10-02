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

    const handleLogout = useCallback(() => {
        localStorage.removeItem('token');
        setToken(null);
        setAuthenticated(false);
        setUser(null);
    }, []);

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
                    handleLogout();
                }
            })
            .catch(() => {
                handleLogout();
            })
            .finally(() => {
                setLoading(false);
            });
    }, [handleLogout]);

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
