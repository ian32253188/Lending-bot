-- IBRR 仍由策略引擎在記憶體中計算；不再保存每 5 分鐘的歷史快照。
-- 這會刪除既有 ibrr_history 資料與其索引，降低後續 Disk IO 與儲存使用量。
DROP TABLE IF EXISTS public.ibrr_history;
