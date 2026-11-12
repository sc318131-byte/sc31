// PWA：註冊 Service Worker，並在可以安裝時顯示「安裝 App」按鈕
(function () {
  "use strict";

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function (err) {
        console.warn("Service Worker 註冊失敗：", err);
      });
    });
  }

  const btn = document.getElementById("install-btn");
  const tip = document.getElementById("install-tip");
  if (!btn) return;

  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) return; // 已經是 App 模式，不用再提示

  // Android／電腦版 Chrome、Edge：瀏覽器允許安裝時才顯示按鈕
  let deferred = null;
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferred = event;
    btn.hidden = false;
  });

  btn.addEventListener("click", async function () {
    if (!deferred) return;
    btn.hidden = true;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
  });

  window.addEventListener("appinstalled", function () {
    btn.hidden = true;
    if (tip) tip.hidden = true;
  });

  // iPhone／iPad 的 Safari 沒有安裝按鈕，改顯示操作說明
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS && tip) {
    tip.textContent = "加到主畫面：點 Safari 下方的「分享」，再選「加入主畫面」。";
    tip.hidden = false;
  }
})();
