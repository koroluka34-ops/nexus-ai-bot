"use strict";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:chat-streaks:v1";
const state = { users: {} };
let loaded = false;
let saveChain = Promise.resolve();

function configured() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function url() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function load() {
  if (loaded) return;
  loaded = true;
  if (!configured()) return;
  try {
    const r = await fetch(url(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return;
    if (!r.ok) throw new Error("KV HTTP " + r.status);
    const data = await r.json();
    if (data && data.users && typeof data.users === "object") state.users = data.users;
  } catch (e) { console.error("NEXUS streak load:", e.message); }
}
async function save() {
  if (!configured()) return false;
  const body = JSON.stringify(state);
  const write = async () => {
    const r = await fetch(url(), { method: "PUT", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("KV HTTP " + r.status);
  };
  saveChain = saveChain.then(write, write);
  try { await saveChain; return true; }
  catch (e) { console.error("NEXUS streak save:", e.message); saveChain = Promise.resolve(); return false; }
}
function dayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + "-" + p.month + "-" + p.day;
}
function shift(day, delta) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function countStreak(days, today) {
  const set = new Set(days || []);
  let cursor = set.has(today) ? today : shift(today, -1);
  let count = 0;
  while (set.has(cursor)) { count++; cursor = shift(cursor, -1); }
  return count;
}
function format(data, today) {
  const days = Array.isArray(data.days) ? data.days : [];
  const streak = countStreak(days, today);
  const last = days.length ? days[days.length - 1] : null;
  const gap = last ? Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(last + "T12:00:00Z")) / 86400000) : 999;
  let status = "Напиши мне сегодня, чтобы зажечь первый огонёк.";
  if (gap === 0) status = "Сегодняшний огонёк уже засчитан. Возвращайся завтра!";
  else if (gap === 1) status = "Не пропусти сегодня — серия продолжается!";
  else if (days.length) status = "Старая серия прервалась. Начни новую сегодня!";
  return "🔥 <b>ВАШ ОГОНЁК NEXUS</b>\n\n" +
    "🔥 <b>" + streak + " " + (streak === 1 ? "день подряд" : "дней подряд") + "</b>\n" +
    "📅 Дней общения всего: <b>" + days.length + "</b>\n\n" + status +
    "\n\nОгонёк обновляется один раз в день по времени Киева.";
}
function installStreakSuite(bot) {
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat?.type === "private" && ctx.message) {
      await load();
      const id = String(ctx.from.id);
      const entry = state.users[id] || { days: [] };
      if (!Array.isArray(entry.days)) entry.days = [];
      const today = dayKey();
      if (entry.days[entry.days.length - 1] !== today) {
        entry.days.push(today);
        entry.days = entry.days.slice(-400);
        entry.updatedAt = Date.now();
        state.users[id] = entry;
        await save();
      }
    }
    await next();
  });
  bot.command("streak", async ctx => {
    await load();
    const data = state.users[String(ctx.from.id)] || { days: [] };
    return ctx.reply(format(data, dayKey()), { parse_mode: "HTML" });
  });
}
module.exports = { installStreakSuite };
