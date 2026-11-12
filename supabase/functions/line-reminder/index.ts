// LINE 行程提醒（Supabase Edge Function）
//
// 由 supabase/cron.sql 的排程每 5 分鐘呼叫一次：
//   1. 找出「已到提醒時間、還沒提醒過、狀態為預定、尚未開始」的董事長行程。
//   2. 先把 reminded_at 填上（搶到的才發），避免兩次排程重疊時重複發送。
//   3. 用 LINE Messaging API 推播給管理者一人。
//   4. 推播失敗時把 reminded_at 清回空白，下一輪再試。
//
// 需要在 Supabase 設定的 secrets（supabase secrets set …）：
//   LINE_CHANNEL_ACCESS_TOKEN  LINE Messaging API 的 Channel access token
//   LINE_ADMIN_USER_ID         接收通知的管理者 LINE userId（U 開頭 33 碼）
//   CRON_SECRET                排程呼叫時帶的密碼，防止外人觸發
// SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動提供。

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const BATCH_LIMIT = 20;
// 開始時間已過這麼久的行程不再補發（例如排程停擺後恢復）
const LATE_GRACE_MINUTES = 10;

type EventRow = {
  id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  note: string | null;
  remind_minutes: number;
};

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

// 比較密碼時不因長度或內容提早結束，避免時間差洩漏
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const taipei = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const taipeiTime = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// 依「實際剩下的時間」描述，排程晚幾分鐘執行也不會講錯
function describeLead(msUntilStart: number): string {
  const minutes = Math.round(msUntilStart / 60_000);
  if (minutes <= 1) return "即將開始";
  if (minutes < 60) return `${minutes} 分鐘後開始`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小時 ${rest} 分鐘後開始` : `${hours} 小時後開始`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時後開始`.replace(" 0 小時", "");
}

function buildMessage(e: EventRow, now: number): string {
  const start = new Date(e.start_at);
  const lines = [
    `【董事長行程提醒】${describeLead(start.getTime() - now)}`,
    `行程：${e.title}`,
    `時間：${taipei.format(start)}` + (e.end_at ? ` – ${taipeiTime.format(new Date(e.end_at))}` : ""),
  ];
  if (e.location) lines.push(`地點：${e.location}`);
  if (e.note) lines.push(`備註：${e.note.length > 200 ? e.note.slice(0, 200) + "…" : e.note}`);
  return lines.join("\n");
}

async function pushLine(token: string, to: string, text: string): Promise<void> {
  const res = await fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE 推播失敗 ${res.status}: ${body.slice(0, 300)}`);
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const secret = req.headers.get("x-cron-secret") ?? "";
    if (!safeEqual(secret, env("CRON_SECRET"))) return new Response("Unauthorized", { status: 401 });

    const lineToken = env("LINE_CHANNEL_ACCESS_TOKEN");
    const adminId = env("LINE_ADMIN_USER_ID");
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const now = Date.now();
    // 先抓「開始時間在 7 天內、還沒開始太久」的候選，再在程式裡精確判斷提醒時間
    const { data, error } = await db
      .from("chairman_events")
      .select("id, title, start_at, end_at, location, note, remind_minutes")
      .eq("status", "預定")
      .is("reminded_at", null)
      .not("remind_minutes", "is", null)
      .gte("start_at", new Date(now - LATE_GRACE_MINUTES * 60_000).toISOString())
      .lte("start_at", new Date(now + 10080 * 60_000).toISOString())
      .order("start_at", { ascending: true })
      .limit(200);
    if (error) throw error;

    const due = (data as EventRow[])
      .filter((e) => new Date(e.start_at).getTime() - e.remind_minutes * 60_000 <= now)
      .slice(0, BATCH_LIMIT);

    const results: { id: string; sent: boolean; error?: string }[] = [];
    for (const e of due) {
      // 搶占：只有 reminded_at 還是空的那一次會成功
      const claimedAt = new Date().toISOString();
      const { data: claimed, error: claimErr } = await db
        .from("chairman_events")
        .update({ reminded_at: claimedAt })
        .eq("id", e.id)
        .is("reminded_at", null)
        .select("id");
      if (claimErr) { results.push({ id: e.id, sent: false, error: claimErr.message }); continue; }
      if (!claimed || claimed.length === 0) continue; // 已被另一輪處理

      try {
        await pushLine(lineToken, adminId, buildMessage(e, Date.now()));
        results.push({ id: e.id, sent: true });
      } catch (err) {
        // 發送失敗：還原，下一輪重試
        await db.from("chairman_events").update({ reminded_at: null })
          .eq("id", e.id).eq("reminded_at", claimedAt);
        results.push({ id: e.id, sent: false, error: (err as Error).message });
      }
    }

    console.log(JSON.stringify({ checked: data?.length ?? 0, due: due.length, results }));
    return Response.json({ checked: data?.length ?? 0, due: due.length, results });
  } catch (err) {
    console.error(err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
});
