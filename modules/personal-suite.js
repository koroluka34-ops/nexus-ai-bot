"use strict";

const crypto = require("node:crypto");

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:personal-suite:v1";
const state = { users: {} };
let loadPromise = null;
let saveChain = Promise.resolve();

function ready() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function url(key = KEY) {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(key);
}
async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!ready()) return;
    try {
      const r = await fetch(url(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(9000) });
      if (r.status === 404) return;
      if (!r.ok) throw new Error("KV HTTP " + r.status);
      const data = await r.json();
      if (data && data.users && typeof data.users === "object") state.users = data.users;
    } catch (e) { console.error("NEXUS personal suite load:", e.message); }
  })();
  return loadPromise;
}
async function save() {
  await load();
  if (!ready()) return false;
  const body = JSON.stringify(state);
  const write = async () => {
    const r = await fetch(url(), {
      method: "PUT",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) throw new Error("KV HTTP " + r.status);
  };
  saveChain = saveChain.then(write, write);
  try { await saveChain; return true; }
  catch (e) { console.error("NEXUS personal suite save:", e.message); saveChain = Promise.resolve(); return false; }
}
function installKVCheck(bot) {
  bot.command("kvcheck", async ctx => {
    if (!ready()) return ctx.reply("❌ Cloudflare KV не настроен: проверь CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN и CLOUDFLARE_KV_NAMESPACE_ID в Render.");
    const probeUrl = url(KEY + ":probe:" + crypto.randomUUID());
    const headers = { Authorization: "Bearer " + TOKEN };
    try {
      const write = await fetch(probeUrl + "?expiration_ttl=120", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "text/plain" },
        body: "NEXUS-KV-PROBE",
        signal: AbortSignal.timeout(8000)
      });
      if (!write.ok) {
        const detail = write.status === 401
          ? "Токен Cloudflare отклонён (401). Замени CLOUDFLARE_API_TOKEN в Render."
          : write.status === 403
            ? "У токена нет прав на запись в Workers KV (403). Нужны права чтения и записи."
            : "Cloudflare KV вернул HTTP " + write.status + ".";
        return ctx.reply("❌ KV ПРОВЕРКА НЕ ПРОШЛА\n" + detail);
      }
      const read = await fetch(probeUrl, {
        headers: headers, signal: AbortSignal.timeout(8000)
      });
      const value = read.ok ? await read.text() : "";
      const deleted = await fetch(probeUrl, {
        method: "DELETE", headers: headers, signal: AbortSignal.timeout(8000)
      }).catch(() => null);
      if (!read.ok || value !== "NEXUS-KV-PROBE") {
        return ctx.reply("⚠️ KV записал тестовый ключ, но чтение не прошло. HTTP " + read.status + ". Тестовый ключ автоматически истечёт через 120 секунд.");
      }
      if (!deleted || !deleted.ok) {
        return ctx.reply("⚠️ KV читает и записывает, но тестовый ключ не удалось удалить. Он истечёт через 120 секунд.");
      }
      return ctx.reply("✅ Cloudflare KV полностью работает: запись, чтение и удаление проверены. Заметки и задачи смогут сохраняться между перезапусками.");
    } catch (error) {
      return ctx.reply("❌ Ошибка проверки Cloudflare KV: " + String(error.message).slice(0, 300));
    }
  });
}

function user(id) {
  const key = String(id);
  if (!state.users[key]) state.users[key] = { notes: [], tasks: [] };
  if (!Array.isArray(state.users[key].notes)) state.users[key].notes = [];
  if (!Array.isArray(state.users[key].tasks)) state.users[key].tasks = [];
  return state.users[key];
}
function makeId(list) {
  let id;
  do { id = crypto.randomBytes(3).toString("hex"); } while (list.some(x => x.id === id));
  return id;
}
function warning(ok) {
  return ok ? "" : "\n\n⚠️ Cloudflare KV не настроен/недоступен: данные сейчас временные и могут исчезнуть после перезапуска.";
}
function quotedMessage(ctx) {
  const m = ctx.message && ctx.message.reply_to_message;
  return String(m && (m.text || m.caption) || "").trim();
}

function installPersonalSuite(bot) {
  bot.command("note", async ctx => {
    await load();
    const input = String(ctx.match || "").trim();
    const pos = input.search(/\s/);
    const action = (pos < 0 ? input || "list" : input.slice(0, pos)).toLowerCase();
    const arg = pos < 0 ? "" : input.slice(pos).trim();
    const data = user(ctx.from.id);

    if (action === "add") {
      const text = (arg || quotedMessage(ctx)).trim();
      if (!text) return ctx.reply("Формат: /note add текст (можно ответом на сообщение).");
      if (text.length > 3000) return ctx.reply("Ограничение заметки — 3000 символов.");
      if (data.notes.length >= 50) return ctx.reply("Лимит — 50 заметок. Удали старые через /note del ID.");
      const id = makeId(data.notes);
      data.notes.push({ id, text, createdAt: Date.now() });
      return ctx.reply("📝 Заметка сохранена. ID: " + id + warning(await save()));
    }
    if (action === "list") {
      if (!data.notes.length) return ctx.reply("Заметок пока нет. Создай: /note add текст");
      const rows = [...data.notes].sort((a,b) => b.createdAt-a.createdAt).slice(0,20)
        .map(x => "• " + x.id + " — " + x.text.replace(/\s+/g," ").slice(0,90));
      return ctx.reply("📝 ТВОИ ЗАМЕТКИ (" + data.notes.length + "/50)\n\n" + rows.join("\n") +
        "\n\nОткрыть: /note get ID\nПоиск: /note find слово\nУдалить: /note del ID");
    }
    if (action === "get") {
      const n = data.notes.find(x => x.id === arg);
      if (!n) return ctx.reply("Заметка не найдена.");
      return ctx.reply("📝 ЗАМЕТКА " + n.id + "\nСоздана: " +
        new Date(n.createdAt).toLocaleString("ru-RU",{timeZone:"Europe/Kyiv"}) + "\n\n" + n.text);
    }
    if (action === "find") {
      if (!arg) return ctx.reply("Формат: /note find ключевое слово");
      const found = data.notes.filter(x => x.text.toLocaleLowerCase("ru").includes(arg.toLocaleLowerCase("ru")));
      if (!found.length) return ctx.reply("Совпадений не найдено.");
      return ctx.reply("🔎 Найдено: " + found.length + "\n" +
        found.slice(0,15).map(x => "• " + x.id + " — " + x.text.replace(/\s+/g," ").slice(0,100)).join("\n"));
    }
    if (action === "del") {
      const old = data.notes.length;
      data.notes = data.notes.filter(x => x.id !== arg);
      if (old === data.notes.length) return ctx.reply("Заметка с таким ID не найдена.");
      return ctx.reply("🗑 Заметка удалена." + warning(await save()));
    }
    return ctx.reply("📝 ЗАМЕТКИ\n/note add текст — создать\n/note list — список\n/note get ID — открыть\n/note find слово — поиск\n/note del ID — удалить");
  });

  bot.command("todo", async ctx => {
    await load();
    const input = String(ctx.match || "").trim();
    const pos = input.search(/\s/);
    const action = (pos < 0 ? input || "list" : input.slice(0,pos)).toLowerCase();
    const arg = pos < 0 ? "" : input.slice(pos).trim();
    const data = user(ctx.from.id);

    if (action === "add") {
      const title = (arg || quotedMessage(ctx)).trim();
      if (!title) return ctx.reply("Формат: /todo add Купить продукты");
      if (title.length > 250) return ctx.reply("Ограничение задачи — 250 символов.");
      if (data.tasks.length >= 100) return ctx.reply("Лимит — 100 задач.");
      const id = makeId(data.tasks);
      data.tasks.push({ id, title, done: false, createdAt: Date.now() });
      return ctx.reply("✅ Задача добавлена. ID: " + id + warning(await save()));
    }
    if (action === "list") {
      if (!data.tasks.length) return ctx.reply("Задач нет. Добавить: /todo add текст");
      const open = data.tasks.filter(x => !x.done);
      const done = data.tasks.filter(x => x.done);
      const lines = [
        ...open.slice(0,25).map(x => "⬜ " + x.id + " — " + x.title),
        ...done.slice(-10).reverse().map(x => "✅ " + x.id + " — " + x.title)
      ];
      return ctx.reply("📋 ЗАДАЧИ\nАктивных: " + open.length + " · Выполнено: " + done.length +
        "\n\n" + lines.join("\n") + "\n\nЗакрыть: /todo done ID\nВернуть: /todo undo ID\nУдалить: /todo del ID");
    }
    if (["done","undo"].includes(action)) {
      const task = data.tasks.find(x => x.id === arg);
      if (!task) return ctx.reply("Задача не найдена.");
      task.done = action === "done";
      task.completedAt = task.done ? Date.now() : null;
      return ctx.reply((task.done ? "✅ Выполнено: " : "↩️ Возвращено: ") + task.title + warning(await save()));
    }
    if (action === "del") {
      const old = data.tasks.length;
      data.tasks = data.tasks.filter(x => x.id !== arg);
      if (old === data.tasks.length) return ctx.reply("Задача с таким ID не найдена.");
      return ctx.reply("🗑 Задача удалена." + warning(await save()));
    }
    if (action === "clear") {
      data.tasks = [];
      return ctx.reply("🧹 Список задач очищен." + warning(await save()));
    }
    return ctx.reply("📋 ЗАДАЧИ\n/todo add текст — добавить\n/todo list — список\n/todo done ID — выполнить\n/todo undo ID — вернуть\n/todo del ID — удалить\n/todo clear — очистить список");
  });

  bot.command("poll", async ctx => {
    const parts = String(ctx.match || "").split("|").map(x => x.trim()).filter(Boolean);
    if (parts.length < 3 || parts.length > 11) {
      return ctx.reply("Формат: /poll Вопрос | вариант 1 | вариант 2\nНужно от 2 до 10 вариантов.");
    }
    const question = parts[0], options = parts.slice(1);
    if (question.length > 300 || options.some(x => x.length > 100)) {
      return ctx.reply("Вопрос — максимум 300 символов, вариант — максимум 100.");
    }
    try {
      await ctx.api.sendPoll(ctx.chat.id, question, options, {
        is_anonymous: true, allows_multiple_answers: false
      });
      return ctx.reply("📊 Опрос создан.");
    } catch (e) {
      return ctx.reply("❌ Не удалось создать опрос: " + String(e.message).slice(0,300));
    }
  });
}

module.exports = { installPersonalSuite, installKVCheck };
