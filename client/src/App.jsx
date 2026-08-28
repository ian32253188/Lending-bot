import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
    const [supabase, setSupabase] = useState(null);
    const [token, setToken] = useState(localStorage.getItem('token'));
    const [authenticated, setAuthenticated] = useState(false);
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const { status, connected, refresh: refreshStatus } = useWebSocket(authenticated ? token : null);

    // 1. 初始化 Supabase Client 與監聽 Session 變更
    useEffect(() => {
        fetch('/api/auth/config')
            .then((res) => res.json())
            .then((data) => {
                const client = createClient(data.supabaseUrl, data.supabaseAnonKey);
                setSupabase(client);

                // 訂閱 Auth 狀態改變 (e.g. Google OAuth 登入成功重導向)
                client.auth.onAuthStateChange((event, session) => {
                    if (session) {
                        const jwtToken = session.access_token;
                        localStorage.setItem('token', jwtToken);
                        setToken(jwtToken);
                        setAuthenticated(true);
                        setUser(session.user);
                    } else {
                        handleLogoutInternal();
                    }
                    setLoading(false);
                });

                // 嘗試取得當前 Session
                client.auth.getSession().then(({ data: { session } }) => {
                    if (session) {
                        const jwtToken = session.access_token;
                        localStorage.setItem('token', jwtToken);
                        setToken(jwtToken);
                        setAuthenticated(true);
                        setUser(session.user);
                    }
                    setLoading(false);
                });
            })
            .catch((err) => {
                console.error('無法從伺服器取得 Supabase 設定：', err);
                setLoading(false);
            });
    }, []);

    const handleLogoutInternal = () => {
        localStorage.removeItem('token');
        setToken(null);
        setAuthenticated(false);
        setUser(null);
    };

    const handleLogout = async () => {
        handleLogoutInternal();
        if (supabase) {
            await supabase.auth.signOut();
        }
    };

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
        return <Login supabase={supabase} />;
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
