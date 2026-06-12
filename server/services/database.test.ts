import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import db from './database';
import config from '../config';

// 判斷是否為預設佔位符或缺失，若是則跳過真實資料庫整合測試
const isConfigured = 
  config.supabase.url && 
  config.supabase.key && 
  !config.supabase.url.includes('your-project') &&
  !config.supabase.key.includes('your_service_role_key');

describe('Supabase 資料庫整合測試 (Integration Tests)', () => {
  const TEST_OFFER_ID = 999999999;
  
  beforeAll(() => {
    if (!isConfigured) {
      console.log('⚠️ [Database Test] 缺少真實 Supabase 憑證，將自動跳過資料庫整合測試。');
    }
  });

  afterAll(async () => {
    if (isConfigured) {
      try {
        const client = db.getSupabase();
        if (client) {
          console.log('🧹 [Database Test] 正在執行整合測試數據自動清理自清...');
          // 1. 清除測試放貸掛單
          await client.from('funding_offers').delete().eq('offer_id', TEST_OFFER_ID);
          // 2. 清除測試日誌
          await client.from('operation_logs').delete().eq('category', 'TEST_LOG_INTEGRATION');
          console.log('✅ [Database Test] 測試數據自清完成。');
        }
      } catch (err: any) {
        console.error('❌ [Database Test] 測試數據自清失敗:', err.message);
      }
    }
  });

  it('getSupabase() 應能在配置正確時初始化客戶端', () => {
    const client = db.getSupabase();
    if (isConfigured) {
      expect(client).not.toBeNull();
    } else {
      expect(client).toBeNull();
    }
  });

  // 真實資料庫寫入測試，僅在憑證存在時執行
  const itConditional = isConfigured ? it : it.skip;

  itConditional('saveOffer() & closeOffer() 應能正確寫入並更新掛單且執行自清', async () => {
    const mockOffer = {
      id: TEST_OFFER_ID,
      currency: 'TEST_USD',
      amount: 250.0,
      rate: 0.00035,
      period: 2,
      status: 'active',
      createdAt: new Date().toISOString()
    };

    // 1. 寫入掛單
    const insertResult = await db.saveOffer(mockOffer);
    expect(insertResult).not.toBeNull();
    expect(insertResult![0].offer_id).toBe(TEST_OFFER_ID);
    expect(insertResult![0].currency).toBe('TEST_USD');
    expect(insertResult![0].status).toBe('active');

    // 2. 更新掛單狀態為 closed
    const updateResult = await db.closeOffer(TEST_OFFER_ID);
    expect(updateResult).not.toBeNull();
    expect(updateResult![0].status).toBe('closed');
  });

  itConditional('saveLog() 應能正確寫入測試日誌', async () => {
    // 寫入日誌
    await db.saveLog('info', 'TEST_LOG_INTEGRATION', 'Integration test message');
    
    // 讀取日誌驗證寫入成功
    const logs = await db.getLogs(5, 'TEST_LOG_INTEGRATION');
    expect(logs).not.toBeNull();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].message).toBe('Integration test message');
  });

});
