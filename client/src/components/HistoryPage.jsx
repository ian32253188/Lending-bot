import { useState, useEffect } from 'react';

const TABS = ['Bot 活躍掛單', 'Bot 活躍放貸'];

function formatDate(str) {
    if (!str) return '-';
    return new Date(str).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function StatusBadge({ status }) {
    const colors = {
        active: { bg: '#26d0a333', color: '#26d0a3', label: '進行中' },
        closed: { bg: '#8b8b8b22', color: '#888', label: '已完成' },
    };
    const s = colors[status] || colors.closed;
    return (
        <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 12, fontSize: '0.75rem' }}>
            {s.label}
        </span>
    );
}

export default function HistoryPage({ token }) {
    const [activeTab, setActiveTab] = useState(0);
    const [offers, setOffers] = useState([]);
    const [loans, setLoans] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [dataSource, setDataSource] = useState('');
    const [currencyFilter, setCurrencyFilter] = useState('ALL');

    useEffect(() => {
        fetchData();
    }, []);

    async function fetchData() {
        setLoading(true);
        try {
            const headers = { Authorization: `Bearer ${token}` };
            const [offersRes, loansRes] = await Promise.all([
                fetch('/api/dashboard/history/offers', { headers }),
                fetch('/api/dashboard/history/loans', { headers }),
            ]);
            const [offersData, loansData] = await Promise.all([offersRes.json(), loansRes.json()]);
            if (!offersRes.ok) throw new Error(offersData.error || `掛單記錄讀取失敗（HTTP ${offersRes.status}）`);
            if (!loansRes.ok) throw new Error(loansData.error || `放貸記錄讀取失敗（HTTP ${loansRes.status}）`);
            setOffers(offersData);
            setLoans(loansData);
            setDataSource(offersRes.headers.get('x-data-source') || '資料來源未提供');
            setError('');
        } catch (err) {
            console.error('歷史紀錄載入失敗', err);
            setError(err.message || '歷史紀錄讀取失敗；目前狀態不可用。');
        } finally {
            setLoading(false);
        }
    }

    const currentData = activeTab === 0 ? offers : loans;
    const filteredData = currencyFilter === 'ALL'
        ? currentData
        : currentData.filter(r => r.currency === currencyFilter);

    return (
        <div className="panel">
            <div className="market-note" style={{ marginBottom: 12 }}>
                資料來源：{dataSource || '連線中'}。本頁是資料庫中由 Bot 追蹤的活躍掛單／放貸，不是 Bitfinex 完整帳戶歷史；目前個人部位請看總覽的 Bitfinex 私有 API 狀態。
            </div>
            {error && <div className="market-error" role="alert"><strong>紀錄暫不可用</strong><span>{error}；不代表沒有放貸紀錄。</span><button type="button" className="btn btn-sm btn-outline" onClick={fetchData}>重新載入</button></div>}
            <div className="panel-header">
                <div style={{ display: 'flex', gap: '8px' }}>
                    {TABS.map((t, i) => (
                        <button
                            key={t}
                            className={`btn btn-sm ${activeTab === i ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setActiveTab(i)}
                        >
                            {t}
                        </button>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {['ALL', 'USD', 'USDT'].map(c => (
                        <button
                            key={c}
                            className={`btn btn-sm ${currencyFilter === c ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setCurrencyFilter(c)}
                        >
                            {c}
                        </button>
                    ))}
                    <button className="btn btn-sm btn-ghost" onClick={fetchData}>🔄</button>
                </div>
            </div>

            {loading ? (
                <div className="loading-shimmer" style={{ height: 200, borderRadius: 8 }} />
            ) : error ? null : filteredData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-secondary)' }}>
                    目前資料庫沒有本 Bot 的活躍記錄；這不代表 Bitfinex 帳戶沒有放貸部位。
                </div>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    {activeTab === 0 ? (
                        /* 掛單紀錄 */
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>幣種</th>
                                    <th>金額</th>
                                    <th>日利率</th>
                                    <th>年化</th>
                                    <th>期限</th>
                                    <th>狀態</th>
                                    <th>建立時間</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredData.map(row => (
                                    <tr key={row.id || row.offer_id}>
                                        <td><span className="badge">{row.currency}</span></td>
                                        <td>{row.amount?.toFixed(2)}</td>
                                        <td>{row.rate ? `${(row.rate * 100).toFixed(4)}%` : '-'}</td>
                                        <td>{row.rate ? `${(row.rate * 365 * 100).toFixed(2)}%` : '-'}</td>
                                        <td>{row.period}天</td>
                                        <td><StatusBadge status={row.status} /></td>
                                        <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                            {formatDate(row.created_at)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        /* 放貸紀錄 */
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>幣種</th>
                                    <th>金額</th>
                                    <th>日利率</th>
                                    <th>年化</th>
                                    <th>期限</th>
                                    <th>利息</th>
                                    <th>狀態</th>
                                    <th>開始時間</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredData.map(row => (
                                    <tr key={row.id || row.loan_id}>
                                        <td><span className="badge">{row.currency}</span></td>
                                        <td>{row.amount?.toFixed(2)}</td>
                                        <td>{row.rate ? `${(row.rate * 100).toFixed(4)}%` : '-'}</td>
                                        <td>{row.rate ? `${(row.rate * 365 * 100).toFixed(2)}%` : '-'}</td>
                                        <td>{row.period}天</td>
                                        <td style={{ color: row.interest_earned > 0 ? 'var(--success)' : 'inherit' }}>
                                            {row.interest_earned ? `+${row.interest_earned.toFixed(6)}` : '-'}
                                        </td>
                                        <td><StatusBadge status={row.status} /></td>
                                        <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                            {formatDate(row.opened_at)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}
