-- =====================================================================
-- 董事長行程：從「需要登入」改成「公開只能看」
--
-- 只有「已經執行過舊版 supabase/schedule.sql（需要登入的版本）」的專案才需要執行這份。
-- 還沒建過資料表的專案，直接執行新版 supabase/schedule.sql 即可，不用執行這份。
--
-- 執行後：
--   - 任何人不用登入就能查看行程（只開放日曆需要的欄位）。
--   - 網頁上不能新增、修改、刪除；行程改在 Supabase 後台的 Table Editor 維護。
--   - 移除登入用的可編輯名單與權限。現有的行程資料完全保留。
--
-- 可以重複執行，結果相同。整份包在同一個交易裡，失敗會全部復原。
-- =====================================================================

begin;

-- 一、移除舊的登入政策與函式
drop policy if exists "名單內帳號可查看行程" on public.chairman_events;
drop policy if exists "名單內帳號可新增行程" on public.chairman_events;
drop policy if exists "名單內帳號可修改行程" on public.chairman_events;
drop policy if exists "名單內帳號可刪除行程" on public.chairman_events;
drop function if exists public.is_schedule_editor();
drop table if exists public.schedule_editors;

-- 二、重新設定權限：anon 只能讀取部分欄位，authenticated 不給任何權限
revoke all on table public.chairman_events from public, anon, authenticated;

grant select (id, title, start_at, end_at, location, note, status, report)
  on table public.chairman_events to anon;

-- service_role（Edge Function 用）維持不變：讀取行程、寫入 reminded_at
grant select on table public.chairman_events to service_role;
grant update (reminded_at) on table public.chairman_events to service_role;

-- 三、RLS：只允許讀取
alter table public.chairman_events enable row level security;

drop policy if exists "任何人可查看行程" on public.chairman_events;
create policy "任何人可查看行程"
  on public.chairman_events for select to anon
  using (true);

commit;

-- 舊版建立的登入帳號不會自動刪除，可到 Authentication → Users 自行刪除。
