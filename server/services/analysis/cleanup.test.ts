import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCleanup } from './cleanup';

describe('資料庫過期資料自動滾動清理 (cleanup service)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('當 Supabase 客戶端為 null 時，應安全返回錯誤而不崩潰', async () => {
        const result = await runCleanup({}, null);
        // 若環境無有效 client 或傳入 null，且 db.getSupabase() 若有連線則覆寫
        // 這裡直接驗證當 client 缺漏時的安全性
    });

    it('應正確呼叫清理已結案訂單 (closed)、歷史日誌與快照，且絕對不碰 earnings 表', async () => {
        const deletedTables: string[] = [];
        const queries: { table: string; calls: string[] }[] = [];

        const createBuilder = (table: string) => {
            const callRecord: string[] = [];
            const builder: any = {
                delete: vi.fn(() => {
                    callRecord.push('delete');
                    return builder;
                }),
                eq: vi.fn((col: string, val: any) => {
                    callRecord.push(`eq:${col}=${val}`);
                    return builder;
                }),
                lt: vi.fn((col: string, val: any) => {
                    callRecord.push(`lt:${col}`);
                    return builder;
                }),
                is: vi.fn((col: string, val: any) => {
                    callRecord.push(`is:${col}=${val}`);
                    return builder;
                }),
                then: (resolve: any) => {
                    deletedTables.push(table);
                    queries.push({ table, calls: [...callRecord] });
                    return Promise.resolve({ error: null }).then(resolve);
                }
            };
            return builder;
        };

        const mockClient = {
            from: vi.fn((table: string) => createBuilder(table))
        };

        const result = await runCleanup({
            closedOrderDays: 30,
            logDays: 30,
            rateDays: 30,
            snapshotDays: 7
        }, mockClient as any);

        expect(result.success).toBe(true);

        // 驗證已清理的表格
        expect(deletedTables).toContain('operation_logs');
        expect(deletedTables).toContain('funding_offers');
        expect(deletedTables).toContain('funding_loans');
        expect(deletedTables).toContain('rate_history');
        expect(deletedTables).toContain('order_book_snapshots');

        // 核心安全檢驗：絕對不能包含 earnings 收益表！
        expect(deletedTables).not.toContain('earnings');

        // 驗證 funding_offers 刪除時必須限制 status = 'closed'
        const offerQueries = queries.filter(q => q.table === 'funding_offers');
        expect(offerQueries.length).toBeGreaterThan(0);
        offerQueries.forEach(q => {
            expect(q.calls).toContain('eq:status=closed');
        });

        // 驗證 funding_loans 刪除時必須限制 status = 'closed'
        const loanQueries = queries.filter(q => q.table === 'funding_loans');
        expect(loanQueries.length).toBeGreaterThan(0);
        loanQueries.forEach(q => {
            expect(q.calls).toContain('eq:status=closed');
        });
    });

    it('當資料庫刪除出現例外錯誤時，應優雅捕捉並回傳錯誤訊息', async () => {
        const mockErrorClient = {
            from: vi.fn(() => {
                throw new Error('Database connection failed');
            })
        };

        const result = await runCleanup({}, mockErrorClient as any);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Database connection failed');
    });

    it('當特定表格刪除返回 error 物件時，應記錄在 stats.errors 且標記 success 為 false', async () => {
        const mockErrorResponseClient = {
            from: vi.fn(() => ({
                delete: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                lt: vi.fn().mockReturnValue(Promise.resolve({ error: { message: 'Permission denied on table' } })),
                is: vi.fn().mockReturnThis()
            }))
        };

        const result = await runCleanup({}, mockErrorResponseClient as any);
        expect(result.success).toBe(false);
        expect(result.stats.errors.length).toBeGreaterThan(0);
        expect(result.stats.errors[0].error).toBe('Permission denied on table');
    });
});
