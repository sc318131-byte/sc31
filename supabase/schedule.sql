-- =====================================================================
-- 董事長行程系統：Supabase 建表 SQL
-- 資料表：public.chairman_events
--
-- 用途：任何人打開日曆網頁就能查看董事長行程（不用登入），
--       但網頁上不能新增、修改、刪除。行程由管理者在 Supabase 後台的
--       Table Editor 維護（後台使用資料表擁有者身分，不受下方限制）。
--       行程開始前，由排程（supabase/cron.sql）呼叫 Edge Function
--       line-reminder，用 LINE 通知管理者。
--
-- 注意：行程對外公開，知道網址的人都看得到名稱、時間、地點、備註與回報說明。
--       不要在備註或回報說明寫入不能公開的內容。
--
-- 使用方式：在 Supabase 的 SQL Editor 貼上整份檔案執行一次。
--   整份包在同一個交易裡，任何一步失敗都會全部復原。
--   已經執行過舊版（需要登入的版本）的專案，改執行 supabase/schedule-public-read.sql。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 一、行程資料表與 CHECK 限制
--
-- 時間一律存成 timestamptz（含時區），畫面與 LINE 通知以台北時間顯示。
-- 狀態：預定／已完成／已取消。只有「預定」的行程會發提醒。
-- 提醒：開始前幾分鐘提醒；null 表示不提醒。上限 7 天（10080 分鐘）。
-- reminded_at：已發送提醒的時間，由 Edge Function 填入，避免重複發送。
-- ---------------------------------------------------------------------
create table public.chairman_events (
  id             uuid        primary key default gen_random_uuid(),

  -- 行程名稱
  title          text        not null
    constraint chairman_events_title_len
      check (char_length(btrim(title)) between 1 and 100),

  -- 開始與結束時間；結束可不填，填了就不能早於開始
  start_at       timestamptz not null,
  end_at         timestamptz,
  constraint chairman_events_time_order
    check (end_at is null or end_at >= start_at),

  -- 地點、備註
  location       text
    constraint chairman_events_location_len
      check (location is null or char_length(location) <= 100),
  note           text
    constraint chairman_events_note_len
      check (note is null or char_length(note) <= 1000),

  -- 狀態
  status         text        not null default '預定'
    constraint chairman_events_status_values
      check (status in ('預定', '已完成', '已取消')),

  -- 回報說明：行程結束後填寫結果，例如「已完成，簽約延到下週」
  report         text
    constraint chairman_events_report_len
      check (report is null or char_length(report) <= 1000),

  -- 開始前幾分鐘提醒，null 為不提醒
  remind_minutes integer     default 30
    constraint chairman_events_remind_range
      check (remind_minutes is null or remind_minutes between 0 and 10080),

  -- 提醒已發送的時間（系統使用）
  reminded_at    timestamptz,

  -- 建立與更新時間（系統自動填入）
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table  public.chairman_events                is '董事長行程';
comment on column public.chairman_events.title          is '行程名稱';
comment on column public.chairman_events.start_at       is '開始時間';
comment on column public.chairman_events.end_at         is '結束時間';
comment on column public.chairman_events.location       is '地點';
comment on column public.chairman_events.note           is '備註';
comment on column public.chairman_events.status         is '狀態：預定／已完成／已取消';
comment on column public.chairman_events.report         is '回報說明';
comment on column public.chairman_events.remind_minutes is '開始前幾分鐘用 LINE 提醒，空白為不提醒';
comment on column public.chairman_events.reminded_at    is 'LINE 提醒已發送的時間（系統使用）';

-- 依開始時間查詢（日曆與提醒排程都會用到）
create index chairman_events_start_at_idx on public.chairman_events (start_at);

-- 只索引「還在等提醒」的行程，讓每 5 分鐘的排程查詢很快
create index chairman_events_pending_reminder_idx
  on public.chairman_events (start_at)
  where reminded_at is null and remind_minutes is not null and status = '預定';

-- ---------------------------------------------------------------------
-- 二、觸發器：更新時間、改時間後重新提醒
--
-- 行程的開始時間或提醒設定被修改時（包括在後台修改），清掉 reminded_at，
-- 讓新的時間點能再發一次提醒。
-- ---------------------------------------------------------------------
create function public.chairman_events_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.reminded_at := null;
  elsif new.start_at is distinct from old.start_at
     or new.remind_minutes is distinct from old.remind_minutes then
    new.reminded_at := null;
  end if;
  return new;
end;
$$;

create trigger chairman_events_before_write
  before insert or update on public.chairman_events
  for each row execute function public.chairman_events_before_write();

-- ---------------------------------------------------------------------
-- 三、GRANT 權限
--
-- 這個 Supabase 專案不會自動開放新資料表，所以要明確授權。
-- anon（未登入的訪客）：只能讀取日曆需要的欄位，不給新增、修改、刪除。
--   提醒設定（remind_minutes、reminded_at）與建立時間不對外開放。
-- authenticated：本系統不使用登入，不給任何權限。
-- service_role（Edge Function 用）：讀取行程、寫入 reminded_at。
--   service_role 會略過 RLS，金鑰只存在 Supabase 伺服器端，絕對不能放進前端。
-- ---------------------------------------------------------------------
revoke all on table public.chairman_events from public, anon, authenticated;

grant select (id, title, start_at, end_at, location, note, status, report)
  on table public.chairman_events to anon;

grant select on table public.chairman_events to service_role;
grant update (reminded_at) on table public.chairman_events to service_role;

-- ---------------------------------------------------------------------
-- 四、資料列安全 RLS
--
-- 啟用 RLS 後，沒有政策允許的動作一律拒絕。
-- 只建立一條「任何人可讀取」的政策；沒有新增、修改、刪除的政策，
-- 所以就算日後誤給了寫入權限，網頁也改不到任何資料。
-- ---------------------------------------------------------------------
alter table public.chairman_events enable row level security;

create policy "任何人可查看行程"
  on public.chairman_events for select to anon
  using (true);

commit;

-- =====================================================================
-- 新增或修改行程：
--   Supabase 後台 → Table Editor → chairman_events → Insert row（或點兩下儲存格修改）。
--   必填：title（行程名稱）、start_at（開始時間，例如 2026-11-20 14:00:00+08）。
--   status 只能填 預定／已完成／已取消；remind_minutes 填開始前幾分鐘提醒，留空為不提醒。
-- =====================================================================
