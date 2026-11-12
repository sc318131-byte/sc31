// Service Worker：讓「報修登記」與「董事長行程」可以安裝成 App，並在離線時開得起來。
//
// 快取規則：
//   - 本站檔案（HTML、CSS、JS、圖示）：先上網拿最新版，失敗才用快取。更新程式後重新整理就生效。
//   - CDN 程式庫（固定版本）：先用快取，沒有才下載。版本號寫死，內容不會變。
//   - Supabase（資料）：一律不快取，每次都顯示最新的報修與行程，也不在手機留下資料。
//
// 改了要預先快取的檔案清單時，把 CACHE_VERSION 加 1，舊快取會在啟用時清掉。

const CACHE_VERSION = "v2";
const CACHE_NAME = "sc31-" + CACHE_VERSION;

const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./schedule.html",
  "./schedule.css",
  "./schedule.js",
  "./pwa.js",
  "./manifest-repair.webmanifest",
  "./manifest-schedule.webmanifest",
  "./icons/repair-192.png",
  "./icons/repair-512.png",
  "./icons/schedule-192.png",
  "./icons/schedule-512.png",
];

// 固定版本的 CDN 程式庫，安裝時一併下載，第一次開啟後就能離線使用
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js",
  "https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.15/locales/zh-tw.global.min.js",
];

const CDN_PREFIXES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/",
  "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/",
  "https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.15/",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(PRECACHE);
        // CDN 暫時連不上時不要讓安裝失敗，之後開啟頁面時會再補進快取
        await cache.addAll(CDN_FILES).catch((err) => console.warn("CDN 預先快取失敗：", err));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("sc31-") && k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Supabase 與其他外部網站：不經過快取
  if (url.origin !== self.location.origin) {
    if (CDN_PREFIXES.some((p) => req.url.startsWith(p))) event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // 離線又沒有快取的網址：導覽請求退回對應的首頁
    if (req.mode === "navigate") {
      const page = isSchedulePage(req.url) ? "./schedule.html" : "./index.html";
      const fallback = await cache.match(page);
      if (fallback) return fallback;
    }
    throw err;
  }
}

function isSchedulePage(href) {
  return new URL(href).pathname.endsWith("schedule.html");
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  // <script> 載入的跨網域檔案可能是 opaque 回應（status 0），一樣可以快取
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
