import { useState, useEffect } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
    const [token, setToken] = useState(localStorage.getItem('token'));
    const [authenticated, setAuthenticated] = useState(false);
    const { status, connected } = useWebSocket(authenticated ? token : null);

    // 驗證已儲存的 token
    useEffect(() => {
        if (token) {
            fetch('/api/auth/verify', {
                headers: { 'Authorization': `Bearer ${token}` },
            })
                .then((res) => {
                    if (res.ok) {
                        setAuthenticated(true);
                    } else {
                        handleLogout();
                    }
                })
                .catch(() => handleLogout());
        }
    }, [token]);

    const handleLogin = (newToken) => {
        setToken(newToken);
        setAuthenticated(true);
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        setToken(null);
        setAuthenticated(false);
    };

    if (!authenticated) {
        return <Login onLogin={handleLogin} />;
    }

    const refreshStatus = () => {
        // 觸發 WebSocket 重新抓取狀態
        if (token) {
            fetch('/api/dashboard/overview', {
                headers: { Authorization: `Bearer ${token}` },
            }).catch(() => { });
        }
    };

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
