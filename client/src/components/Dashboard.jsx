import { useState } from 'react';
import StatusPanel from './StatusPanel';
import StrategyPanel from './StrategyPanel';
import LogViewer from './LogViewer';
import EarningsPanel from './EarningsPanel';
import RateChart from './RateChart';
import HeatmapView from './HeatmapView';
import HistoryPage from './HistoryPage';
import SettingsPanel from './SettingsPanel';
import FundingMarketDashboard from './FundingMarketDashboard';
import { getEngineBadge } from './engine-status';

const NAV_ITEMS = [
    { key: 'overview', label: '總覽' },
    { key: 'analytics', label: '圖表' },
    { key: 'history', label: '歷史' },
    { key: 'settings', label: '設定' },
    { key: 'logs', label: '日誌' },
];

export default function Dashboard({ status, connected, token, onLogout, onRefresh }) {
    const [activePage, setActivePage] = useState('overview');

    const engineBadge = getEngineBadge(status);

    return (
        <div className="app-layout">
            {/* Header */}
            <header className="app-header">
                <div className="brand-block">
                    <span className="brand-mark">LB</span>
                    <div>
                        <span className="logo">Lending Bot</span>
                    </div>
                    {/* 桌機版導航 */}
                    <nav className="header-nav">
                        {NAV_ITEMS.map(item => (
                            <button
                                key={item.key}
                                className={`nav-btn ${activePage === item.key ? 'nav-btn-active' : ''}`}
                                aria-current={activePage === item.key ? 'page' : undefined}
                                onClick={() => setActivePage(item.key)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </nav>
                </div>
                <div className="header-controls">
                    <div className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
                        <div className="connection-dot"></div>
                        {connected ? 'WS 連線' : '離線'}
                    </div>
                    <div className={`connection-badge ${engineBadge.className}`} title={engineBadge.title}>
                        {engineBadge.label}
                    </div>
                    <button className="btn btn-outline btn-sm" onClick={onLogout}>登出</button>
                </div>
            </header>

            {/* 手機版底部導航 */}
            <nav className="mobile-nav">
                {NAV_ITEMS.map(item => (
                    <button
                        key={item.key}
                        className={`mobile-nav-btn ${activePage === item.key ? 'mobile-nav-btn-active' : ''}`}
                        aria-current={activePage === item.key ? 'page' : undefined}
                        onClick={() => setActivePage(item.key)}
                    >
                        <span>{item.label}</span>
                    </button>
                ))}
            </nav>

            {/* Main Content */}
            <main className="main-content">

                <div className="workspace-heading">
                    <h1>{NAV_ITEMS.find(item => item.key === activePage)?.label || '總覽'}</h1>
                </div>

                {/* 總覽頁 */}
                {activePage === 'overview' && (
                    <>
                        <div className="section">
                            <div className="dashboard-top-summary">
                                <StatusPanel status={status} />
                                <EarningsPanel token={token} embedded />
                            </div>
                        </div>
                        <div className="grid grid-2 section">
                            <StrategyPanel status={status} token={token} onRefresh={onRefresh} />
                            <LogViewer token={token} />
                        </div>
                        <div className="section">
                            <FundingMarketDashboard token={token} />
                        </div>
                    </>
                )}

                {/* 圖表分析頁 */}
                {activePage === 'analytics' && (
                    <>
                        <div className="section">
                            <RateChart token={token} />
                        </div>
                        <div className="section">
                            <HeatmapView token={token} />
                        </div>
                    </>
                )}

                {/* 歷史紀錄頁 */}
                {activePage === 'history' && (
                    <div className="section">
                        <HistoryPage token={token} />
                    </div>
                )}

                {/* 設定頁 */}
                {activePage === 'settings' && (
                    <div className="section">
                        <SettingsPanel token={token} />
                    </div>
                )}

                {/* 日誌頁 */}
                {activePage === 'logs' && (
                    <div className="section" style={{ maxWidth: '100%' }}>
                        <LogViewer token={token} fullPage />
                    </div>
                )}

            </main>
        </div>
    );
}
