require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('./services/database');

const BITFINEX_API = 'https://api-pub.bitfinex.com/v2';

// ==================== Utility ====================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);
    return res.json();
}

// ==================== 1. 市場公開數據分析 ====================
async function analyzeMarket() {
    console.log('\n' + '═'.repeat(70));
    console.log('  📊 第一部分：Bitfinex 即時市場狀態分析');
    console.log('═'.repeat(70));

    const symbols = { 'USD': 'fUSD', 'USDT': 'fUST' };

    for (const [name, sym] of Object.entries(symbols)) {
        console.log(`\n┌─────────────────────────────────────────`);
        console.log(`│ 🪙 ${name} 市場分析`);
        console.log(`├─────────────────────────────────────────`);

        try {
            // 1a. Ticker 資料
            const ticker = await fetchJSON(`${BITFINEX_API}/ticker/${sym}`);
            // [FRR, BID, BID_SIZE, BID_PERIOD, ASK, ASK_SIZE, ASK_PERIOD,
            //  DAILY_CHANGE, DAILY_CHANGE_RELATIVE, LAST_PRICE, VOLUME, HIGH, LOW, ...]
            const frr = ticker[0];
            const bid = ticker[1];
            const ask = ticker[4];
            const volume = ticker[10];
            const high = ticker[11];
            const low = ticker[12];

            console.log(`│ FRR (即時參考利率): ${(frr * 100).toFixed(4)}%/天 (年化 ${(frr * 365 * 100).toFixed(2)}%)`);
            console.log(`│ Best Bid: ${(bid * 100).toFixed(4)}%/天 | Best Ask: ${(ask * 100).toFixed(4)}%/天`);
            console.log(`│ Bid-Ask Spread: ${((ask - bid) * 100).toFixed(4)}%`);
            console.log(`│ 24h High: ${(high * 100).toFixed(4)}% | Low: ${(low * 100).toFixed(4)}%`);
            console.log(`│ 24h Volume: $${volume?.toLocaleString(undefined, {maximumFractionDigits: 0}) || 'N/A'}`);
            console.log(`│ 24h 波動幅度: ${(((high - low) / frr) * 100).toFixed(2)}% (相對 FRR)`);

            await sleep(1500);

            // 1b. Order Book 深度
            const book = await fetchJSON(`${BITFINEX_API}/book/${sym}/P0?len=100`);
            let totalBidVol = 0, totalAskVol = 0;
            const bids = [], asks = [];
            for (const entry of book) {
                const [rate, period, count, amount] = entry;
                if (amount > 0) {
                    bids.push({ rate, amount });
                    totalBidVol += amount;
                } else {
                    asks.push({ rate, amount: Math.abs(amount) });
                    totalAskVol += Math.abs(amount);
                }
            }
            bids.sort((a, b) => b.rate - a.rate);
            asks.sort((a, b) => a.rate - b.rate);

            const dsRatio = totalAskVol > 0 ? totalBidVol / totalAskVol : 999;
            console.log(`│`);
            console.log(`│ 📚 訂單簿深度分析:`);
            console.log(`│   需求方 (Bids): $${totalBidVol.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
            console.log(`│   供給方 (Asks): $${totalAskVol.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
            console.log(`│   供需比 (需求/供給): ${dsRatio.toFixed(3)}`);

            // 阻力牆檢測
            let wallDetected = false;
            for (const a of asks) {
                const pct = a.amount / totalAskVol;
                if (pct > 0.20) {
                    console.log(`│   ⚠️ 阻力牆偵測: ${(a.rate * 100).toFixed(4)}%/天 有 $${a.amount.toLocaleString(undefined, {maximumFractionDigits: 0})} (佔供給 ${(pct * 100).toFixed(1)}%)`);
                    wallDetected = true;
                }
            }
            if (!wallDetected) {
                console.log(`│   ✅ 未偵測到阻力牆 (供給側集中度 < 20%)`);
            }

            // 模擬瓦爾拉斯出清
            let cumSupply = 0;
            let equilibriumRate = asks[0]?.rate || frr;
            for (const a of asks) {
                cumSupply += a.amount;
                if (cumSupply >= totalBidVol) {
                    equilibriumRate = a.rate;
                    break;
                }
                equilibriumRate = a.rate;
            }
            console.log(`│   🎯 瓦爾拉斯出清均衡價格: ${(equilibriumRate * 100).toFixed(4)}%/天 (年化 ${(equilibriumRate * 365 * 100).toFixed(2)}%)`);

            // 策略對齊評估
            console.log(`│`);
            console.log(`│ 🧠 你的 3D Hybrid 策略在當前市場的表現預測:`);
            const gridLow = frr * 0.999;
            const gridHigh = frr * 1.12;
            const depthRate = Math.max(frr * 1.05, Math.min(asks.length > 0 ? asks[Math.min(Math.floor(asks.length * 0.15), asks.length - 1)].rate : frr * 1.15, 0.005));
            const cascadeRate = Math.min(frr * 2.5, 0.008);

            console.log(`│   底倉區間 (60%): ${(gridLow * 100).toFixed(4)}% ~ ${(gridHigh * 100).toFixed(4)}%/天`);
            console.log(`│   深度探針 (20%): ${(depthRate * 100).toFixed(4)}%/天`);
            console.log(`│   天價探針 (20%): ${(cascadeRate * 100).toFixed(4)}%/天`);

            if (dsRatio > 1.5) {
                console.log(`│   📈 【需求旺盛】供需比 ${dsRatio.toFixed(2)}，天價探針有較高成交概率！`);
            } else if (dsRatio < 0.7) {
                console.log(`│   📉 【供給過剩】供需比 ${dsRatio.toFixed(2)}，建議底倉利率貼近 FRR 加速成交`);
            } else {
                console.log(`│   ⚖️ 【均衡市場】供需比 ${dsRatio.toFixed(2)}，底倉穩健策略最佳化`);
            }

            await sleep(1500);

            // 1c. 成交期限分佈
            const trades = await fetchJSON(`${BITFINEX_API}/trades/${sym}/hist?limit=500`);
            const periodCounts = {}, periodAmounts = {}, periodRates = {};
            let totalTrades = 0;
            for (const t of trades) {
                if (!Array.isArray(t) || t.length < 5) continue;
                const amount = Math.abs(t[2]);
                const rate = t[3];
                const period = t[4];
                periodCounts[period] = (periodCounts[period] || 0) + 1;
                periodAmounts[period] = (periodAmounts[period] || 0) + amount;
                periodRates[period] = (periodRates[period] || 0) + rate * amount;
                totalTrades++;
            }

            console.log(`│`);
            console.log(`│ 📅 近 ${totalTrades} 筆成交的期限分佈:`);
            const sortedPeriods = Object.keys(periodCounts).map(Number).sort((a, b) => periodCounts[b] - periodCounts[a]);
            for (const p of sortedPeriods.slice(0, 8)) {
                const cnt = periodCounts[p];
                const pct = (cnt / totalTrades * 100).toFixed(1);
                const avgR = periodRates[p] / periodAmounts[p];
                console.log(`│   ${p}天: ${cnt}筆 (${pct}%) | 加權平均年化 ${(avgR * 365 * 100).toFixed(2)}% | 成交量 $${periodAmounts[p].toLocaleString(undefined, {maximumFractionDigits: 0})}`);
            }

            const topPeriod = sortedPeriods[0];
            console.log(`│   🎯 市場主流期限: ${topPeriod} 天 (佔 ${((periodCounts[topPeriod] / totalTrades) * 100).toFixed(1)}%)`);

        } catch (err) {
            console.log(`│ ❌ 市場分析失敗: ${err.message}`);
        }

        console.log(`└─────────────────────────────────────────`);
        await sleep(1500);
    }
}

// ==================== 2. 資料庫歷史分析 ====================
async function analyzeDatabase() {
    const supabase = db.getSupabase();
    if (!supabase) {
        console.log('\n⚠️ Supabase 未連接（.env 中未提供 SUPABASE_URL / SUPABASE_KEY），跳過資料庫歷史分析。');
        console.log('   請將 .env 檔案放入專案根目錄後重試。');
        return false;
    }

    console.log('\n' + '═'.repeat(70));
    console.log('  📈 第二部分：Supabase 歷史資料庫深度分析');
    console.log('═'.repeat(70));

    // ---- 2a. 收益分析 ----
    console.log('\n┌─────────────────────────────────────────');
    console.log('│ 💰 收益統計分析');
    console.log('├─────────────────────────────────────────');

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30);

    const [todayE, yesterdayE, weekE, monthE, allE] = await Promise.all([
        db.getEarnings(null, todayStart.toISOString(), null),
        db.getEarnings(null, yesterdayStart.toISOString(), todayStart.toISOString()),
        db.getEarnings(null, weekAgo.toISOString(), null),
        db.getEarnings(null, monthAgo.toISOString(), null),
        db.getEarnings(null, null, null),
    ]);

    const sum = (arr) => arr.reduce((s, r) => s + (r.amount || 0), 0);
    const todaySum = sum(todayE);
    const yesterdaySum = sum(yesterdayE);
    const weekSum = sum(weekE);
    const monthSum = sum(monthE);
    const allSum = sum(allE);

    console.log(`│ 今日收益: $${todaySum.toFixed(4)} USD (${todayE.length} 筆)`);
    console.log(`│ 昨日收益: $${yesterdaySum.toFixed(4)} USD (${yesterdayE.length} 筆)`);
    if (yesterdaySum > 0) {
        const chg = ((todaySum - yesterdaySum) / yesterdaySum * 100).toFixed(1);
        console.log(`│ 日環比: ${chg > 0 ? '+' : ''}${chg}%`);
    }
    console.log(`│ 7天累計: $${weekSum.toFixed(4)} USD (${weekE.length} 筆)`);
    console.log(`│ 30天累計: $${monthSum.toFixed(4)} USD (${monthE.length} 筆)`);
    console.log(`│ 歷史總收益: $${allSum.toFixed(4)} USD (${allE.length} 筆)`);

    // 日均收益
    if (allE.length > 0) {
        const firstDate = new Date(allE[allE.length - 1].earned_at);
        const daysSinceStart = Math.max(1, (now - firstDate) / (1000 * 60 * 60 * 24));
        const dailyAvg = allSum / daysSinceStart;
        console.log(`│ 日均收益: $${dailyAvg.toFixed(4)} USD (運行 ${daysSinceStart.toFixed(1)} 天)`);
    }

    // 各幣種分拆
    for (const cur of ['USD', 'USDT']) {
        const curE = allE.filter(e => e.currency === cur);
        if (curE.length > 0) {
            const curSum = sum(curE);
            const avgRate = curE.reduce((s, e) => s + (e.rate || 0), 0) / curE.length;
            const avgPeriod = curE.reduce((s, e) => s + (e.period || 0), 0) / curE.length;
            console.log(`│ ${cur}: 累計 $${curSum.toFixed(4)} | ${curE.length}筆 | 平均利率 ${(avgRate * 100).toFixed(4)}%/天 (年化 ${(avgRate * 365 * 100).toFixed(2)}%) | 平均期限 ${avgPeriod.toFixed(1)}天`);
        }
    }
    console.log('└─────────────────────────────────────────');

    // ---- 2b. 放貸合約分析 ----
    console.log('\n┌─────────────────────────────────────────');
    console.log('│ 📋 放貸合約分析');
    console.log('├─────────────────────────────────────────');

    for (const cur of ['USD', 'USDT']) {
        const activeLoans = await db.getActiveLoans(cur);
        if (activeLoans.length > 0) {
            const totalLent = activeLoans.reduce((s, l) => s + (l.amount || 0), 0);
            const avgRate = activeLoans.reduce((s, l) => s + (l.rate || 0), 0) / activeLoans.length;
            const avgPeriod = activeLoans.reduce((s, l) => s + (l.period || 0), 0) / activeLoans.length;
            const minRate = Math.min(...activeLoans.map(l => l.rate || 0));
            const maxRate = Math.max(...activeLoans.map(l => l.rate || 0));

            console.log(`│ ${cur} 活躍放貸: ${activeLoans.length} 筆 | 總額 $${totalLent.toFixed(2)}`);
            console.log(`│   利率: ${(minRate * 100).toFixed(4)}% ~ ${(maxRate * 100).toFixed(4)}%/天 (平均 ${(avgRate * 100).toFixed(4)}%, 年化 ${(avgRate * 365 * 100).toFixed(2)}%)`);
            console.log(`│   平均期限: ${avgPeriod.toFixed(1)} 天`);

            // 利率分佈直方圖
            const ranges = {};
            for (const l of activeLoans) {
                const annualized = Math.floor(l.rate * 365 * 100);
                const bucket = `${annualized}%-${annualized + 1}%`;
                ranges[bucket] = (ranges[bucket] || 0) + 1;
            }
            console.log(`│   利率分佈: ${Object.entries(ranges).map(([k, v]) => `${k}(${v}筆)`).join(' | ')}`);
        } else {
            console.log(`│ ${cur}: 無活躍放貸合約`);
        }

        const activeOffers = await db.getActiveOffers(cur);
        if (activeOffers.length > 0) {
            console.log(`│ ${cur} 掛單中: ${activeOffers.length} 筆`);
            for (const o of activeOffers.slice(0, 5)) {
                const age = ((now - new Date(o.created_at)) / 3600000).toFixed(1);
                console.log(`│   #${o.offer_id}: $${o.amount} @ ${(o.rate * 100).toFixed(4)}%/天 (年化 ${(o.rate * 365 * 100).toFixed(2)}%) | 期限 ${o.period}天 | 已掛 ${age}h`);
            }
        }
    }
    console.log('└─────────────────────────────────────────');

    // ---- 2c. 利率歷史與 IBRR 趨勢 ----
    console.log('\n┌─────────────────────────────────────────');
    console.log('│ 📉 利率歷史趨勢分析 (7 天)');
    console.log('├─────────────────────────────────────────');

    for (const cur of ['USD', 'USDT']) {
        const history = await db.getRateHistory(cur, 168);
        if (!history || history.length < 10) {
            console.log(`│ ${cur}: 歷史數據不足 (${history?.length || 0} 筆)`);
            continue;
        }

        const frrs = history.map(h => h.frr).filter(Boolean);
        const volumes = history.map(h => h.volume).filter(Boolean);
        const dsRatios = history.map(h => h.demand_supply_ratio).filter(v => v != null);

        const avg7d = frrs.reduce((s, v) => s + v, 0) / frrs.length;
        const maxFRR = Math.max(...frrs);
        const minFRR = Math.min(...frrs);
        const latestFRR = frrs[frrs.length - 1];
        const stdDev = Math.sqrt(frrs.reduce((s, v) => s + Math.pow(v - avg7d, 2), 0) / frrs.length);

        console.log(`│ ${cur} 7天 FRR 統計:`);
        console.log(`│   平均: ${(avg7d * 100).toFixed(4)}%/天 (年化 ${(avg7d * 365 * 100).toFixed(2)}%)`);
        console.log(`│   最新: ${(latestFRR * 100).toFixed(4)}%/天 (年化 ${(latestFRR * 365 * 100).toFixed(2)}%)`);
        console.log(`│   最高: ${(maxFRR * 100).toFixed(4)}%/天 (年化 ${(maxFRR * 365 * 100).toFixed(2)}%)`);
        console.log(`│   最低: ${(minFRR * 100).toFixed(4)}%/天 (年化 ${(minFRR * 365 * 100).toFixed(2)}%)`);
        console.log(`│   標準差: ${(stdDev * 100).toFixed(4)}% (波動率指標)`);

        // 趨勢判斷
        const recent = frrs.slice(-24); // 最近 ~2 小時
        const earlier = frrs.slice(-48, -24); // 倒數 2~4 小時
        if (earlier.length > 0 && recent.length > 0) {
            const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
            const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;
            const trendPct = ((recentAvg - earlierAvg) / earlierAvg * 100).toFixed(2);
            const trend = recentAvg > earlierAvg * 1.02 ? '📈 上升中' : recentAvg < earlierAvg * 0.98 ? '📉 下降中' : '➡️ 持平';
            console.log(`│   短期趨勢: ${trend} (近期 vs 稍早: ${trendPct > 0 ? '+' : ''}${trendPct}%)`);
        }

        // 供需比趨勢
        if (dsRatios.length > 0) {
            const avgDS = dsRatios.reduce((s, v) => s + v, 0) / dsRatios.length;
            const recentDS = dsRatios.slice(-12);
            const recentAvgDS = recentDS.reduce((s, v) => s + v, 0) / recentDS.length;
            console.log(`│   7天平均供需比: ${avgDS.toFixed(3)} | 最近供需比: ${recentAvgDS.toFixed(3)}`);
        }

        // 小時波動分析
        const hourlyChanges = [];
        for (let i = 12; i < frrs.length; i++) {
            if (frrs[i - 12] > 0 && frrs[i] > 0) {
                hourlyChanges.push(Math.abs(frrs[i] - frrs[i - 12]) / frrs[i - 12]);
            }
        }
        if (hourlyChanges.length > 0) {
            const avgHourly = hourlyChanges.reduce((s, v) => s + v, 0) / hourlyChanges.length;
            const maxHourly = Math.max(...hourlyChanges);
            const spikes = hourlyChanges.filter(c => c >= 0.05).length;
            console.log(`│   小時平均波動: ${(avgHourly * 100).toFixed(2)}% | 最大: ${(maxHourly * 100).toFixed(2)}% | 突刺次數: ${spikes}`);
        }
    }
    console.log('└─────────────────────────────────────────');

    // ---- 2d. IBRR 歷史分析 ----
    console.log('\n┌─────────────────────────────────────────');
    console.log('│ 🎯 IBRR 出清引擎校準分析');
    console.log('├─────────────────────────────────────────');

    for (const cur of ['USD', 'USDT']) {
        const ibrrData = await db.getIBRRTrainingData(cur, 168);
        if (!ibrrData || ibrrData.length < 5) {
            console.log(`│ ${cur}: IBRR 歷史數據不足 (${ibrrData?.length || 0} 筆)`);
            continue;
        }

        const ibrrRates = ibrrData.map(d => d.ibrr).filter(Boolean);
        const eqRates = ibrrData.map(d => d.equilibrium_rate).filter(Boolean);
        const frrRates = ibrrData.map(d => d.frr).filter(Boolean);
        const wallCount = ibrrData.filter(d => d.wall_detected).length;
        const mlDirections = ibrrData.map(d => d.ml_direction).filter(Boolean);

        const avgIBRR = ibrrRates.reduce((s, v) => s + v, 0) / ibrrRates.length;
        const avgFRR = frrRates.reduce((s, v) => s + v, 0) / frrRates.length;
        const ibrrPremium = avgFRR > 0 ? ((avgIBRR - avgFRR) / avgFRR * 100).toFixed(2) : 'N/A';

        console.log(`│ ${cur} IBRR 校準分析 (${ibrrData.length} 筆):`);
        console.log(`│   平均 IBRR: ${(avgIBRR * 100).toFixed(4)}%/天 | 平均 FRR: ${(avgFRR * 100).toFixed(4)}%/天`);
        console.log(`│   IBRR 相對 FRR 溢價: ${ibrrPremium}%`);
        console.log(`│   阻力牆觸發次數: ${wallCount}/${ibrrData.length} (${(wallCount / ibrrData.length * 100).toFixed(1)}%)`);

        // ML 預測方向統計
        const dirCounts = {};
        for (const d of mlDirections) { dirCounts[d] = (dirCounts[d] || 0) + 1; }
        if (Object.keys(dirCounts).length > 0) {
            console.log(`│   ML 預測方向統計: ${Object.entries(dirCounts).map(([k, v]) => `${k}(${v}次)`).join(', ')}`);
        }
    }
    console.log('└─────────────────────────────────────────');

    // ---- 2e. 掛單成交效率 ----
    console.log('\n┌─────────────────────────────────────────');
    console.log('│ ⚡ 掛單成交效率分析');
    console.log('├─────────────────────────────────────────');

    try {
        const supabase = db.getSupabase();
        // 查最近 7 天的所有 offers
        const { data: recentOffers } = await supabase
            .from('funding_offers')
            .select('*')
            .gte('created_at', weekAgo.toISOString())
            .order('created_at', { ascending: false });

        if (recentOffers && recentOffers.length > 0) {
            const closedOffers = recentOffers.filter(o => o.status === 'closed');
            const activeO = recentOffers.filter(o => o.status === 'active');
            console.log(`│ 近 7 天掛單總數: ${recentOffers.length} 筆`);
            console.log(`│ 已成交/取消: ${closedOffers.length} 筆 | 仍在掛: ${activeO.length} 筆`);

            // 計算平均等待時間
            const filledWithTime = closedOffers.filter(o => o.closed_at && o.created_at);
            if (filledWithTime.length > 0) {
                const waitTimes = filledWithTime.map(o =>
                    (new Date(o.closed_at) - new Date(o.created_at)) / 3600000
                ).filter(t => t > 0 && t < 72); // 排除異常值

                if (waitTimes.length > 0) {
                    const avgWait = waitTimes.reduce((s, v) => s + v, 0) / waitTimes.length;
                    const medianWait = waitTimes.sort((a, b) => a - b)[Math.floor(waitTimes.length / 2)];
                    console.log(`│ 平均掛單等待時間: ${avgWait.toFixed(2)} 小時`);
                    console.log(`│ 中位數等待時間: ${medianWait.toFixed(2)} 小時`);
                }
            }
        }
    } catch (err) {
        console.log(`│ 掛單分析失敗: ${err.message}`);
    }
    console.log('└─────────────────────────────────────────');

    // ---- 2f. 操作日誌分析 ----
    console.log('\n┌─────────────────────────────────────────');
    console.log('│ 📝 近期操作日誌摘要');
    console.log('├─────────────────────────────────────────');

    const logs = await db.getLogs(50);
    if (logs.length > 0) {
        const errorLogs = logs.filter(l => l.level === 'error');
        const warnLogs = logs.filter(l => l.level === 'warn' || l.level === 'warning');
        console.log(`│ 最近 50 筆日誌: ${logs.length} 筆`);
        console.log(`│ 其中 ❌ 錯誤: ${errorLogs.length} 筆 | ⚠️ 警告: ${warnLogs.length} 筆`);
        if (errorLogs.length > 0) {
            console.log(`│ 最新錯誤:`);
            for (const e of errorLogs.slice(0, 3)) {
                console.log(`│   [${new Date(e.created_at).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})}] ${e.category}: ${e.message?.substring(0, 80)}`);
            }
        }
    }
    console.log('└─────────────────────────────────────────');

    return true;
}

// ==================== 3. 綜合策略建議 ====================
async function generateRecommendations(hasDbData) {
    console.log('\n' + '═'.repeat(70));
    console.log('  🧠 第三部分：3D Hybrid 策略調整建議');
    console.log('═'.repeat(70));

    // 即時市場數據 for recommendations
    const symbols = { 'USD': 'fUSD', 'USDT': 'fUST' };
    const recommendations = [];

    for (const [name, sym] of Object.entries(symbols)) {
        try {
            const ticker = await fetchJSON(`${BITFINEX_API}/ticker/${sym}`);
            const frr = ticker[0];
            const volume = ticker[10];

            const book = await fetchJSON(`${BITFINEX_API}/book/${sym}/P0?len=100`);
            let totalBidVol = 0, totalAskVol = 0;
            for (const entry of book) {
                if (entry[3] > 0) totalBidVol += entry[3];
                else totalAskVol += Math.abs(entry[3]);
            }
            const dsRatio = totalAskVol > 0 ? totalBidVol / totalAskVol : 1;

            console.log(`\n┌─ 🪙 ${name} 策略建議 ──────────────────────`);

            // 建議 1: 供需比
            if (dsRatio > 2.0) {
                console.log('│ ✅ 建議 1: 需求極旺，可考慮提高天價探針比例至 30%');
                console.log('│    原因: 供需比 > 2.0，借方排隊搶借，高溢價訂單成交概率大增');
            } else if (dsRatio > 1.3) {
                console.log('│ ✅ 建議 1: 需求略旺，目前 20% 天價探針配置合理');
            } else if (dsRatio < 0.5) {
                console.log('│ ⚠️ 建議 1: 供給過剩，建議將底倉比例提升至 80%，減少天價探針');
                console.log('│    原因: 供需比 < 0.5，市場供過於求，應優先保障成交率');
            } else {
                console.log('│ ✅ 建議 1: 供需均衡，當前 60/20/20 分配合理');
            }

            // 建議 2: FRR 水位
            const annualizedFRR = frr * 365 * 100;
            if (annualizedFRR < 5) {
                console.log(`│ ⚠️ 建議 2: FRR 極低 (年化 ${annualizedFRR.toFixed(2)}%)，建議縮短期限至 2 天最小值`);
                console.log('│    原因: 低利率環境下鎖長期限會損失利率反彈的機會成本');
            } else if (annualizedFRR > 30) {
                console.log(`│ 📈 建議 2: FRR 高位 (年化 ${annualizedFRR.toFixed(2)}%)，可延長期限至 7~14 天鎖定高利率`);
            } else {
                console.log(`│ ✅ 建議 2: FRR 正常 (年化 ${annualizedFRR.toFixed(2)}%)，溢價天數橡皮筋機制自動適配中`);
            }

            // 建議 3: 底倉價格帶
            console.log(`│ 💡 建議 3: 底倉最低價 ${(frr * 0.999 * 100).toFixed(4)}% (年化 ${(frr * 0.999 * 365 * 100).toFixed(2)}%)`);
            if (frr * 0.999 * 365 * 100 < 8) {
                console.log('│    ⚠️ 底倉保底年化低於 8%，可考慮手動提高 minRate 以防超低利率成交');
            }

            // 建議 4: 降息重掛
            console.log('│ 💡 建議 4: 降息重掛機制目前已關閉 (_checkAndReofferTimeoutOffers 被 return)');
            console.log('│    如果發現掛單平均等待時間超過 6 小時且成交率低，可考慮重新啟用');
            console.log('│    建議參數: 等待 6~12 小時 + 每次降息 2~3% + 保底年化 8%');

            // 建議 5: 拆單大小
            console.log('│ 💡 建議 5: 當前拆單基準 500 USD/筆，最小 150 USD');
            if (volume > 50000000) {
                console.log('│    📈 日成交量充沛，可維持或提高拆單單位至 800~1000 USD 減少 API 壓力');
            } else if (volume < 5000000) {
                console.log('│    📉 日成交量偏低，建議降低至 300 USD/筆，提高成交機會');
            }

            console.log('└──────────────────────────────────────────');
            await sleep(1500);
        } catch (err) {
            console.log(`│ ❌ ${name} 建議生成失敗: ${err.message}`);
            console.log('└──────────────────────────────────────────');
        }
    }

    // 通用建議
    console.log('\n┌─ 🏗️ 通用架構層建議 ────────────────────');
    console.log('│ 1. ML Predictor: 目前使用 Phase 1 統計模型，歷史數據已足夠時考慮訓練 Phase 2 模型');
    console.log('│ 2. Harmonia 過濾: 10 分鐘誠信過濾維持不變，有效防禦高頻假單');
    console.log('│ 3. 事件驅動掛單: 新資金轉入 1.5s 防抖 + 複利到期 2s 防抖，參數合理');
    console.log('│ 4. Telegram 通知: 5s 成交合併防抖正常，建議觀察是否有遺漏通知');
    console.log('│ 5. K8s 部署: replicas=1 + Recreate 策略正確，避免雙實例重複下單');
    console.log('└──────────────────────────────────────────');
}

// ==================== Main ====================
async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║     🌌 Bitfinex 3D Hybrid 放貸策略 — 深度量化分析報告             ║');
    console.log('║     分析時間: ' + new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }).padEnd(50) + '  ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    // Part 1: 市場公開數據
    await analyzeMarket();

    // Part 2: 資料庫歷史數據
    const hasDb = await analyzeDatabase();

    // Part 3: 綜合建議
    await generateRecommendations(hasDb);

    console.log('\n✅ 分析完成！');
}

main().catch(err => {
    console.error('❌ 分析執行失敗:', err.message || err);
    process.exit(1);
});
