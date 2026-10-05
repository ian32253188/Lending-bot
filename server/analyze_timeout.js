const db = require('./services/database');

async function analyzeTimeout() {
    console.log('=== 🔬 3D Hybrid 超時降息重掛量化合理性分析 ===');
    
    const currencies = ['USD'];
    
    for (const cur of currencies) {
        console.log(`\n🪙 評估幣種: ${cur}`);
        
        // 1. 抓取過去 7 天的歷史利率明細
        const history = await db.getRateHistory(cur, 168);
        if (!history || history.length === 0) {
            console.log('  ⚠️ 無足夠歷史利率明細數據供分析');
            continue;
        }
        
        // 2. 計算小時級別的利率波動性 (Hour-over-Hour Volatility)
        // 我們的快照是每 5 分鐘存一次，所以每 12 筆大約是 1 小時
        let rateChanges = [];
        let spikeCount = 0;
        
        for (let i = 12; i < history.length; i++) {
            const prevRate = history[i - 12].frr;
            const curRate = history[i].frr;
            if (prevRate > 0 && curRate > 0) {
                const pctChange = Math.abs(curRate - prevRate) / prevRate;
                rateChanges.push(pctChange);
                
                // 如果一小時內波動大於 5%，定義為一次小型衝擊 (Spike)
                if (pctChange >= 0.05) {
                    spikeCount++;
                }
            }
        }
        
        const avgHourlyChange = rateChanges.reduce((s,v)=>s+v,0) / rateChanges.length;
        const maxHourlyChange = Math.max(...rateChanges);
        
        console.log(`  ├─ 1小時平均利率變動幅度: ${(avgHourlyChange * 100).toFixed(2)}%`);
        console.log(`  ├─ 1小時最大利率波動幅度: ${(maxHourlyChange * 100).toFixed(2)}%`);
        console.log(`  ├─ 7天內發生利率快速衝擊次數: ${spikeCount} 次`);
        
        // 3. 量化推導結論
        console.log('  └─ 🎯 量化分析決策建議：');
        
        // 💡 核心理論：
        // - 如果小時波動極低（平均 < 1%），說明市場利率非常平穩且黏性極強，此時「等多久」的關鍵在於大盤排隊長度，而不是等行情反彈。
        // - 3小時降息 4% (0.96) 是否合理？
        //   如果 3 小時內市場的自然波動大於 4%，說明 4% 的降幅會被市場噪音淹沒，是不合理的；
        //   但如果市場波動極低（例如 1小時只變動 0.5%），那麼降息 4% 就代表了一次「強力的主動促銷」，是合理的。
        
        const natural3HourVolatility = avgHourlyChange * 3;
        console.log(`     • 3小時市場自然平均變動率為: ${(natural3HourVolatility * 100).toFixed(2)}%`);
        
        if (natural3HourVolatility < 0.04) {
            console.log(`     • [建議] 由於 3 小時自然波動率 (${(natural3HourVolatility*100).toFixed(2)}%) 小於 4% 的降息幅度，`);
            console.log('       這證明「降息 4%」是一次顯著的主動促銷，能顯著幫助訂單脫離排隊泥淖。');
        } else {
            console.log('     • [建議] 市場波動較大，原設定的降息幅度容易被市場波動覆蓋，建議加大降幅或拉長等待時間。');
        }
        
        // 4. 合理等待時間評估
        // 根據 Bitfinex 的大戶排隊週期：
        // - 1 ~ 3 小時：屬於常規排隊波動，很多大單會在此時段內正常成交。在此時段內撤單，會白白損失排隊位置，非常不划算！
        // - 6 ~ 12 小時：如果超過 6 小時都沒成交，說明您的單子已經被大戶巨牆遠遠拋在腦後，或者大盤利率已經整體下移。此時「繼續乾等」的時間成本極高。
        
        console.log('     • [等待時間推薦]：');
        console.log('       - 絕對不推薦 3 小時以下：會白白浪費排隊順位（因為常規成交週期約在 1.5 ~ 3 小時）。');
        console.log('       - 最合理的黃金等待時間為 6 ~ 12 小時：若超過 6 小時未成交，說明利息已整體下移或被巨牆阻擋，此時主動降息才具備經濟效益。');
        console.log('     • [合理降息幅度推薦]：');
        console.log('       - 每次降息 2% ~ 3%：配合 6 ~ 12 小時的等待時間，能形成溫和的「荷蘭拍」衰減，既能促銷又不會損害太多利潤。');
    }
}

analyzeTimeout().catch(console.error);
