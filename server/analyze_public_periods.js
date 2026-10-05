// 使用 Node v20 原生 global fetch

async function analyzePublicPeriods() {
    console.log('=== 📊 Bitfinex 實體市場最新成交期限分佈分析 ===');
    console.log('時間:', new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));

    const symbols = {
        'USD': 'fUSD'
    };

    for (const [name, sym] of Object.entries(symbols)) {
        console.log(`\n🪙 查詢幣種: ${name} (${sym})`);
        
        try {
            const url = `https://api-pub.bitfinex.com/v2/trades/${sym}/hist?limit=500`;
            const res = await fetch(url);
            if (!res.ok) {
                console.error(`  ❌ 無法從 Bitfinex API 獲取數據 (${res.status})`);
                continue;
            }
            
            const trades = await res.json();
            if (!Array.isArray(trades) || trades.length === 0) {
                console.log('  ⚠️ 無成交數據');
                continue;
            }

            // Bitfinex 公開 funding trades 格式:
            // [ [ ID, MTS, AMOUNT, RATE, PERIOD ], ... ]
            // 索引 4 是 PERIOD
            
            let periodCounts = {};
            let totalAmountPerPeriod = {};
            let rateSumPerPeriod = {};
            
            let totalTrades = 0;

            for (const trade of trades) {
                if (!Array.isArray(trade) || trade.length < 5) continue;
                
                const amount = Math.abs(trade[2]);
                const rate = trade[3];
                const period = trade[4]; // 期限天數

                periodCounts[period] = (periodCounts[period] || 0) + 1;
                totalAmountPerPeriod[period] = (totalAmountPerPeriod[period] || 0) + amount;
                rateSumPerPeriod[period] = (rateSumPerPeriod[period] || 0) + (rate * amount);
                
                totalTrades++;
            }

            console.log(`  ├─ 分析近 ${totalTrades} 筆市場真實成交記錄:`);
            
            // 排序期限並列印分佈
            const sortedPeriods = Object.keys(periodCounts).map(Number).sort((a,b) => a - b);
            
            for (const period of sortedPeriods) {
                const count = periodCounts[period];
                const percentage = (count / totalTrades * 100).toFixed(1);
                const avgRate = rateSumPerPeriod[period] / totalAmountPerPeriod[period];
                const totalVol = totalAmountPerPeriod[period];
                
                console.log(`  │   • [${period} 天期] 成交筆數: ${count} 筆 (${percentage}%) | 平均年息: ${(avgRate * 365 * 100).toFixed(2)}% | 總成交量: $${totalVol.toLocaleString(undefined, {maximumFractionDigits: 0})} USD`);
            }
            
            // 計算集中點
            const sortedByCount = [...sortedPeriods].sort((a,b) => periodCounts[b] - periodCounts[a]);
            console.log(`  └─ 🎯 結論: ${name} 的成交期限極度集中在 【${sortedByCount[0]} 天】 (佔 ${((periodCounts[sortedByCount[0]]/totalTrades)*100).toFixed(1)}%)`);
            
        } catch (err) {
            console.error(`  ❌ 執行分析出錯 (${name}):`, err.message);
        }
    }
}

analyzePublicPeriods().catch(console.error);
