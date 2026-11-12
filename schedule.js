// 董事長行程：登入、日曆顯示、新增／編輯／刪除行程
// 資料表 chairman_events 只有名單內的登入帳號能存取（見 supabase/schedule.sql）。
(function () {
  "use strict";

  const TABLE = "chairman_events";
  const STATUSES = ["預定", "已完成", "已取消"];
  const STATUS_COLOR = { "預定": "--planned", "已完成": "--done", "已取消": "--cancel" };
  const $ = (id) => document.getElementById(id);

  const loginView = $("login-view");
  const calView = $("calendar-view");
  const loginForm = $("login-form");
  const loginBtn = $("login-btn");
  const loginMsg = $("login-message");
  const calMsg = $("cal-message");
  const dialog = $("event-dialog");
  const form = $("event-form");
  const dialogMsg = $("dialog-message");
  const saveBtn = $("save-btn");
  const deleteBtn = $("delete-btn");
  const remindState = $("remind-state");

  function showMessage(el, type, text) { el.className = "message " + type; el.textContent = text; el.hidden = false; }
  function hideMessage(el) { el.hidden = true; el.textContent = ""; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---- Supabase 連線 ----
  let client = null;
  let setupError = null;
  try {
    const cfg = window.APP_CONFIG || {};
    const url = String(cfg.SUPABASE_URL || "");
    const key = String(cfg.SUPABASE_PUBLISHABLE_KEY || "");
    if (!/^https:\/\/\S+$/.test(url) || !key) throw new Error("config.js 的 Supabase 設定不完整。");
    if (/^sb_secret_/.test(key) || /service_role/.test(key)) throw new Error("config.js 放了 secret 金鑰，請立即撤銷並改用 publishable key。");
    if (!window.supabase || !window.FullCalendar) throw new Error("無法載入必要的程式庫，請檢查網路連線後重新整理。");
    client = window.supabase.createClient(url, key);
  } catch (err) {
    setupError = err.message;
  }

  function explainError(error) {
    if (!error) return "發生未知錯誤，請稍後再試。";
    const code = error.code || "";
    const msg = error.message || "";
    if (/Invalid login credentials/i.test(msg)) return "電子郵件或密碼錯誤。";
    if (/Email not confirmed/i.test(msg)) return "這個帳號的電子郵件尚未驗證，請聯絡管理者。";
    if (code === "42501" || /permission denied|row-level security/i.test(msg)) return "沒有權限執行這個動作。";
    if (code === "23514") return "資料不符合規定（字數、時間順序或選項），請檢查後再試。";
    if (code === "42P01" || /does not exist|schema cache/i.test(msg)) return "找不到行程資料表，請先在 Supabase 執行 supabase/schedule.sql。";
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "無法連線到伺服器，請檢查網路後再試。";
    return "發生錯誤：" + msg;
  }

  // ---- 時間轉換：datetime-local 使用裝置當地時間 ----
  function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fromLocalInput(value) { return value ? new Date(value).toISOString() : null; }

  // ---- 日曆 ----
  let calendar = null;
  const narrow = () => window.matchMedia("(max-width: 559px)").matches;

  function toCalendarEvent(r) {
    const color = cssVar(STATUS_COLOR[r.status] || "--planned");
    return {
      id: r.id,
      title: (r.location ? r.title + "｜" + r.location : r.title),
      start: r.start_at,
      end: r.end_at || undefined,
      backgroundColor: color,
      borderColor: color,
      classNames: r.status === "已取消" ? ["ev-cancel"] : [],
      extendedProps: { row: r },
    };
  }

  function buildCalendar() {
    calendar = new FullCalendar.Calendar($("calendar"), {
      locale: "zh-tw",
      timeZone: "local",
      initialView: narrow() ? "listWeek" : "dayGridMonth",
      height: "auto",
      nowIndicator: true,
      firstDay: 1,
      headerToolbar: narrow()
        ? { left: "prev,next today", center: "title", right: "listWeek,dayGridMonth" }
        : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listWeek" },
      buttonText: { today: "今天", month: "月", week: "週", list: "清單" },
      eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
      noEventsContent: "這段期間沒有行程",
      dateClick: (info) => {
        const start = new Date(info.date);
        if (info.allDay) start.setHours(9, 0, 0, 0);
        openDialog(null, start);
      },
      eventClick: (info) => { info.jsEvent.preventDefault(); openDialog(info.event.extendedProps.row); },
      events: async (range, success, failure) => {
        const { data, error } = await client
          .from(TABLE)
          .select("id, title, start_at, end_at, location, note, status, report, remind_minutes, reminded_at")
          .gte("start_at", range.start.toISOString())
          .lt("start_at", range.end.toISOString())
          .order("start_at", { ascending: true })
          .limit(1000);
        if (error) {
          showMessage(calMsg, "err", "行程載入失敗：" + explainError(error));
          failure(error);
          return;
        }
        // 只清掉先前的載入錯誤，保留「已新增／已更新」這類成功訊息
        if (calMsg.classList.contains("err")) hideMessage(calMsg);
        success((data || []).map(toCalendarEvent));
      },
    });
    calendar.render();
  }

  // ---- 新增／編輯對話框 ----
  let editing = null;
  let deleteArmed = false;

  function setDeleteArmed(on) {
    deleteArmed = on;
    deleteBtn.textContent = on ? "確定刪除？" : "刪除";
    deleteBtn.classList.toggle("confirm", on);
  }

  function openDialog(row, startDate) {
    editing = row;
    hideMessage(dialogMsg);
    setDeleteArmed(false);
    form.reset();
    $("dialog-title").textContent = row ? "編輯行程" : "新增行程";
    deleteBtn.hidden = !row;
    if (row) {
      $("ev-title").value = row.title;
      $("ev-start").value = toLocalInput(row.start_at);
      $("ev-end").value = toLocalInput(row.end_at);
      $("ev-location").value = row.location || "";
      $("ev-remind").value = row.remind_minutes == null ? "" : String(row.remind_minutes);
      if (!$("ev-remind").value && row.remind_minutes != null) {
        // 資料庫裡是自訂的分鐘數，臨時加一個選項顯示
        const opt = new Option(row.remind_minutes + " 分鐘前", String(row.remind_minutes));
        $("ev-remind").add(opt);
        $("ev-remind").value = String(row.remind_minutes);
      }
      $("ev-status").value = row.status;
      $("ev-note").value = row.note || "";
      $("ev-report").value = row.report || "";
      remindState.hidden = !row.reminded_at;
      if (row.reminded_at) {
        remindState.textContent = "LINE 提醒已於 " + new Date(row.reminded_at).toLocaleString("zh-TW", { hour12: false }) + " 發送；修改開始時間或提醒設定會重新提醒。";
      }
    } else {
      remindState.hidden = true;
      if (startDate) $("ev-start").value = toLocalInput(startDate.toISOString());
    }
    dialog.showModal();
    $("ev-title").focus();
  }

  function readForm() {
    const v = (id) => $(id).value.trim();
    const data = {
      title: v("ev-title"),
      start_at: fromLocalInput($("ev-start").value),
      end_at: fromLocalInput($("ev-end").value),
      location: v("ev-location") || null,
      note: v("ev-note") || null,
      report: v("ev-report") || null,
      status: $("ev-status").value,
      remind_minutes: $("ev-remind").value === "" ? null : Number($("ev-remind").value),
    };
    const problems = [];
    if (!data.title) problems.push("請填寫「行程名稱」");
    if (!data.start_at) problems.push("請選擇「開始」時間");
    if (data.start_at && data.end_at && data.end_at < data.start_at) problems.push("「結束」不能早於「開始」");
    if (STATUSES.indexOf(data.status) === -1) problems.push("狀態不正確");
    return { data, problems };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage(dialogMsg);
    const { data, problems } = readForm();
    if (problems.length) { showMessage(dialogMsg, "err", problems.join("；") + "。"); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = "儲存中…";
    try {
      const query = editing
        ? client.from(TABLE).update(data).eq("id", editing.id)
        : client.from(TABLE).insert(data);
      const { error } = await query;
      if (error) { showMessage(dialogMsg, "err", "儲存失敗：" + explainError(error)); return; }
      dialog.close();
      showMessage(calMsg, "ok", editing ? "已更新行程。" : "已新增行程。");
      calendar.refetchEvents();
    } catch (err) {
      showMessage(dialogMsg, "err", "儲存失敗：" + explainError(err));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "儲存";
    }
  });

  deleteBtn.addEventListener("click", async () => {
    if (!editing) return;
    if (!deleteArmed) { setDeleteArmed(true); return; }
    deleteBtn.disabled = true;
    try {
      const { error } = await client.from(TABLE).delete().eq("id", editing.id);
      if (error) { showMessage(dialogMsg, "err", "刪除失敗：" + explainError(error)); return; }
      dialog.close();
      showMessage(calMsg, "ok", "已刪除行程。");
      calendar.refetchEvents();
    } finally {
      deleteBtn.disabled = false;
      setDeleteArmed(false);
    }
  });

  $("cancel-btn").addEventListener("click", () => dialog.close());
  $("add-btn").addEventListener("click", () => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    openDialog(null, start);
  });

  // ---- 登入／登出 ----
  async function showSignedIn(session) {
    const { data: allowed, error } = await client.rpc("is_schedule_editor");
    if (error || !allowed) {
      await client.auth.signOut();
      showLogin(error ? "無法確認權限：" + explainError(error) : "這個帳號沒有查看行程的權限，請聯絡管理者。");
      return;
    }
    $("who-email").textContent = session.user.email || "";
    loginView.hidden = true;
    calView.hidden = false;
    if (!calendar) buildCalendar(); else calendar.refetchEvents();
  }

  function showLogin(message) {
    calView.hidden = true;
    loginView.hidden = false;
    if (message) showMessage(loginMsg, "err", message); else hideMessage(loginMsg);
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage(loginMsg);
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) { showMessage(loginMsg, "err", "請輸入電子郵件和密碼。"); return; }
    loginBtn.disabled = true;
    loginBtn.textContent = "登入中…";
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) { showMessage(loginMsg, "err", "登入失敗：" + explainError(error)); return; }
      $("login-password").value = "";
      await showSignedIn(data.session);
    } catch (err) {
      showMessage(loginMsg, "err", "登入失敗：" + explainError(err));
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "登入";
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await client.auth.signOut();
    if (calendar) calendar.removeAllEvents();
    showLogin();
  });

  // ---- 啟動 ----
  (async () => {
    if (setupError) { loginView.hidden = false; showMessage(loginMsg, "err", setupError); loginBtn.disabled = true; return; }
    const { data } = await client.auth.getSession();
    if (data.session) await showSignedIn(data.session); else showLogin();
  })();
})();
