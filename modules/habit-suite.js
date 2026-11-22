"use strict";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:habits:v1";
const state = { users: {} };
let loaded = false;
let saveChain = Promise.resolve();

function ready() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function load() {
  if (loaded) return;
  loaded = true;
  if (!ready()) return;
  try {
    const r = await fetch(kvUrl(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return;
    if (!r.ok) throw new Error("KV HTTP " + r.status);
    const v = await r.json();
    if (v && v.users && typeof v.users === "object") state.users = v.users;
  } catch (e) { console.error("NEXUS habits load:", e.message); }
}
async function save() {
  if (!ready()) return false;
  const snapshot = JSON.stringify(state);
  const write = async () => {
    const r = await fetch(kvUrl(), {
      method: "PUT", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: snapshot, signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) throw new Error("KV HTTP " + r.status);
  };
  saveChain = saveChain.then(write, write);
  try { await saveChain; return true; }
  catch (e) { console.error("NEXUS habits save:", e.message); saveChain = Promise.resolve(); return false; }
}
function todayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + "-" + p.month + "-" + p.day;
}
function shiftDay(key, delta) {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function streak(days, today) {
  const set = new Set(days || []);
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  let count = 0;
  while (set.has(cursor)) { count++; cursor = shiftDay(cursor, -1); }
  return count;
}
function user(id) {
  const k = String(id);
  if (!state.users[k]) state.users[k] = { habits: [] };
  if (!Array.isArray(state.users[k].habits)) state.users[k].habits = [];
  return state.users[k];
}
function idFor(list) {
  let id;
  do { id = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (list.some(x => x.id === id));
  return id;
}
function persistNote(ok) {
  return ok ? "" : "\n⚠️ KV недоступен: изменения могут не сохраниться после перезапуска.";
}

function installHabitSuite(bot) {
  bot.command("habit", async ctx => {
    await load();
    const input = String(ctx.match || "").trim();
    const match = input.match(/^(add|done|undo|del|list|stats)(?:\s+([\s\S]+))?$/i);
    const action = match ? match[1].toLowerCase() : "help";
    const arg = (match && match[2] || "").trim();
    const data = user(ctx.from.id);
    const today = todayKey();

    if (action === "add") {
      if (!arg) return ctx.reply("Формат: /habit add Читать 10 страниц");
      if (arg.length > 100) return ctx.reply("Название привычки — максимум 100 символов.");
      if (data.habits.length >= 30) return ctx.reply("Можно добавить максимум 30 привычек.");
      if (data.habits.some(h => h.name.toLocaleLowerCase("ru") === arg.toLocaleLowerCase("ru"))) return ctx.reply("Такая привычка уже есть.");
      const habit = { id: idFor(data.habits), name: arg, days: [], createdAt: Date.now() };
      data.habits.push(habit);
      return ctx.reply("🌱 Привычка добавлена: " + habit.name + "\nID: " + habit.id + "\nОтмечай выполнение: /habit done " + habit.id + persistNote(await save()));
    }

    if (action === "list" || action === "stats") {
      if (!data.habits.length) return ctx.reply("Пока привычек нет. Добавь первую: /habit add Читать 10 страниц");
      const doneToday = data.habits.filter(h => (h.days || []).includes(today)).length;
      const rows = data.habits.map(h => {
        const days = h.days || [];
        const current = streak(days, today);
        const total = days.length;
        const mark = days.includes(today) ? "✅" : "⬜";
        return mark + " " + h.name + " · серия " + current + " дн. · всего " + total + " · ID " + h.id;
      });
      return ctx.reply("🌱 ТВОИ ПРИВЫЧКИ\nСегодня: " + doneToday + "/" + data.habits.length + "\n\n" + rows.join("\n") +
        "\n\nОтметить: /habit done ID\nОтменить отметку: /habit undo ID\nУдалить: /habit del ID");
    }

    if (action === "done" || action === "undo" || action === "del") {
      if (!arg) return ctx.reply("Укажи ID привычки. Посмотреть список: /habit list");
      const h = data.habits.find(x => x.id.toLowerCase() === arg.toLowerCase() || x.name.toLocaleLowerCase("ru") === arg.toLocaleLowerCase("ru"));
      if (!h) return ctx.reply("Не нашёл такую привычку. Используй /habit list.");
      if (action === "del") {
        data.habits = data.habits.filter(x => x.id !== h.id);
        return ctx.reply("🗑 Привычка удалена: " + h.name + persistNote(await save()));
      }
      const days = new Set(h.days || []);
      if (action === "done") days.add(today); else days.delete(today);
      h.days = [...days].sort();
      const current = streak(h.days, today);
      return ctx.reply(action === "done"
        ? "🔥 Отмечено: " + h.name + "\nТекущая серия: " + current + " дн." + persistNote(await save())
        : "↩️ Отметка за сегодня снята: " + h.name + persistNote(await save()));
    }

    return ctx.reply("🌱 ТРЕКЕР ПРИВЫЧЕК\n/habit add название — добавить привычку\n/habit list — прогресс за сегодня\n/habit done ID — отметить выполнение\n/habit undo ID — снять отметку за сегодня\n/habit stats — статистика\n/habit del ID — удалить привычку");
  });
}

module.exports = { installHabitSuite };
