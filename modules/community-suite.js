"use strict";

const crypto = require("node:crypto");

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:community-suite:v1";

const state = { antiSpam: {}, automations: {}, github: [] };
let loaded = false;
let saveChain = Promise.resolve();
let githubTimer = null;

const activity = new Map();
const warned = new Map();
const violations = new Map();

function kvReady() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function load() {
  if (loaded) return;
  loaded = true;
  if (!kvReady()) return;
  try {
    const r = await fetch(kvUrl(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return;
    if (!r.ok) throw new Error("KV HTTP " + r.status);
    const v = await r.json();
    if (v && typeof v === "object") {
      state.antiSpam = v.antiSpam && typeof v.antiSpam === "object" ? v.antiSpam : {};
      state.automations = v.automations && typeof v.automations === "object" ? v.automations : {};
      state.github = Array.isArray(v.github) ? v.github.slice(0, 500) : [];
    }
  } catch (e) { console.error("NEXUS community load:", e.message); }
}
async function save() {
  await load();
  if (!kvReady()) return false;
  const snapshot = JSON.stringify(state);
  saveChain = saveChain.then(async () => {
    const r = await fetch(kvUrl(), {
      method: "PUT",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: snapshot, signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error("KV HTTP " + r.status);
  });
  try { await saveChain; return true; }
  catch (e) { console.error("NEXUS community save:", e.message); return false; }
}
function isGroup(ctx) { return ["group", "supergroup"].includes(ctx.chat?.type); }
async function isAdmin(ctx) {
  if (!isGroup(ctx)) return false;
  try {
    const m = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return m.status === "creator" || m.status === "administrator";
  } catch { return false; }
}
function cleanText(s) { return String(s || "").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function antiSpamReasons(message, recent) {
  const text = String(message.text || message.caption || "");
  const normalized = cleanText(text);
  const reasons = [];
  if (recent.length >= 7) reasons.push("слишком много сообщений за короткое время");
  if (normalized.length >= 8 && recent.filter(x => x.text === normalized).length >= 2) reasons.push("повторяющиеся сообщения");
  const letters = text.match(/\p{L}/gu) || [];
  const upper = text.match(/\p{Lu}/gu) || [];
  if (letters.length >= 30 && upper.length / letters.length >= 0.78) reasons.push("чрезмерное использование CAPS");
  const mentions = (text.match(/@[a-z0-9_]{4,}/giu) || []).length +
    (message.entities || []).filter(e => e.type === "mention" || e.type === "text_mention").length;
  if (mentions >= 6) reasons.push("массовые упоминания пользователей");
  const links = (text.match(/https?:\/\//giu) || []).length;
  if (links >= 5) reasons.push("массовая рассылка ссылок");
  return reasons;
}

function installCommunitySuite(bot) {
  bot.use(async (ctx, next) => {
    try {
      await load();
      const msg = ctx.message;
      if (isGroup(ctx) && msg && ctx.from && !ctx.from.is_bot) {
        const chatId = String(ctx.chat.id);
        const userId = String(ctx.from.id);
        const text = String(msg.text || msg.caption || "");
        const command = /^\//.test(text);
        if (state.antiSpam[chatId] && !command) {
          let key = chatId + ":" + userId;
          const now = Date.now();
          const rows = (activity.get(key) || []).filter(x => now - x.at < 10000);
          rows.push({ at: now, text: cleanText(text) });
          activity.set(key, rows);
          if (activity.size > 3000) {
            for (const [k, v] of activity) if (!v.length || now - v[v.length - 1].at > 60000) activity.delete(k);
          }
          let admin = false;
          try {
            const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
            admin = member.status === "creator" || member.status === "administrator";
          } catch {}
          const reasons = admin ? [] : antiSpamReasons(msg, rows);
          if (reasons.length) {
            const oldStrike = violations.get(key) || { count: 0, at: now };
            const count = now - oldStrike.at > 600000 ? 1 : oldStrike.count + 1;
            violations.set(key, { count, at: now });
            const reasonText = reasons.map(escapeHtml).join("; ");

            if (count === 1) {
              await ctx.reply(
                "🚨 <b>Предупреждение за спам</b>\\nNEXUS обнаружил: " + reasonText +
                ". Следующее нарушение — удаление сообщения, затем мут.",
                { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } }
              ).catch(() => {});
            } else {
              const deleted = await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
                .then(() => true).catch(() => false);
              if (count === 2) {
                await ctx.reply("🗑 Повторное нарушение: сообщение удалено. Следующий спам приведёт к муту.")
                  .catch(() => {});
              } else {
                const seconds = count === 3 ? 60 : 300;
                const untilDate = Math.floor(Date.now() / 1000) + seconds;
                const muted = await ctx.api.restrictChatMember(ctx.chat.id, ctx.from.id, {
                  permissions: { can_send_messages: false },
                  until_date: untilDate
                }).then(() => true).catch(e => {
                  console.warn("NEXUS anti-spam mute failed:", e.message);
                  return false;
                });
                const duration = seconds === 60 ? "1 минуту" : "5 минут";
                await ctx.reply(muted
                  ? "🔇 Пользователь получил мут на " + duration + " за повторный спам."
                  : "⚠️ Сообщение удалено. Не удалось выдать мут: назначь NEXUS администратором с правом блокировки участников.")
                  .catch(() => {});
              }
            }
          }
        }

        if (!command) {
          const rules = state.automations[chatId] || [];
          const normalized = cleanText(text);
          const match = rules.find(rule => normalized.includes(cleanText(rule.trigger)));
          if (match) {
            await ctx.reply(match.response.slice(0, 1000), {
              reply_parameters: { message_id: msg.message_id }
            }).catch(() => {});
          }
        }
      }
    } catch (e) { console.error("NEXUS community middleware:", e.message); }
    await next();
  });

  bot.command("antispam", async ctx => {
    if (!isGroup(ctx)) return ctx.reply("Команда работает в группах.");
    if (!await isAdmin(ctx)) return ctx.reply("Настраивать антиспам могут только администраторы группы.");
    await load();
    const id = String(ctx.chat.id);
    const action = String(ctx.match || "status").trim().toLowerCase();
    if (["on", "вкл"].includes(action)) {
      state.antiSpam[id] = true;
      const saved = await save();
      return ctx.reply("🛡 Антиспам 2.0 включён: флуд, повторы, CAPS, массовые упоминания и рассылка ссылок." +
        (saved ? "" : "\n⚠️ KV недоступен — настройка может сброситься после перезапуска."));
    }
    if (["off", "выкл"].includes(action)) {
      delete state.antiSpam[id];
      const saved = await save();
      return ctx.reply("Антиспам 2.0 выключен." + (saved ? "" : "\n⚠️ KV недоступен — настройка может сброситься после перезапуска."));
    }
    return ctx.reply("🛡 Антиспам 2.0: " + (state.antiSpam[id] ? "включён" : "выключен") +
      "\n/antispam on — включить\n/antispam off — выключить");
  });

  bot.command("autoflow", async ctx => {
    if (!isGroup(ctx)) return ctx.reply("Автоматические сценарии работают в группах.");
    if (!await isAdmin(ctx)) return ctx.reply("Управлять сценариями могут только администраторы группы.");
    await load();
    const input = String(ctx.match || "").trim();
    const [action, ...rest] = input.split(/\s+/);
    const id = String(ctx.chat.id);
    const flows = state.automations[id] || (state.automations[id] = []);
    if (action === "add") {
      const parts = rest.join(" ").split("|").map(x => x.trim());
      if (!parts[0] || parts[0].length < 2 || parts[0].length > 80 || !parts[1]) {
        return ctx.reply("Формат: /autoflow add привет | Привет! Чем помочь?");
      }
      if (flows.length >= 10) return ctx.reply("Лимит — 10 сценариев на группу.");
      const flowId = crypto.randomBytes(3).toString("hex");
      flows.push({ id: flowId, trigger: parts[0], response: parts.slice(1).join(" | ").slice(0, 1000) });
      const saved = await save();
      return ctx.reply("✅ Сценарий добавлен. ID: " + flowId +
        (saved ? "" : "\n⚠️ KV недоступен — сценарий может пропасть после перезапуска."));
    }
    if (action === "list") {
      return ctx.reply(flows.length
        ? "⚙️ <b>АВТОСЦЕНАРИИ</b>\n" + flows.map(x => "• <code>" + x.id + "</code> — «" + escapeHtml(x.trigger) + "» → " + escapeHtml(x.response)).join("\n")
        : "Сценариев пока нет.", { parse_mode: "HTML" });
    }
    if (action === "remove") {
      const flowId = rest[0];
      const before = flows.length;
      state.automations[id] = flows.filter(x => x.id !== flowId);
      if (state.automations[id].length === before) return ctx.reply("Сценарий не найден.");
      const saved = await save();
      return ctx.reply(saved ? "🗑 Сценарий удалён." : "🗑 Удалён из памяти процесса, но KV недоступен.");
    }
    return ctx.reply("/autoflow add фраза | ответ\n/autoflow list\n/autoflow remove ID");
  });

  async function fetchLatestRelease(repo) {
    const response = await fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "NEXUS-AI-Telegram-Bot" },
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 404) return null;
    if (response.status === 403) throw new Error("GitHub API ограничил запросы. Попробуй позже.");
    if (!response.ok) throw new Error("GitHub HTTP " + response.status);
    const data = await response.json();
    return { tag: String(data.tag_name || ""), name: String(data.name || data.tag_name || "Новый релиз"), url: String(data.html_url || "") };
  }

  bot.command("ghwatch", async ctx => {
    const repo = String(ctx.match || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
      return ctx.reply("Формат: /ghwatch owner/repository\nНапример: /ghwatch nodejs/node");
    }
    await load();
    const owned = state.github.filter(x => String(x.userId) === String(ctx.from.id));
    if (owned.length >= 5) return ctx.reply("Можно отслеживать максимум 5 репозиториев. Удали один через /ghunwatch owner/repository.");
    if (owned.some(x => x.repo.toLowerCase() === repo.toLowerCase())) return ctx.reply("Этот репозиторий уже отслеживается.");
    const status = await ctx.reply("🐙 Проверяю GitHub-репозиторий...");
    try {
      const release = await fetchLatestRelease(repo);
      const item = {
        repo, userId: String(ctx.from.id), chatId: String(ctx.chat.id),
        lastTag: release?.tag || "", lastUrl: release?.url || "", initialized: true, createdAt: Date.now()
      };
      state.github.push(item);
      const saved = await save();
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "🐙 Репозиторий добавлен: " + repo +
        (release ? "\nПоследний релиз: " + release.tag + "\n" + release.url : "\nПока нет опубликованных релизов.") +
        "\nПроверка примерно раз в 10 минут." +
        (saved ? "" : "\n⚠️ KV недоступен — подписка может сброситься после перезапуска.")
      ).catch(() => {});
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ " + e.message).catch(() => {});
    }
  });

  bot.command("ghwatches", async ctx => {
    await load();
    const items = state.github.filter(x => String(x.userId) === String(ctx.from.id));
    return ctx.reply(items.length
      ? "🐙 <b>МОИ GITHUB-ПОДПИСКИ</b>\n" + items.map(x => "• " + escapeHtml(x.repo) + " — " + escapeHtml(x.lastTag || "релизов пока нет")).join("\n") +
        "\n\nУдалить: /ghunwatch owner/repository"
      : "Подписок нет. Добавить: /ghwatch owner/repository", { parse_mode: "HTML" });
  });

  bot.command("ghunwatch", async ctx => {
    await load();
    const repo = String(ctx.match || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
    if (!repo) return ctx.reply("Формат: /ghunwatch owner/repository");
    const before = state.github.length;
    state.github = state.github.filter(x => !(String(x.userId) === String(ctx.from.id) && x.repo.toLowerCase() === repo.toLowerCase()));
    if (before === state.github.length) return ctx.reply("Подписка не найдена.");
    const saved = await save();
    return ctx.reply(saved ? "🗑 Подписка удалена." : "🗑 Удалена из памяти процесса; KV недоступен.");
  });

  async function pollGithub() {
    await load();
    for (const item of [...state.github]) {
      try {
        const release = await fetchLatestRelease(item.repo);
        if (!release) continue;
        if (!item.initialized) {
          item.lastTag = release.tag;
          item.lastUrl = release.url;
          item.initialized = true;
          continue;
        }
        if (release.tag && release.tag !== item.lastTag) {
          item.lastTag = release.tag;
          item.lastUrl = release.url;
          await bot.api.sendMessage(Number(item.chatId),
            "🚀 <b>Новый релиз GitHub</b>\n" + escapeHtml(item.repo) +
            "\nВерсия: <b>" + escapeHtml(release.tag) + "</b>\n" + escapeHtml(release.name) +
            "\n" + escapeHtml(release.url),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
          ).catch(e => console.warn("NEXUS GitHub notify:", e.message));
        }
      } catch (e) { console.warn("NEXUS GitHub monitor:", item.repo, e.message); }
    }
    await save();
  }

  if (!githubTimer) {
    githubTimer = setInterval(() => pollGithub().catch(e => console.error("NEXUS GitHub poll:", e.message)), 10 * 60 * 1000);
    githubTimer.unref?.();
    setTimeout(() => pollGithub().catch(e => console.error("NEXUS GitHub initial poll:", e.message)), 30000).unref?.();
  }
}

module.exports = { installCommunitySuite };
