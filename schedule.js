// 董事長行程：不用登入，只能查看（日曆＋行程詳細內容）
// 資料表 chairman_events 對 anon 只開放讀取部分欄位（見 supabase/schedule.sql）。
// 新增、修改、刪除行程請到 Supabase 後台的 Table Editor 操作。
(function () {
  "use strict";

  const TABLE = "chairman_events";
  // 只讀這些欄位；資料庫也只開放這些欄位給未登入的訪客
  const COLUMNS = "id, title, start_at, end_at, location, note, status, report";
  const STATUS_COLOR = { "預定": "--planned", "已完成": "--done", "已取消": "--cancel" };
  const $ = (id) => document.getElementById(id);

  const calMsg = $("cal-message");
  const dialog = $("event-dialog");
  const refreshBtn = $("refresh-btn");

  function showMessage(el, type, text) { el.className = "message " + type; el.textContent = text; el.hidden = false; }
  function hideMessage(el) { el.hidden = true; el.textContent = ""; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---- Supabase 連線（不登入、不保存登入狀態） ----
  let client = null;
  try {
    const cfg = window.APP_CONFIG || {};
    const url = String(cfg.SUPABASE_URL || "");
    const key = String(cfg.SUPABASE_PUBLISHABLE_KEY || "");
    if (!/^https:\/\/\S+$/.test(url) || !key) throw new Error("config.js 的 Supabase 設定不完整。");
    if (/^sb_secret_/.test(key) || /service_role/.test(key)) throw new Error("config.js 放了 secret 金鑰，請立即撤銷並改用 publishable key。");
    if (!window.supabase || !window.FullCalendar) throw new Error("無法載入必要的程式庫，請檢查網路連線後重新整理。");
    client = window.supabase.createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch (err) {
    showMessage(calMsg, "err", err.message);
    refreshBtn.disabled = true;
    return;
  }

  function explainError(error) {
    if (!error) return "發生未知錯誤，請稍後再試。";
    const code = error.code || "";
    const msg = error.message || "";
    if (code === "42501" || /permission denied/i.test(msg)) return "沒有讀取權限，請先在 Supabase 執行 supabase/schedule.sql。";
    if (code === "42P01" || /does not exist|schema cache/i.test(msg)) return "找不到行程資料表，請先在 Supabase 執行 supabase/schedule.sql。";
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "無法連線到伺服器，請檢查網路後再試。";
    return "發生錯誤：" + msg;
  }

  // ---- 時間顯示：和日曆一樣用裝置的時區（在台灣就是台北時間） ----
  const dateTimeFmt = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const timeFmt = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  function formatRange(r) {
    const start = new Date(r.start_at);
    if (!r.end_at) return dateTimeFmt.format(start);
    const end = new Date(r.end_at);
    return dateTimeFmt.format(start) + " – " + (sameDay(start, end) ? timeFmt.format(end) : dateTimeFmt.format(end));
  }

  // ---- 詳細內容對話框（一律用 textContent 顯示，避免資料被當成 HTML） ----
  function setText(id, value) {
    const el = $(id);
    el.textContent = value || "—";
    el.classList.toggle("empty", !value);
  }

  function openDetail(r) {
    $("dialog-title").textContent = r.title;
    setText("d-time", formatRange(r));
    setText("d-location", r.location);
    setText("d-status", r.status);
    setText("d-note", r.note);
    setText("d-report", r.report);
    dialog.showModal();
    $("close-btn").focus();
  }

  $("close-btn").addEventListener("click", () => dialog.close());
  // 點對話框外的灰色區域也可關閉
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

  // ---- 日曆 ----
  const narrow = window.matchMedia("(max-width: 559px)").matches;

  function toCalendarEvent(r) {
    const color = cssVar(STATUS_COLOR[r.status] || "--planned");
    return {
      id: r.id,
      title: r.location ? r.title + "｜" + r.location : r.title,
      start: r.start_at,
      end: r.end_at || undefined,
      backgroundColor: color,
      borderColor: color,
      classNames: r.status === "已取消" ? ["ev-cancel"] : [],
      extendedProps: { row: r },
    };
  }

  const calendar = new FullCalendar.Calendar($("calendar"), {
    locale: "zh-tw",
    timeZone: "local",
    initialView: narrow ? "listWeek" : "dayGridMonth",
    height: "auto",
    nowIndicator: true,
    firstDay: 1,
    headerToolbar: narrow
      ? { left: "prev,next today", center: "title", right: "listWeek,dayGridMonth" }
      : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listWeek" },
    buttonText: { today: "今天", month: "月", week: "週", list: "清單" },
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    noEventsContent: "這段期間沒有行程",
    eventClick: (info) => { info.jsEvent.preventDefault(); openDetail(info.event.extendedProps.row); },
    events: async (range, success, failure) => {
      refreshBtn.disabled = true;
      try {
        const { data, error } = await client
          .from(TABLE)
          .select(COLUMNS)
          .gte("start_at", range.start.toISOString())
          .lt("start_at", range.end.toISOString())
          .order("start_at", { ascending: true })
          .limit(1000);
        if (error) {
          showMessage(calMsg, "err", "行程載入失敗：" + explainError(error));
          failure(error);
          return;
        }
        hideMessage(calMsg);
        success((data || []).map(toCalendarEvent));
      } catch (err) {
        showMessage(calMsg, "err", "行程載入失敗：" + explainError(err));
        failure(err);
      } finally {
        refreshBtn.disabled = false;
      }
    },
  });
  calendar.render();

  refreshBtn.addEventListener("click", () => calendar.refetchEvents());
})();
