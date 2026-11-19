// LINE Webhook（Supabase Edge Function）：自動取得並綁定管理者的 LINE userId
//
// 流程：
//   1. 管理者把 LINE 官方帳號加為好友。
//   2. 管理者傳訊息「綁定 <綁定碼>」給官方帳號（例如：綁定 a8Kq2mZ7pX4r）。
//   3. LINE 把訊息送到這個 Webhook；檢查簽章與綁定碼都正確後，
//      把傳訊者的 userId 存進資料庫（public.line_set_admin），並回覆「綁定成功」。
//   4. line-reminder 之後就把提醒推播給這個 userId。
//
// 安全：
//   - 每個請求都用 Channel secret 驗證 X-Line-Signature，不是 LINE 送來的一律拒絕。
//   - 只有知道綁定碼的人能綁定；陌生人加好友亂傳訊息不會影響設定。
//   - 只接受一對一聊天的訊息，群組裡的訊息不處理。
//
// 需要在 Supabase 設定的 secrets：
//   LINE_CHANNEL_SECRET        Basic settings 分頁的 Channel secret（驗證簽章用）
//   LINE_CHANNEL_ACCESS_TOKEN  與 line-reminder 共用（回覆訊息用）
//   LINE_BIND_CODE             自訂的綁定碼，至少 8 個字元
// SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供。
// 部署時要關閉 Verify JWT（LINE 不會帶 Supabase 的登入權杖）。
//
// 不載入 supabase-js：LINE 只等幾秒，冷啟動時載入大型套件會讓 Verify 逾時，
// 所以直接用 fetch 呼叫資料庫的 RPC。

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const enc = new TextEncoder();

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

// 比較時不因長度或內容提早結束，避免時間差洩漏
function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// LINE 簽章：以 Channel secret 對原始內容做 HMAC-SHA256，再轉 base64
async function validSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return safeEqual(btoa(bin), signature);
}

async function reply(token: string, replyToken: string, text: string): Promise<void> {
  const res = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.error(`LINE 回覆失敗 ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// 呼叫資料庫函式 line_set_admin（以 service_role 身分）；成功回傳 null，失敗回傳錯誤說明
async function saveAdmin(userId: string): Promise<string | null> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/line_set_admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (res.ok) return null;
  return `${res.status} ${(await res.text()).slice(0, 300)}`;
}

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
};

// 統一全形／半形並去掉前後空白，避免手機全形輸入或 secret 多了換行就比對失敗
function normalize(text: string): string {
  return text.normalize("NFKC").trim();
}

// 「綁定 碼」或「綁定碼」都接受，全形空白也可以
const BIND_PATTERN = /^綁定[\s　]*(.+)$/;

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const body = await req.text();
    const signature = req.headers.get("x-line-signature") ?? "";
    if (!signature || !(await validSignature(body, signature, env("LINE_CHANNEL_SECRET")))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const bindCode = normalize(env("LINE_BIND_CODE"));
    if (bindCode.length < 8) throw new Error("LINE_BIND_CODE 至少要 8 個字元");
    const lineToken = env("LINE_CHANNEL_ACCESS_TOKEN");
    const events: LineEvent[] = (JSON.parse(body).events ?? []);
    // LINE 後台按「Verify」時 events 是空的，直接回 200

    for (const e of events) {
      if (e.type !== "message" || e.message?.type !== "text") continue;
      if (e.source?.type !== "user" || !e.source.userId || !e.replyToken) continue;

      const match = normalize(e.message.text ?? "").match(BIND_PATTERN);
      if (!match) continue; // 不是綁定指令：不回應，交給官方帳號原本的設定

      const typed = normalize(match[1]);
      if (!safeEqual(typed, bindCode)) {
        // 只記錄長度，不記錄內容，方便判斷是打錯字還是 secret 多了字元
        console.warn(`綁定碼錯誤：輸入 ${typed.length} 個字元，設定值 ${bindCode.length} 個字元`, e.source.userId.slice(0, 5) + "…");
        await reply(lineToken, e.replyToken, "綁定碼不正確，請向系統管理者確認後再試。");
        continue;
      }

      const error = await saveAdmin(e.source.userId);
      if (error) {
        console.error("儲存管理者失敗", error);
        await reply(lineToken, e.replyToken, "綁定失敗，請稍後再試，或請系統管理者確認已執行 supabase/line-admin.sql。");
        continue;
      }
      console.log("已綁定管理者", e.source.userId.slice(0, 5) + "…");
      await reply(lineToken, e.replyToken, "綁定成功！之後董事長行程的提醒會傳到這個 LINE。");
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    // 設定錯誤（缺 secret 等）回 500，LINE 後台按 Verify 時才看得出來；詳細原因在 Logs
    console.error(err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
});
