#!/usr/bin/env node

/**
 * CLI 腳本：手動執行資料庫過期資料滾動清理
 * 使用方式：npm run cleanup:db
 */

require('dotenv').config();
const { getSupabase } = require('../services/database');
const { runCleanup, DEFAULT_CLOSED_ORDER_RETENTION_DAYS, DEFAULT_OPERATION_LOG_RETENTION_DAYS } = require('../services/analysis/cleanup');

async function main() {
    console.log('======================================================================');
    console.log('   🧹 Lending-bot 資料庫手動滾動清理 (Retention Policy)');
    console.log('======================================================================');
    console.log(`⏰ 執行時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    console.log(`📌 保留策略: 過期訂單保留 ${DEFAULT_CLOSED_ORDER_RETENTION_DAYS} 天, 日誌保留 ${DEFAULT_OPERATION_LOG_RETENTION_DAYS} 天`);

    const db = getSupabase();
    if (!db) {
        console.error('❌ 無法連線至 Supabase，請檢查 .env 設定中的 SUPABASE_URL 與 SUPABASE_KEY。');
        process.exit(1);
    }

    // 1. 查詢清理前各表格資料筆數概況
    console.log('\n📊 正在統計各資料表當前總筆數...');
    const tables = ['funding_offers', 'funding_loans', 'operation_logs', 'rate_history', 'order_book_snapshots', 'earnings'];
    const countsBefore = {};

    for (const tbl of tables) {
        try {
            const { count, error } = await db.from(tbl).select('*', { count: 'exact', head: true });
            countsBefore[tbl] = error ? 'N/A' : count;
        } catch {
            countsBefore[tbl] = 'N/A';
        }
    }

    console.table(countsBefore);

    // 2. 執行清理作業
    console.log('\n🚀 開始執行滾動清理...');
    const startTime = Date.now();
    const result = await runCleanup();
    const elapsedMs = Date.now() - startTime;

    if (!result.success) {
        console.error('\n❌ 清理過程中出現錯誤:', result.error);
    } else {
        console.log(`\n✅ 清理完成！耗時: ${(elapsedMs / 1000).toFixed(2)} 秒`);
    }

    // 3. 查詢清理後各表格資料筆數概況
    console.log('\n📊 統計清理後各資料表總筆數:');
    const countsAfter = {};
    const freedSummary = {};

    for (const tbl of tables) {
        try {
            const { count, error } = await db.from(tbl).select('*', { count: 'exact', head: true });
            countsAfter[tbl] = error ? 'N/A' : count;
            if (typeof countsBefore[tbl] === 'number' && typeof count === 'number') {
                freedSummary[tbl] = countsBefore[tbl] - count;
            } else {
                freedSummary[tbl] = 0;
            }
        } catch {
            countsAfter[tbl] = 'N/A';
            freedSummary[tbl] = 0;
        }
    }

    console.table({
        '清理前筆數': countsBefore,
        '清理後筆數': countsAfter,
        '釋放筆數': freedSummary
    });

    const totalFreed = Object.values(freedSummary).reduce((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);
    console.log(`\n🎉 本次共釋放了 ${totalFreed} 筆過期記錄！`);
    console.log('🛡️ 注意：收益記錄 (earnings) 與活躍進行中的訂單 (active) 均已完好保留。');
    console.log('======================================================================\n');
}

main().catch(err => {
    console.error('執行清理腳本失敗:', err);
    process.exit(1);
});
