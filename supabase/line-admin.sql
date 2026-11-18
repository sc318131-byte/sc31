-- =====================================================================
-- LINE 提醒：儲存「接收提醒的管理者 userId」
--
-- 管理者傳「綁定 <綁定碼>」給 LINE 官方帳號後，Edge Function line-webhook
-- 會把他的 userId 存在這裡；line-reminder 發提醒時從這裡讀取。
-- 沒有綁定時，line-reminder 仍可使用 secret LINE_ADMIN_USER_ID。
--
-- 使用方式：在 SQL Editor 貼上整份檔案執行（可重複執行）。
-- =====================================================================

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 只會有一筆：目前接收提醒的管理者
create table if not exists private.line_admin (
  id         boolean     primary key default true check (id),
  user_id    text        not null check (user_id ~ '^U[0-9a-f]{32}$'),
  bound_at   timestamptz not null default now()
);
revoke all on table private.line_admin from public, anon, authenticated;

-- 設定管理者（只給 Edge Function 使用的 service_role 呼叫）
create or replace function public.line_set_admin(p_user_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.line_admin (id, user_id, bound_at)
  values (true, p_user_id, now())
  on conflict (id) do update set user_id = excluded.user_id, bound_at = now();
end;
$$;

-- 讀取管理者 userId（沒有綁定時回傳 null）
create or replace function public.line_get_admin()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select user_id from private.line_admin where id;
$$;

-- 讀取排程密碼（supabase/cron.sql 存在 Vault 的 line_reminder_cron_secret）
-- line-reminder 用它驗證呼叫者，不用再把同一組密碼複製到 Edge Function secrets。
create or replace function public.line_cron_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'line_reminder_cron_secret';
$$;

-- 網頁與未登入的訪客都不能呼叫，只有 service_role 可以
revoke all on function public.line_set_admin(text) from public, anon, authenticated;
revoke all on function public.line_get_admin()     from public, anon, authenticated;
revoke all on function public.line_cron_secret()   from public, anon, authenticated;
grant execute on function public.line_set_admin(text) to service_role;
grant execute on function public.line_get_admin()     to service_role;
grant execute on function public.line_cron_secret()   to service_role;

commit;

-- 查看目前綁定的管理者：select * from private.line_admin;
-- 解除綁定（改回使用 secret LINE_ADMIN_USER_ID）：delete from private.line_admin;
