-- =====================================================================
-- 董事長行程系統：Supabase 建表 SQL
-- 資料表：public.schedule_editors、public.chairman_events
--
-- 用途：董事長的行程屬於機密，只有登入且列在 schedule_editors 名單裡的帳號
--       可以查看、新增、修改、刪除。未登入的訪客（anon）完全看不到。
--       行程開始前，由排程（supabase/cron.sql）呼叫 Edge Function
--       line-reminder，用 LINE 通知管理者。
--
-- 使用方式：在 Supabase 的 SQL Editor 貼上整份檔案執行一次。
--   整份包在同一個交易裡，任何一步失敗都會全部復原。
--   執行後，到 Authentication 建立帳號，再把帳號加進 schedule_editors（見檔案最後）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 一、可編輯名單
--
-- 只有列在這張表裡的登入帳號，才能存取行程。
-- 名單本身只能由資料庫管理者在 SQL Editor 或後台維護，前端不能修改。
-- ---------------------------------------------------------------------
create table public.schedule_editors (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text check (note is null or char_length(note) <= 50),
  created_at timestamptz not null default now()
);

comment on table public.schedule_editors is '可以查看與編輯董事長行程的帳號名單';

-- 判斷目前登入的使用者是否在名單內。
-- security definer：讓 RLS 政策能查名單，又不必開放名單給前端讀取。
-- search_path 設為空字串，避免被同名物件劫持。
create function public.is_schedule_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.schedule_editors e where e.user_id = auth.uid()
  );
$$;

revoke all on function public.is_schedule_editor() from public, anon;
grant execute on function public.is_schedule_editor() to authenticated;

-- ---------------------------------------------------------------------
-- 二、行程資料表與 CHECK 限制
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

  -- 建立者與時間（系統自動填入）
  created_by     uuid        default auth.uid() references auth.users (id) on delete set null,
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
-- 三、觸發器：更新時間、改時間後重新提醒
--
-- 行程的開始時間或提醒設定被修改時，清掉 reminded_at，
-- 讓新的時間點能再發一次提醒。前端也不能自己改 reminded_at。
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
-- 四、GRANT 權限
--
-- 這個 Supabase 專案不會自動開放新資料表，所以要明確授權。
-- anon（未登入）：完全沒有權限。
-- authenticated（已登入）：可讀寫行程，但實際能不能存取由下方 RLS 名單決定。
--   不開放寫入 id、reminded_at、created_by、created_at、updated_at。
-- service_role（Edge Function 用）：讀取行程、寫入 reminded_at。
--   service_role 會略過 RLS，金鑰只存在 Supabase 伺服器端，絕對不能放進前端。
-- ---------------------------------------------------------------------
revoke all on table public.schedule_editors from public, anon, authenticated;
revoke all on table public.chairman_events  from public, anon, authenticated;

grant select on table public.chairman_events to authenticated;
grant insert (title, start_at, end_at, location, note, status, report, remind_minutes)
  on table public.chairman_events to authenticated;
grant update (title, start_at, end_at, location, note, status, report, remind_minutes)
  on table public.chairman_events to authenticated;
grant delete on table public.chairman_events to authenticated;

grant select on table public.chairman_events to service_role;
grant update (reminded_at) on table public.chairman_events to service_role;

-- ---------------------------------------------------------------------
-- 五、資料列安全 RLS
--
-- 兩張表都啟用 RLS。
-- schedule_editors 沒有任何政策，前端讀寫一律拒絕。
-- chairman_events 只允許名單內的登入帳號操作。
-- ---------------------------------------------------------------------
alter table public.schedule_editors enable row level security;
alter table public.chairman_events  enable row level security;

create policy "名單內帳號可查看行程"
  on public.chairman_events for select to authenticated
  using ((select public.is_schedule_editor()));

create policy "名單內帳號可新增行程"
  on public.chairman_events for insert to authenticated
  with check ((select public.is_schedule_editor()));

create policy "名單內帳號可修改行程"
  on public.chairman_events for update to authenticated
  using ((select public.is_schedule_editor()))
  with check ((select public.is_schedule_editor()));

create policy "名單內帳號可刪除行程"
  on public.chairman_events for delete to authenticated
  using ((select public.is_schedule_editor()));

commit;

-- =====================================================================
-- 執行完上面之後，手動把帳號加進名單（不在交易內，可以分開執行）：
--
-- 1. 到 Authentication → Users → Add user 建立帳號（例如秘書、董事長）。
-- 2. 到 Authentication → Sign In / Providers，關閉「Allow new users to sign up」，
--    避免陌生人自行註冊。
-- 3. 把下面的 email 換成剛建立的帳號，再執行：
--
-- insert into public.schedule_editors (user_id, note)
-- select id, '秘書' from auth.users where email = 'secretary@example.com';
-- =====================================================================
