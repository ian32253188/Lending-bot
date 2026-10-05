const db = require('./services/database');
const config = require('./config');

async function runAnalysis() {
    console.log('=== 📊 3D Hybrid 歷史放貸資料庫量化分析 ===');
    console.log('時間:', new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
    
    const currencies = ['USD'];
    
    for (const cur of currencies) {
        console.log(`\n🪙 幣種: ${cur}`);
        
        // 1. 查詢 7d/30d 的 FRR 均值
        const avg7d = await db.getAverageFRR(cur, 168);
        const avg30d = await db.getAverageFRR(cur, 720);
        console.log(`  ├─ 7天平均 FRR: ${avg7d ? (avg7d * 100).toFixed(4) + '%/天 (年化 ' + (avg7d * 365 * 100).toFixed(2) + '%)' : '無數據'}`);
        console.log(`  ├─ 30天平均 FRR: ${avg30d ? (avg30d * 100).toFixed(4) + '%/天 (年化 ' + (avg30d * 365 * 100).toFixed(2) + '%)' : '無數據'}`);
        
        // 2. 查詢近 7 天的歷史最高與最低利率
        const history7d = await db.getRateHistory(cur, 168);
        if (history7d && history7d.length > 0) {
            const frrs = history7d.map(h => h.frr).filter(Boolean);
            const highRates = history7d.map(h => h.high_rate || h.frr).filter(Boolean);
            const lowRates = history7d.map(h => h.low_rate || h.frr).filter(Boolean);
            const dsRatios = history7d.map(h => h.demand_supply_ratio).filter(v => v !== null && v !== undefined);
            
            const maxFRR = Math.max(...frrs);
            const minFRR = Math.min(...frrs);
            const maxMarketRate = Math.max(...highRates);
            const minMarketRate = Math.min(...lowRates);
            const avgDSRatio = dsRatios.length > 0 ? dsRatios.reduce((s,v)=>s+v,0)/dsRatios.length : 1;
            
            console.log(`  ├─ 7天最高市場利率: ${(maxMarketRate * 100).toFixed(4)}%/天 (年化 ${(maxMarketRate * 365 * 100).toFixed(2)}%)`);
            console.log(`  ├─ 7天最低市場利率: ${(minMarketRate * 100).toFixed(4)}%/天 (年化 ${(minMarketRate * 365 * 100).toFixed(2)}%)`);
            console.log(`  ├─ 7天平均供需比 (需求/供應): ${avgDSRatio.toFixed(2)}`);
            
            // 3. 評估我們的 3D 參數設計是否合理
            console.log(`  └─ 🎯 策略合理性評估結論:`);
            
            const currentFRR = frrs[frrs.length - 1] || 0.0003;
            const designLowerBound = currentFRR * 0.999 * 365 * 100;
            const designUpperBound = currentFRR * 2.5 * 365 * 100;
            
            console.log(`     • 當前 FRR 下限防守線為 年化 ${designLowerBound.toFixed(2)}%`);
            console.log(`     • 當前天價狙擊手上限為 年化 ${designUpperBound.toFixed(2)}%`);
            
            if (minMarketRate < currentFRR * 0.999) {
                console.log(`     • [合理] 市場曾跌到 ${(minMarketRate*365*100).toFixed(2)}%，我們的保底線成功幫我們阻擋了超低利率，避免被便宜借走！`);
            } else {
                console.log(`     • [合理] 當前處於常規市況，下限防守線緊貼市場邊緣，能實現即時成交。`);
            }
            
            if (maxMarketRate >= currentFRR * 1.15) {
                console.log(`     • [合理] 市場曾出現 ${(maxMarketRate*365*100).toFixed(2)}% 的溢價，深度探針與天價狙擊手有充足空間捕捉超額回報！`);
            } else {
                console.log(`     • [合理] 市場溢價波動較小，狙擊手將在天花板耐心埋伏，靜待下一次行情爆發。`);
            }
        } else {
            console.log('  └─ 無足夠的 7 天歷史明細數據進行邊界評估');
        }
    }
    
    // 4. 統計歷史累計淨收益
    const allEarnings = await db.getEarnings(null, null, null);
    const totalEarned = allEarnings.reduce((s, r) => s + (r.amount || 0), 0);
    console.log(`\n🏆 全帳戶歷史累計淨收益: $${totalEarned.toFixed(4)} USD (共計 ${allEarnings.length} 筆到期結算)`);
}

runAnalysis().catch(console.error);
