import { useState, useEffect, useRef, useCallback } from 'react';

export function useWebSocket(token) {
    const [status, setStatus] = useState(null);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef(null);
    const reconnectTimer = useRef(null);
    const generationRef = useRef(0);

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

    useEffect(() => {
        const generation = ++generationRef.current;
        let reconnectAllowed = true;
        const connect = () => {
            if (!token || generationRef.current !== generation) return;

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws`;
            const ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                if (generationRef.current === generation) ws.send(JSON.stringify({ type: 'auth', token }));
            };

            ws.onmessage = (event) => {
                if (generationRef.current !== generation) return;
                try {
                    const msg = JSON.parse(event.data);
                    switch (msg.type) {
                        case 'auth':
                            if (msg.status === 'ok') setConnected(true);
                            if (msg.status === 'revoked') {
                                reconnectAllowed = false;
                                window.dispatchEvent(new Event('lending-session-revoked'));
                                ws.close(4001, 'Session revoked');
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

            ws.onclose = (event) => {
                if (generationRef.current !== generation) return;
                setConnected(false);
                if (event.code === 4001) {
                    reconnectAllowed = false;
                    window.dispatchEvent(new Event('lending-session-revoked'));
                    return;
                }
                if (!reconnectAllowed) return;
                // 1008 also represents temporary auth timeouts and capacity
                // limits. Keep the token and wait longer before retrying so a
                // failed socket does not clear a valid REST session or churn slots.
                reconnectTimer.current = setTimeout(connect, event.code === 1008 ? 10000 : 3000);
            };

            ws.onerror = () => ws.close();
            wsRef.current = ws;
        };

        refresh();
        connect();
        return () => {
            if (generationRef.current === generation) generationRef.current += 1;
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            if (wsRef.current) {
                const activeSocket = wsRef.current;
                wsRef.current = null;
                activeSocket.close();
            }
            setConnected(false);
        };
    }, [token, refresh]);

    const send = useCallback((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
        }
    }, []);

    return { status, connected, send, refresh };
}
