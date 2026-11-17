-- =====================================================================
-- 董事長行程：用「共用通行碼」在網頁上新增、修改、刪除行程
--
-- 前提：已執行 supabase/schedule.sql（或舊專案已執行 schedule-public-read.sql）。
--
-- 做法：
--   - 查看行程仍然不用登入（沿用 schedule.sql 的唯讀權限）。
--   - 網頁不能直接寫入資料表；只能呼叫下面三個函式，每次都要附上通行碼。
--     函式在資料庫裡比對通行碼，通行碼正確才會寫入。
--   - 通行碼只存「雜湊值」在 private schema，網頁和 API 都讀不到。
--   - 15 分鐘內錯誤 10 次，就暫停所有編輯 15 分鐘，防止有人一直猜。
--
-- 使用方式：
--   1. 在 SQL Editor 貼上整份檔案執行（可重複執行）。
--   2. 再單獨執行下面這行設定通行碼（把內容換成你要的通行碼，至少 8 個字元）：
--        select private.set_schedule_passcode('換成你的通行碼');
--      這行不要存進任何檔案。之後要更換通行碼，再執行一次即可。
-- =====================================================================

begin;

-- 雜湊通行碼用的 pgcrypto（Supabase 預設裝在 extensions schema）
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 一、private schema：存通行碼雜湊與錯誤紀錄
-- 這個 schema 不在 Supabase API 開放範圍內，anon 也沒有任何權限。
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.schedule_passcode (
  id            boolean     primary key default true check (id),  -- 只會有一筆
  passcode_hash text        not null,
  updated_at    timestamptz not null default now()
);

create table if not exists private.schedule_passcode_failures (
  id        bigint      generated always as identity primary key,
  failed_at timestamptz not null default now()
);
create index if not exists schedule_passcode_failures_at_idx
  on private.schedule_passcode_failures (failed_at);

revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 二、設定通行碼（只有能進 SQL Editor 的管理者能用）
-- ---------------------------------------------------------------------
create or replace function private.set_schedule_passcode(p_passcode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_passcode is null or char_length(p_passcode) < 8 then
    raise exception '通行碼至少要 8 個字元';
  end if;
  insert into private.schedule_passcode (id, passcode_hash, updated_at)
  values (true, extensions.crypt(p_passcode, extensions.gen_salt('bf', 10)), now())
  on conflict (id) do update
    set passcode_hash = excluded.passcode_hash, updated_at = now();
  -- 換了通行碼就解除暫停
  delete from private.schedule_passcode_failures;
end;
$$;

revoke all on function private.set_schedule_passcode(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 三、檢查通行碼：正確回傳 null，錯誤回傳原因代碼
--   not_configured：管理者還沒設定通行碼
--   locked：最近 15 分鐘錯誤太多次
--   wrong_passcode：通行碼錯誤（會記一次錯誤）
-- 這裡不用 raise exception，否則錯誤紀錄會跟著交易一起復原。
-- ---------------------------------------------------------------------
create or replace function private.schedule_passcode_error(p_passcode text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash   text;
  v_recent integer;
begin
  select passcode_hash into v_hash from private.schedule_passcode where id;
  if v_hash is null then
    return 'not_configured';
  end if;

  select count(*) into v_recent
  from private.schedule_passcode_failures
  where failed_at > now() - interval '15 minutes';
  if v_recent >= 10 then
    return 'locked';
  end if;

  if p_passcode is null or extensions.crypt(p_passcode, v_hash) <> v_hash then
    insert into private.schedule_passcode_failures default values;
    delete from private.schedule_passcode_failures where failed_at < now() - interval '1 day';
    return 'wrong_passcode';
  end if;

  return null;
end;
$$;

revoke all on function private.schedule_passcode_error(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 四、網頁可呼叫的函式
-- 全部回傳 jsonb：成功 {"ok": true, ...}，失敗 {"ok": false, "error": "原因代碼"}。
-- 欄位值的檢查（字數、狀態選項、結束不早於開始）由資料表的 CHECK 負責；
-- 不符合時會回傳資料庫錯誤 23514。
-- 函式以資料表擁有者身分寫入，所以不需要開放 anon 寫入資料表。
-- ---------------------------------------------------------------------

-- 確認通行碼（網頁解鎖編輯時使用）
create or replace function public.schedule_check_passcode(p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_err text := private.schedule_passcode_error(p_passcode);
begin
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 新增行程。p_event 例：{"title":"董事會月會","start_at":"2026-11-20T14:00:00+08:00","remind_minutes":30}
create or replace function public.schedule_create_event(p_passcode text, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_err text := private.schedule_passcode_error(p_passcode);
  v_id  uuid;
begin
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  insert into public.chairman_events
    (title, start_at, end_at, location, note, status, report, remind_minutes)
  values (
    btrim(p_event->>'title'),
    (p_event->>'start_at')::timestamptz,
    nullif(p_event->>'end_at', '')::timestamptz,
    nullif(btrim(p_event->>'location'), ''),
    nullif(btrim(p_event->>'note'), ''),
    coalesce(nullif(p_event->>'status', ''), '預定'),
    nullif(btrim(p_event->>'report'), ''),
    case when p_event ? 'remind_minutes' then (p_event->>'remind_minutes')::integer else 30 end
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- 修改行程（整筆覆寫可編輯的欄位）
create or replace function public.schedule_update_event(p_passcode text, p_id uuid, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_err text := private.schedule_passcode_error(p_passcode);
begin
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  update public.chairman_events set
    title          = btrim(p_event->>'title'),
    start_at       = (p_event->>'start_at')::timestamptz,
    end_at         = nullif(p_event->>'end_at', '')::timestamptz,
    location       = nullif(btrim(p_event->>'location'), ''),
    note           = nullif(btrim(p_event->>'note'), ''),
    status         = coalesce(nullif(p_event->>'status', ''), '預定'),
    report         = nullif(btrim(p_event->>'report'), ''),
    remind_minutes = (p_event->>'remind_minutes')::integer
  where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

-- 刪除行程
create or replace function public.schedule_delete_event(p_passcode text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_err text := private.schedule_passcode_error(p_passcode);
begin
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  delete from public.chairman_events where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 只開放給網頁（anon）呼叫這四個函式
revoke all on function public.schedule_check_passcode(text)            from public, anon, authenticated;
revoke all on function public.schedule_create_event(text, jsonb)       from public, anon, authenticated;
revoke all on function public.schedule_update_event(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.schedule_delete_event(text, uuid)        from public, anon, authenticated;
grant execute on function public.schedule_check_passcode(text)            to anon;
grant execute on function public.schedule_create_event(text, jsonb)       to anon;
grant execute on function public.schedule_update_event(text, uuid, jsonb) to anon;
grant execute on function public.schedule_delete_event(text, uuid)        to anon;

-- 編輯畫面要顯示目前的提醒設定，所以多開放讀取 remind_minutes
grant select (remind_minutes) on table public.chairman_events to anon;

commit;

-- =====================================================================
-- 常用指令（在 SQL Editor 執行）：
--   設定或更換通行碼：select private.set_schedule_passcode('換成你的通行碼');
--   查看最近的錯誤次數：select count(*) from private.schedule_passcode_failures
--                       where failed_at > now() - interval '15 minutes';
--   立即解除暫停：delete from private.schedule_passcode_failures;
-- =====================================================================
