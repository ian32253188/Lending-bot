import { useState, useEffect, useRef } from 'react';

const LEVELS = ['all', 'info', 'warn', 'error'];
const LEVEL_COLORS = { info: 'var(--success)', warn: 'var(--warning)', error: 'var(--danger)', debug: 'var(--text-secondary)' };
const LEVEL_ICONS = { info: '✅', warn: '⚠️', error: '❌', debug: '🔍' };

export default function LogViewer({ token }) {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(false);
    const [levelFilter, setLevelFilter] = useState('all');
    const [keyword, setKeyword] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const bottomRef = useRef(null);

    const fetchLogs = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ limit: 100 });
            if (levelFilter !== 'all') params.set('level', levelFilter);
            if (keyword) params.set('keyword', keyword);

            const res = await fetch(`/api/dashboard/logs?${params}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setLogs(data.reverse()); // 最舊的在上
            }
        } catch (err) {
            console.error('載入日誌失敗:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
        const interval = setInterval(fetchLogs, 10000);
        return () => clearInterval(interval);
    }, [token, levelFilter]);

    useEffect(() => {
        if (autoScroll && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, autoScroll]);

    const handleSearch = (e) => {
        e.preventDefault();
        fetchLogs();
    };

    return (
        <div className="card">
            <div className="card-header">
                <span className="card-title">📝 操作日誌</span>
                <button className="btn btn-outline btn-sm" onClick={fetchLogs} disabled={loading}>
                    {loading ? '⏳' : '🔄'}
                </button>
            </div>

            {/* 篩選列 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                {LEVELS.map(l => (
                    <button
                        key={l}
                        className={`btn btn-sm ${levelFilter === l ? 'btn-primary' : 'btn-ghost'}`}
                        style={levelFilter === l && l !== 'all' ? { color: LEVEL_COLORS[l] } : {}}
                        onClick={() => setLevelFilter(l)}
                    >
                        {l === 'all' ? '全部' : `${LEVEL_ICONS[l]} ${l}`}
                    </button>
                ))}
                <form onSubmit={handleSearch} style={{ display: 'flex', gap: 4, flex: 1, minWidth: 120 }}>
                    <input
                        type="text"
                        className="input-sm"
                        placeholder="搜尋關鍵字..."
                        value={keyword}
                        onChange={e => setKeyword(e.target.value)}
                        style={{ flex: 1, fontSize: '0.8rem', padding: '3px 8px' }}
                    />
                    <button type="submit" className="btn btn-sm btn-ghost">🔍</button>
                </form>
            </div>

            <div style={{ maxHeight: 360, overflowY: 'auto', fontSize: '0.78rem' }}>
                {logs.length === 0 ? (
                    <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: 20 }}>暫無日誌</div>
                ) : (
                    logs.map((log) => (
                        <div className="log-entry" key={log.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--border-dim)' }}>
                            <span style={{ color: 'var(--text-secondary)', flexShrink: 0, marginRight: 6 }}>
                                {new Date(log.created_at).toLocaleTimeString('zh-TW')}
                            </span>
                            <span style={{ color: LEVEL_COLORS[log.level] || 'inherit', flexShrink: 0, width: 54, marginRight: 6 }}>
                                {LEVEL_ICONS[log.level]} {log.level}
                            </span>
                            <span style={{ color: 'var(--accent-blue)', flexShrink: 0, width: 72, marginRight: 6, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                [{log.category}]
                            </span>
                            <span style={{ flex: 1, wordBreak: 'break-word' }}>{log.message}</span>
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>{logs.length} 筆</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                    自動捲動
                </label>
            </div>
        </div>
    );
}
