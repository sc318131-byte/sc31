// 董事長行程：不用登入就能查看；新增、修改、刪除要輸入共用通行碼。
// 讀取：資料表 chairman_events 對 anon 只開放部分欄位（supabase/schedule.sql）。
// 寫入：網頁不能直接寫資料表，只能呼叫附上通行碼的函式（supabase/schedule-passcode.sql），
//       通行碼在資料庫端比對。
(function () {
  "use strict";

  const TABLE = "chairman_events";
  // 只讀這些欄位；資料庫也只開放這些欄位給未登入的訪客
  const COLUMNS = "id, title, start_at, end_at, location, note, status, report, remind_minutes";
  const STATUSES = ["預定", "已完成", "已取消"];
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
    if (code === "42883" || /Could not find the function/i.test(msg)) return "資料庫還沒加入編輯功能，請先在 Supabase 執行 supabase/schedule-passcode.sql。";
    if (code === "23514") return "資料不符合規定（字數、時間順序或選項），請檢查後再試。";
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

  let detailRow = null;

  function openDetail(r) {
    detailRow = r;
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
  $("edit-btn").addEventListener("click", () => { const r = detailRow; dialog.close(); startEdit(r); });
  // 點對話框外的灰色區域也可關閉
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

  // ---- 通行碼：輸入一次後，這個分頁（或勾選記住的裝置）不用再輸入 ----
  const PASS_KEY = "schedule-passcode";
  const passDialog = $("passcode-dialog");
  const passForm = $("passcode-form");
  const passInput = $("passcode-input");
  const passRemember = $("passcode-remember");
  const passMsg = $("passcode-message");
  const passSubmit = $("passcode-submit");
  const unlockState = $("unlock-state");
  let passResolve = null;

  function storedPasscode() {
    for (const store of [() => sessionStorage, () => localStorage]) {
      try { const v = store().getItem(PASS_KEY); if (v) return v; } catch (e) { /* 瀏覽器不允許儲存時略過 */ }
    }
    return memoryPasscode;
  }
  let memoryPasscode = "";
  function savePasscode(value, remember) {
    memoryPasscode = value;
    try { sessionStorage.setItem(PASS_KEY, value); } catch (e) { /* 略過 */ }
    try { if (remember) localStorage.setItem(PASS_KEY, value); else localStorage.removeItem(PASS_KEY); } catch (e) { /* 略過 */ }
    unlockState.hidden = false;
  }
  function forgetPasscode() {
    memoryPasscode = "";
    try { sessionStorage.removeItem(PASS_KEY); } catch (e) { /* 略過 */ }
    try { localStorage.removeItem(PASS_KEY); } catch (e) { /* 略過 */ }
    unlockState.hidden = true;
  }
  unlockState.hidden = !storedPasscode();
  $("lock-btn").addEventListener("click", () => { forgetPasscode(); showMessage(calMsg, "ok", "已鎖定編輯。"); });

  const PASS_ERRORS = {
    wrong_passcode: "通行碼錯誤，請再試一次。",
    locked: "錯誤次數太多，編輯已暫停 15 分鐘，請稍後再試。",
    not_configured: "管理者還沒設定通行碼。",
    not_found: "找不到這筆行程，可能已被刪除，請重新整理。",
  };

  // 回傳通行碼；沒有存過就跳出輸入框，使用者取消時回傳 null
  function askPasscode(message) {
    const saved = storedPasscode();
    if (saved && !message) return Promise.resolve(saved);
    passForm.reset();
    if (message) showMessage(passMsg, "err", message); else hideMessage(passMsg);
    passDialog.showModal();
    passInput.focus();
    return new Promise((resolve) => { passResolve = resolve; });
  }
  function finishPasscode(value) {
    const resolve = passResolve;
    passResolve = null;
    if (passDialog.open) passDialog.close();
    if (resolve) resolve(value);
  }

  passForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = passInput.value;
    if (!value) { showMessage(passMsg, "err", "請輸入通行碼。"); return; }
    passSubmit.disabled = true;
    passSubmit.textContent = "確認中…";
    try {
      const { data, error } = await client.rpc("schedule_check_passcode", { p_passcode: value });
      if (error) { showMessage(passMsg, "err", explainError(error)); return; }
      if (!data || !data.ok) { showMessage(passMsg, "err", PASS_ERRORS[data && data.error] || "通行碼無法確認。"); return; }
      savePasscode(value, passRemember.checked);
      finishPasscode(value);
    } catch (err) {
      showMessage(passMsg, "err", explainError(err));
    } finally {
      passSubmit.disabled = false;
      passSubmit.textContent = "確認";
    }
  });
  $("passcode-cancel").addEventListener("click", () => finishPasscode(null));
  passDialog.addEventListener("cancel", () => finishPasscode(null));

  // ---- 新增／編輯 ----
  const editDialog = $("edit-dialog");
  const editForm = $("edit-form");
  const editMsg = $("edit-message");
  const saveBtn = $("save-btn");
  const deleteBtn = $("delete-btn");
  let editing = null;
  let deleteArmed = false;

  function toLocalInput(value) {
    if (!value) return "";
    const d = new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fromLocalInput(value) { return value ? new Date(value).toISOString() : null; }

  function setDeleteArmed(on) {
    deleteArmed = on;
    deleteBtn.textContent = on ? "確定刪除？" : "刪除";
    deleteBtn.classList.toggle("confirm", on);
  }

  function fillForm(row, startDate) {
    editForm.reset();
    hideMessage(editMsg);
    setDeleteArmed(false);
    $("edit-title").textContent = row ? "編輯行程" : "新增行程";
    deleteBtn.hidden = !row;
    // 移除上次臨時加入的自訂提醒選項
    Array.from($("ev-remind").options).filter((o) => o.dataset.custom).forEach((o) => o.remove());
    if (row) {
      $("ev-title").value = row.title;
      $("ev-start").value = toLocalInput(row.start_at);
      $("ev-end").value = toLocalInput(row.end_at);
      $("ev-location").value = row.location || "";
      const remind = row.remind_minutes == null ? "" : String(row.remind_minutes);
      if (remind && !Array.from($("ev-remind").options).some((o) => o.value === remind)) {
        const opt = new Option(remind + " 分鐘前", remind);
        opt.dataset.custom = "1";
        $("ev-remind").add(opt);
      }
      $("ev-remind").value = remind;
      $("ev-status").value = STATUSES.includes(row.status) ? row.status : "預定";
      $("ev-note").value = row.note || "";
      $("ev-report").value = row.report || "";
    } else if (startDate) {
      $("ev-start").value = toLocalInput(startDate);
    }
  }

  async function startEdit(row, startDate) {
    hideMessage(calMsg);
    const passcode = await askPasscode();
    if (!passcode) return;
    editing = row || null;
    fillForm(editing, startDate);
    editDialog.showModal();
    $("ev-title").focus();
  }

  function readForm() {
    const v = (id) => $(id).value.trim();
    const data = {
      title: v("ev-title"),
      start_at: fromLocalInput($("ev-start").value),
      end_at: fromLocalInput($("ev-end").value),
      location: v("ev-location"),
      note: v("ev-note"),
      report: v("ev-report"),
      status: $("ev-status").value,
      remind_minutes: $("ev-remind").value === "" ? null : Number($("ev-remind").value),
    };
    const problems = [];
    if (!data.title) problems.push("請填寫「行程名稱」");
    if (!data.start_at) problems.push("請選擇「開始」時間");
    if (data.start_at && data.end_at && data.end_at < data.start_at) problems.push("「結束」不能早於「開始」");
    if (!STATUSES.includes(data.status)) problems.push("狀態不正確");
    return { data, problems };
  }

  // 呼叫寫入函式；通行碼失效時清掉並請使用者重新輸入一次
  async function callWrite(fn, args) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const passcode = attempt === 0 ? await askPasscode() : await askPasscode(PASS_ERRORS.wrong_passcode);
      if (!passcode) return { cancelled: true };
      const { data, error } = await client.rpc(fn, Object.assign({ p_passcode: passcode }, args));
      if (error) return { message: explainError(error) };
      if (data && data.ok) return { ok: true };
      const code = data && data.error;
      if (code !== "wrong_passcode") return { message: PASS_ERRORS[code] || "儲存失敗，請稍後再試。" };
      forgetPasscode();
      if (attempt === 1) return { message: PASS_ERRORS.wrong_passcode };
    }
    return { message: PASS_ERRORS.wrong_passcode };
  }

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage(editMsg);
    const { data, problems } = readForm();
    if (problems.length) { showMessage(editMsg, "err", problems.join("；") + "。"); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "儲存中…";
    try {
      const result = editing
        ? await callWrite("schedule_update_event", { p_id: editing.id, p_event: data })
        : await callWrite("schedule_create_event", { p_event: data });
      if (result.cancelled) return;
      if (!result.ok) { showMessage(editMsg, "err", "儲存失敗：" + result.message); return; }
      editDialog.close();
      showMessage(calMsg, "ok", editing ? "已更新行程。" : "已新增行程。");
      calendar.refetchEvents();
    } catch (err) {
      showMessage(editMsg, "err", "儲存失敗：" + explainError(err));
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
      const result = await callWrite("schedule_delete_event", { p_id: editing.id });
      if (result.cancelled) return;
      if (!result.ok) { showMessage(editMsg, "err", "刪除失敗：" + result.message); return; }
      editDialog.close();
      showMessage(calMsg, "ok", "已刪除行程。");
      calendar.refetchEvents();
    } catch (err) {
      showMessage(editMsg, "err", "刪除失敗：" + explainError(err));
    } finally {
      deleteBtn.disabled = false;
      setDeleteArmed(false);
    }
  });

  $("edit-cancel").addEventListener("click", () => editDialog.close());
  $("add-btn").addEventListener("click", () => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    startEdit(null, start);
  });

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

  // ---- 行程表：列出日曆目前月份或週裡的行程 ----
  const tableRows = $("event-rows");
  const tableEl = $("event-table");
  const tableEmpty = $("table-empty");
  const tableTitle = $("table-title");
  const tableCount = $("table-count");
  const dayFmt = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", weekday: "short" });

  function cell(tag, text, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text; // 一律用 textContent，避免資料被當成 HTML
    return el;
  }

  function timeText(r) {
    const start = new Date(r.start_at);
    if (!r.end_at) return timeFmt.format(start);
    const end = new Date(r.end_at);
    return timeFmt.format(start) + "–" + (sameDay(start, end) ? timeFmt.format(end) : dayFmt.format(end) + " " + timeFmt.format(end));
  }

  function renderTable() {
    const view = calendar.view;
    // 月檢視會帶出前後月的幾天，表格只列本月（或本週）
    const from = view.currentStart.getTime();
    const to = view.currentEnd.getTime();
    const rows = calendar.getEvents()
      .map((e) => e.extendedProps.row)
      .filter((r) => { const t = new Date(r.start_at).getTime(); return t >= from && t < to; })
      .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

    tableTitle.textContent = view.title + " 行程表";
    tableCount.textContent = rows.length ? "共 " + rows.length + " 筆" : "";
    tableRows.replaceChildren();
    tableEl.hidden = rows.length === 0;
    tableEmpty.hidden = rows.length !== 0;

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      if (r.status === "已取消") tr.className = "is-cancel";
      const titleCell = document.createElement("td");
      titleCell.className = "c-title";
      // 行程名稱做成按鈕：可用鍵盤或點擊開啟詳細內容
      const btn = cell("button", r.title, "row-link");
      btn.type = "button";
      btn.addEventListener("click", () => openDetail(r));
      titleCell.append(btn);
      const statusCell = document.createElement("td");
      statusCell.className = "c-status";
      statusCell.append(cell("span", r.status, "pill " + ({ "預定": "s-planned", "已完成": "s-done", "已取消": "s-cancel" }[r.status] || "")));
      tr.append(
        cell("td", dayFmt.format(new Date(r.start_at)), "c-date"),
        cell("td", timeText(r), "c-time"),
        titleCell,
        cell("td", r.location || "—", r.location ? "c-loc" : "c-loc empty"),
        statusCell
      );
      tableRows.append(tr);
    });
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
    // 點日曆上的空白日期：新增那天的行程（整天格子預設早上 9 點）
    dateClick: (info) => {
      const start = new Date(info.date);
      if (info.allDay) start.setHours(9, 0, 0, 0);
      startEdit(null, start);
    },
    // 載入完行程或切換月份／週時，更新下方的行程表
    eventsSet: () => renderTable(),
    datesSet: () => renderTable(),
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
        // 只清掉先前的載入錯誤，保留「已新增／已更新」這類成功訊息
        if (calMsg.classList.contains("err")) hideMessage(calMsg);
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
