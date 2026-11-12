// 報修登記：送出表單到 Supabase 的 repair_requests，並顯示最近 20 筆
(function () {
  "use strict";

  const TABLE = "repair_requests";
  const LIST_LIMIT = 20;

  // 欄位規則需與 supabase/schema.sql 的 CHECK 限制一致
  const CATEGORIES = ["設備", "網路", "環境", "其他"];
  const URGENCIES = ["低", "中", "高"];
  const MAX_LEN = { reporter_name: 50, location: 100, description: 1000 };
  const LABELS = { reporter_name: "報修人", location: "地點或部門", category: "類別", description: "問題說明", urgency: "緊急程度" };

  const form = document.getElementById("repair-form");
  const submitBtn = document.getElementById("submit-btn");
  const formMsg = document.getElementById("form-message");
  const listEl = document.getElementById("repair-list");
  const listMsg = document.getElementById("list-message");
  const refreshBtn = document.getElementById("refresh-btn");
  const desc = document.getElementById("description");
  const descCount = document.getElementById("desc-count");

  function showMessage(el, type, text) {
    el.className = "message " + type;
    el.textContent = text;
    el.hidden = false;
  }
  function hideMessage(el) {
    el.hidden = true;
    el.textContent = "";
  }

  // ---- 建立 Supabase 連線 ----
  function createClient() {
    const cfg = window.APP_CONFIG || {};
    const url = String(cfg.SUPABASE_URL || "");
    const key = String(cfg.SUPABASE_PUBLISHABLE_KEY || "");
    if (!/^https:\/\/\S+$/.test(url)) {
      throw new Error("config.js 的 SUPABASE_URL 尚未設定，應為 https://<專案代號>.supabase.co。");
    }
    if (!key) {
      throw new Error("config.js 的 SUPABASE_PUBLISHABLE_KEY 尚未設定。");
    }
    if (/^sb_secret_/.test(key) || /service_role/.test(key)) {
      throw new Error("config.js 放了 secret 金鑰，請立即撤銷並改用 publishable key。");
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("無法載入 Supabase 程式庫，請檢查網路連線後重新整理。");
    }
    return window.supabase.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  let client = null;
  let setupError = null;
  try {
    client = createClient();
  } catch (err) {
    setupError = err.message;
  }

  // ---- 將資料庫錯誤轉成中文說明 ----
  function explainError(error) {
    if (!error) return "發生未知錯誤，請稍後再試。";
    const code = error.code || "";
    const msg = error.message || "";
    if (code === "42501" || /permission denied|row-level security/i.test(msg)) {
      return "沒有權限執行這個動作，請確認資料表權限設定。";
    }
    if (code === "23514") return "資料不符合規定（選項或字數），請檢查後再送出。";
    if (code === "42P01" || /does not exist|schema cache/i.test(msg)) {
      return "找不到資料表 repair_requests，請先在 Supabase 執行 supabase/schema.sql。";
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return "無法連線到伺服器，請檢查網路後再試。";
    }
    return "發生錯誤：" + msg;
  }

  // ---- 表單驗證 ----
  function setInvalid(name, invalid) {
    const input = form.querySelector('[name="' + name + '"]');
    const field = input && input.closest(".field");
    if (field) field.classList.toggle("invalid", invalid);
  }

  function readForm() {
    const data = {
      reporter_name: form.elements.reporter_name.value.trim(),
      location: form.elements.location.value.trim(),
      category: form.elements.category.value,
      description: form.elements.description.value.trim(),
      urgency: (form.querySelector('input[name="urgency"]:checked') || {}).value || "",
    };
    const problems = [];
    ["reporter_name", "location", "description"].forEach(function (k) {
      let bad = false;
      if (!data[k]) { problems.push("請填寫「" + LABELS[k] + "」"); bad = true; }
      else if (data[k].length > MAX_LEN[k]) { problems.push("「" + LABELS[k] + "」不可超過 " + MAX_LEN[k] + " 字"); bad = true; }
      setInvalid(k, bad);
    });
    const badCat = CATEGORIES.indexOf(data.category) === -1;
    if (badCat) problems.push("請選擇「類別」");
    setInvalid("category", badCat);
    const badUrg = URGENCIES.indexOf(data.urgency) === -1;
    if (badUrg) problems.push("請選擇「緊急程度」");
    return { data: data, problems: problems };
  }

  // ---- 送出 ----
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    hideMessage(formMsg);
    if (setupError) { showMessage(formMsg, "err", setupError); return; }

    const result = readForm();
    if (result.problems.length) {
      showMessage(formMsg, "err", result.problems.join("；") + "。");
      const firstBad = form.querySelector(".field.invalid input, .field.invalid select, .field.invalid textarea");
      if (firstBad) firstBad.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "送出中…";
    try {
      // 只送 5 個欄位；id、created_at、status 由資料庫自動產生
      const { error } = await client.from(TABLE).insert(result.data);
      if (error) {
        showMessage(formMsg, "err", "送出失敗：" + explainError(error));
        return;
      }
      showMessage(formMsg, "ok", "已送出報修，狀態為「待處理」。");
      form.reset();
      updateCount();
      loadList();
    } catch (err) {
      showMessage(formMsg, "err", "送出失敗：" + explainError(err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "送出報修";
    }
  });

  form.addEventListener("input", function (event) {
    const name = event.target.name;
    if (name) setInvalid(name, false);
  });

  function updateCount() { descCount.textContent = String(desc.value.length); }
  desc.addEventListener("input", updateCount);

  // ---- 清單 ----
  const timeFormat = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // 一律用 textContent，避免使用者輸入被當成 HTML
    return node;
  }

  function renderList(rows) {
    listEl.replaceChildren();
    if (!rows.length) {
      showMessage(listMsg, "info", "目前還沒有報修資料。");
      return;
    }
    hideMessage(listMsg);
    rows.forEach(function (r) {
      const li = el("li", "repair-item");
      const top = el("div", "repair-top");
      top.append(
        el("span", "badge", r.category),
        el("span", "badge urgency-" + r.urgency, "緊急：" + r.urgency),
        el("span", "badge", r.status)
      );
      const when = r.created_at ? timeFormat.format(new Date(r.created_at)) : "";
      li.append(
        top,
        el("p", "repair-desc", r.description),
        el("div", "repair-meta", r.reporter_name + "・" + r.location + "・" + when)
      );
      listEl.append(li);
    });
  }

  async function loadList() {
    if (setupError) { showMessage(listMsg, "err", setupError); return; }
    refreshBtn.disabled = true;
    showMessage(listMsg, "info", "載入中…");
    try {
      const { data, error } = await client
        .from(TABLE)
        .select("id, created_at, reporter_name, location, category, description, urgency, status")
        .order("created_at", { ascending: false })
        .limit(LIST_LIMIT);
      if (error) {
        showMessage(listMsg, "err", "清單載入失敗：" + explainError(error));
        return;
      }
      renderList(data || []);
    } catch (err) {
      showMessage(listMsg, "err", "清單載入失敗：" + explainError(err));
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", loadList);
  updateCount();
  loadList();
})();
