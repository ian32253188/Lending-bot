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

const NAV_ITEMS = [
    { key: 'overview', icon: '📊', label: '總覽' },
    { key: 'analytics', icon: '📈', label: '圖表' },
    { key: 'history', icon: '📋', label: '歷史' },
    { key: 'settings', icon: '⚙️', label: '設定' },
    { key: 'logs', icon: '📝', label: '日誌' },
];

export default function Dashboard({ status, connected, token, onLogout, onRefresh }) {
    const [activePage, setActivePage] = useState('overview');

    const isRunning = status?.running;
    const isPaused = status?.paused;

    // 強化狀態顯示
    let engineStatusLabel = '⛹️ 放貸停止';
    let engineStatusClass = 'disconnected';
    
    if (isRunning) {
        if (isPaused) {
            engineStatusLabel = '⛸️ 放貸暂停';
            engineStatusClass = 'paused';
        } else {
            engineStatusLabel = '🟢 放貸中';
            engineStatusClass = 'connected';
        }
    }

    return (
        <div className="app-layout">
            {/* Header */}
            <header className="app-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className="logo">⚡ Lending Bot</span>
                    {/* 桌機版導航 */}
                    <nav className="header-nav">
                        {NAV_ITEMS.map(item => (
                            <button
                                key={item.key}
                                className={`nav-btn ${activePage === item.key ? 'nav-btn-active' : ''}`}
                                onClick={() => setActivePage(item.key)}
                            >
                                {item.icon} {item.label}
                            </button>
                        ))}
                    </nav>
                </div>
                <div className="header-controls">
                    <div className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
                        <div className="connection-dot"></div>
                        {connected ? 'WS 連線' : '離線'}
                    </div>
                    <div className={`connection-badge ${engineStatusClass}`} title="放貸引擎狀態">
                        {engineStatusLabel}
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
                        onClick={() => setActivePage(item.key)}
                    >
                        <span style={{ fontSize: '1.2rem' }}>{item.icon}</span>
                        <span style={{ fontSize: '0.7rem' }}>{item.label}</span>
                    </button>
                ))}
            </nav>

            {/* Main Content */}
            <main className="main-content">

                {/* 總覽頁 */}
                {activePage === 'overview' && (
                    <>
                        <div className="section">
                            <StatusPanel status={status} />
                        </div>
                        <div className="section">
                            <FundingMarketDashboard token={token} />
                        </div>
                        <div className="section">
                            <EarningsPanel token={token} />
                        </div>
                        <div className="grid grid-2 section">
                            <StrategyPanel status={status} token={token} onRefresh={onRefresh} />
                            <LogViewer token={token} />
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
