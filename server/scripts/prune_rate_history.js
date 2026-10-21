const { getSupabase } = require('../services/database');
const logger = require('../utils/logger');

async function prune() {
    console.log('=== 🧹 開始執行 Supabase rate_history 深度瘦身清理 ===');
    const db = getSupabase();
    if (!db) {
        console.error('❌ 無法連線至 Supabase');
        process.exit(1);
    }

    // 1. 查詢清理前筆數
    const { count: countBefore } = await db
        .from('rate_history')
        .select('*', { count: 'exact', head: true });
    console.log(`📊 清理前 rate_history 總筆數: ${countBefore} 筆`);

    // 2. 清理 7 天以前的資料 (保留近 7 天明細)
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    console.log(`⏳ 正在刪除 ${cutoffDate} 之前的舊歷史數據...`);

    const { error: delError } = await db
        .from('rate_history')
        .delete()
        .lt('recorded_at', cutoffDate);

    if (delError) {
        console.error('❌ 刪除失敗:', delError.message);
    } else {
        console.log('✅ 舊資料刪除成功！');
    }

    // 3. 查詢清理後筆數
    const { count: countAfter } = await db
        .from('rate_history')
        .select('*', { count: 'exact', head: true });
    console.log(`🎉 清理後 rate_history 總筆數: ${countAfter} 筆`);
    console.log(`📉 共為資料庫釋放了 ${countBefore - countAfter} 筆資料！`);

    // 4. 同時清理過期 operation_logs (7 天) 與 order_book_snapshots (3 天)
    const logCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.from('operation_logs').delete().lt('created_at', logCutoff);

    const obCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await db.from('order_book_snapshots').delete().lt('recorded_at', obCutoff);
    console.log('✨ 日誌與訂單簿快照清理完畢！');
}

prune().catch(console.error);
