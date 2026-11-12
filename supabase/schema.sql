-- =====================================================================
-- 報修登記系統：Supabase 建表 SQL
-- 資料表：public.repair_requests
--
-- 用途：一般同事（未登入，使用 anon 角色）可以新增報修、讀取清單；
--       任何人都不能透過前端修改或刪除資料。
--
-- 使用方式：在 Supabase 的 SQL Editor 貼上整份檔案執行一次。
--   整份包在同一個交易裡，任何一步失敗都會全部復原。
--   這份檔案是給「全新專案」用的；資料表已存在時會直接報錯，不會覆蓋資料。
--
-- 安全設計分三層，缺一層都不夠：
--   1. GRANT：決定 anon 角色能碰哪些欄位、能做哪些動作。
--   2. RLS ：決定 anon 能讀寫哪些「列」，並檢查新增的內容。
--   3. CHECK：資料庫層級的欄位值與長度限制，任何角色都無法繞過。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 一、建立資料表與 CHECK 限制（第 3 層）
--
-- 欄位值必須和需求筆記、文件/報修欄位表.xlsx 一致：
--   類別：設備／網路／環境／其他
--   緊急程度：低／中／高（預設 中）
--   處理狀態：待處理／處理中／已完成（預設 待處理）
--
-- 文字欄位全部設為必填（not null），並用 btrim 擋掉只有空白的內容。
-- 長度上限是暫定值，筆記沒有寫明，需要確認：
--   報修人姓名 50 字、地點或部門 100 字、問題說明 1000 字。
-- ---------------------------------------------------------------------
create table public.repair_requests (
  -- 主鍵：由資料庫自動產生 UUID，前端不能自己指定
  id            uuid        primary key default gen_random_uuid(),

  -- 登記時間：由資料庫在新增當下自動填入，前端不能自己指定
  created_at    timestamptz not null default now(),

  -- 報修人姓名
  reporter_name text        not null
    constraint repair_requests_reporter_name_len
      check (char_length(btrim(reporter_name)) between 1 and 50),

  -- 地點或部門
  location      text        not null
    constraint repair_requests_location_len
      check (char_length(btrim(location)) between 1 and 100),

  -- 類別：只能是四個值之一
  category      text        not null
    constraint repair_requests_category_values
      check (category in ('設備', '網路', '環境', '其他')),

  -- 問題說明
  description   text        not null
    constraint repair_requests_description_len
      check (char_length(btrim(description)) between 1 and 1000),

  -- 緊急程度：只能是三個值之一，沒填時預設「中」
  urgency       text        not null default '中'
    constraint repair_requests_urgency_values
      check (urgency in ('低', '中', '高')),

  -- 處理狀態：只能是三個值之一，沒填時預設「待處理」
  status        text        not null default '待處理'
    constraint repair_requests_status_values
      check (status in ('待處理', '處理中', '已完成'))
);

comment on table  public.repair_requests               is '報修登記（示範資料，全為虛構）';
comment on column public.repair_requests.id            is '編號（自動產生）';
comment on column public.repair_requests.created_at    is '登記時間（自動產生）';
comment on column public.repair_requests.reporter_name is '報修人姓名';
comment on column public.repair_requests.location      is '地點或部門';
comment on column public.repair_requests.category      is '類別：設備／網路／環境／其他';
comment on column public.repair_requests.description   is '問題說明';
comment on column public.repair_requests.urgency       is '緊急程度：低／中／高';
comment on column public.repair_requests.status        is '處理狀態：待處理／處理中／已完成';

-- 清單依登記時間由新到舊排列，加索引讓查詢不用掃整張表
create index repair_requests_created_at_idx
  on public.repair_requests (created_at desc);

-- ---------------------------------------------------------------------
-- 二、GRANT 權限（第 1 層）
--
-- 這個 Supabase 專案不會自動開放新資料表，所以要明確授權。
-- 先把所有權限收回，再只給需要的部分，避免殘留任何預設權限。
--
-- anon（未登入的訪客）：
--   - 可以讀取全部欄位（清單要顯示）。
--   - 只能新增 5 個欄位：姓名、地點、類別、說明、緊急程度。
--     id、created_at、status 不開放寫入，一律使用資料庫預設值，
--     所以新增的資料 status 一定是「待處理」、時間一定是伺服器時間。
--   - 不給 update、delete、truncate。
--
-- authenticated（已登入使用者）：本次示範沒有登入，不給任何權限。
--   日後加入登入、讓管理員更新狀態時，再另外設計授權。
-- ---------------------------------------------------------------------
revoke all on table public.repair_requests from public, anon, authenticated;

grant select
  on table public.repair_requests
  to anon;

grant insert (reporter_name, location, category, description, urgency)
  on table public.repair_requests
  to anon;

-- ---------------------------------------------------------------------
-- 三、資料列安全 RLS（第 2 層）
--
-- 啟用 RLS 後，沒有政策允許的動作一律拒絕。
-- 這裡只建立兩條政策：
--   - 讀取：任何人（anon）都可以讀全部清單。
--   - 新增：任何人（anon）都可以新增，但新增後的 status 必須是「待處理」。
--     雖然 GRANT 已經不讓 anon 寫入 status，這裡再檢查一次，
--     萬一日後有人誤開 status 的寫入權限，仍然擋得住。
-- 沒有 update、delete 政策，所以就算日後誤給了權限，也改不到任何資料列。
--
-- 注意：資料表擁有者與 service_role 會略過 RLS。
--   service_role 金鑰只能放在伺服器端，絕對不能放進前端或提交到儲存庫。
-- ---------------------------------------------------------------------
alter table public.repair_requests enable row level security;

create policy "任何人可讀取報修清單"
  on public.repair_requests
  for select
  to anon
  using (true);

create policy "任何人可新增報修，狀態必須為待處理"
  on public.repair_requests
  for insert
  to anon
  with check (status = '待處理');

commit;
