import { useState, useEffect, useRef, useCallback } from 'react';

export function useWebSocket(token) {
    const [status, setStatus] = useState(null);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef(null);
    const reconnectTimer = useRef(null);

    const refresh = useCallback(async () => {
        if (!token) return null;
        try {
            const response = await fetch('/api/dashboard/overview', {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!response.ok) return null;
            const data = await response.json();
            setStatus(data);
            return data;
        } catch (err) {
            console.error('Dashboard status refresh failed:', err);
            return null;
        }
    }, [token]);

    const connect = useCallback(() => {
        if (!token) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'auth', token }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case 'auth':
                        if (msg.status === 'ok') {
                            setConnected(true);
                        }
                        break;
                    case 'status':
                        setStatus(msg.data);
                        break;
                    case 'detailed':
                        setStatus((prev) => ({ ...prev, ...msg.data }));
                        break;
                }
            } catch (err) {
                console.error('WS parse error:', err);
            }
        };

        ws.onclose = () => {
            setConnected(false);
            reconnectTimer.current = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
            ws.close();
        };

        wsRef.current = ws;
    }, [token]);

    useEffect(() => {
        refresh();
        connect();
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        };
    }, [connect, refresh]);

    const send = useCallback((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
        }
    }, []);

    return { status, connected, send, refresh };
}
