-- =====================================================================
-- 董事長行程系統：每 5 分鐘檢查一次 LINE 提醒
--
-- 先完成這些步驟再執行本檔（詳見 文件/行程系統設定說明.md）：
--   1. 已執行 supabase/schedule.sql。
--   2. 已部署 Edge Function line-reminder，並設定好 secrets。
--   3. 到 Database → Extensions 啟用 pg_cron 與 pg_net（或執行下方 create extension）。
--
-- 執行前要替換兩個地方，不要把真實密碼提交到儲存庫：
--   <專案代號>   例如 mqhowhmojncjpbfvovdv
--   <CRON_SECRET> 和 Edge Function secrets 裡的 CRON_SECRET 相同的一串亂數
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 把網址和密碼存進 Vault（加密儲存），排程執行時再讀出來。
-- 這兩行只要執行一次；要更換密碼時，到 Vault 介面修改。
select vault.create_secret('https://<專案代號>.supabase.co/functions/v1/line-reminder', 'line_reminder_url');
select vault.create_secret('<CRON_SECRET>', 'line_reminder_cron_secret');

-- 每 5 分鐘呼叫一次 Edge Function。
-- 同名排程已存在時，cron.schedule 會直接更新它。
select cron.schedule(
  'line-reminder-every-5-min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'line_reminder_url'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_reminder_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- 查看排程最近的執行紀錄：
--   select * from cron.job_run_details order by start_time desc limit 20;
-- 查看 Edge Function 的回應：
--   select id, status_code, content from net._http_response order by created desc limit 20;
-- 停用排程：
--   select cron.unschedule('line-reminder-every-5-min');
