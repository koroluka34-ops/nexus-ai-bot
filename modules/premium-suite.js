"use strict";

// Persistent Telegram username -> numeric user ID index. Usernames are learned
// only from Telegram updates the bot has actually received.
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:premium-usernames:v1";
const usernames = new Map();
let loaded = false;
let loadPromise = null;
let saveChain = Promise.resolve();

function ready() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function endpoint() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function load() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (ready()) {
      try {
        const response = await fetch(endpoint(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(9000) });
        if (response.ok) {
          const data = await response.json();
          if (data && typeof data === "object") for (const [name,id] of Object.entries(data)) usernames.set(name, String(id));
        } else if (response.status !== 404) throw new Error("KV HTTP " + response.status);
      } catch (error) { console.error("NEXUS username index load:", error.message); }
    }
    loaded = true;
  })();
  return loadPromise;
}
async function save() {
  if (!ready()) return false;
  const body = JSON.stringify(Object.fromEntries(usernames));
  const write = async () => {
    const response = await fetch(endpoint(), { method: "PUT",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error("KV HTTP " + response.status);
  };
  saveChain = saveChain.then(write, write);
  try { await saveChain; return true; }
  catch (error) { console.error("NEXUS username index save:", error.message); saveChain = Promise.resolve(); return false; }
}
async function installPremium(bot) {
  bot.use(async (ctx, next) => {
    await load();
    const username = String(ctx.from?.username || "").replace(/^@/, "").toLowerCase();
    const userId = String(ctx.from?.id || "");
    if (username && userId && /^[a-z0-9_]{5,32}$/.test(username) && usernames.get(username) !== userId) {
      for (const [oldName, mappedId] of usernames.entries()) {
        if (mappedId === userId && oldName !== username) usernames.delete(oldName);
      }
      usernames.set(username, userId);
      save().catch(() => {});
    }
    await next();
  });
}
async function resolveUsername(value) {
  await load();
  const username = String(value || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{5,32}$/.test(username)) return null;
  return usernames.get(username) || null;
}
module.exports = { installPremium, resolveUsername };
