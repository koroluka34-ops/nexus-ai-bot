// NEXUS PHONE bridge. Pairing is explicit and scoped to the Telegram owner.
const crypto = require("crypto");

const pendingPairs = new Map();
const devices = new Map();
const queues = new Map();
const results = new Map();

const now = () => Date.now();
const random = (n=24) => crypto.randomBytes(n).toString("hex");
const clean = (s) => String(s || "").slice(0, 80);

function issueCode(ownerId) {
  const code = String(crypto.randomInt(100000, 1000000));
  pendingPairs.set(code, { ownerId: String(ownerId), expiresAt: now() + 10 * 60 * 1000 });
  return code;
}

function queueCommand(ownerId, action, params = {}) {
  const owned = [...devices.values()].filter(d => d.ownerId === String(ownerId) && d.revokedAt == null);
  if (!owned.length) return false;
  const command = { id: random(12), action, params, createdAt: now(), expiresAt: now() + 2 * 60 * 1000 };
  for (const device of owned) {
    const q = queues.get(device.id) || [];
    q.push(command);
    queues.set(device.id, q.slice(-20));
  }
  return true;
}

function parseDuration(text) {
  const s = String(text).toLowerCase();
  const m = s.match(/(?:на\\s*)?(\\d+)\\s*(секунд(?:у|ы)?|сек|с|минут(?:у|ы)?|мин|м|час(?:а|ов)?|ч)\\b/u);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const multiplier = /^(?:с|сек)/u.test(unit) ? 1000 : /^(?:м|мин)/u.test(unit) ? 60000 : 3600000;
  return Math.max(1000, Math.min(24 * 3600000, n * multiplier));
}

function createPhoneBridge(bot) {
  async function handleText(ctx, text) {
    const value = String(text || "").trim();
    const lower = value.toLowerCase();

    if (/^(?:подключи|подключить|сопряги|сопряжение).*(?:телефон|мобильник)|^(?:телефон|nexus phone)$/iu.test(lower)) {
      const code = issueCode(ctx.from.id);
      await ctx.reply(
        "📱 Подключение NEXUS PHONE\n\n" +
        "Код подключения: " + code + "\n" +
        "Он действует 10 минут и привязывает только устройство, на котором ты введёшь его в приложении NEXUS PHONE.\n\n" +
        "Сначала установи приложение-компаньон и подтверди сопряжение на самом телефоне. Telegram не может выдать Android-разрешения вместо владельца."
      );
      return true;
    }

    if (/^(?:отключи|отвязать|отключить) телефон$/iu.test(lower)) {
      let count = 0;
      for (const d of devices.values()) if (d.ownerId === String(ctx.from.id) && !d.revokedAt) { d.revokedAt = now(); count++; }
      await ctx.reply(count ? "🔒 Телефон отключён от NEXUS." : "Подключённых телефонов нет.");
      return true;
    }

    if (/^(?:статус телефона|телефон подключён|мои устройства)$/iu.test(lower)) {
      const owned = [...devices.values()].filter(d => d.ownerId === String(ctx.from.id) && !d.revokedAt);
      await ctx.reply(owned.length ? "📱 Подключено устройств: " + owned.length + "\n" + owned.map(d => "• " + d.name).join("\n") : "📱 Телефон пока не подключён. Напиши «подключи телефон».");
      return true;
    }

    const owned = [...devices.values()].some(d => d.ownerId === String(ctx.from.id) && !d.revokedAt);
    if (!owned) return false;

    let action = null;
    let params = {};
    const duration = parseDuration(lower);
    if (duration && /таймер/u.test(lower)) {
      action = "set_timer"; params = { durationMs: duration, label: "NEXUS" };
    } else if (/будильник/u.test(lower)) {
      const match = lower.match(/(?:на\\s*)?(\\d{1,2})[:.](\\d{2})/u);
      if (!match) { await ctx.reply("Напиши время, например: «будильник на 07:30»."); return true; }
      action = "set_alarm"; params = { hour: Number(match[1]), minute: Number(match[2]), message: "Будильник от NEXUS" };
    } else if (/открой|запусти/u.test(lower) && /youtube|ютуб/u.test(lower)) {
      action = "open_app"; params = { packageName: "com.google.android.youtube" };
    } else if (/открой|запусти/u.test(lower) && /telegram|телеграм/u.test(lower)) {
      action = "open_app"; params = { packageName: "org.telegram.messenger" };
    } else if (/включи фонарик|фонарик включи/u.test(lower)) {
      action = "torch"; params = { enabled: true };
    } else if (/выключи фонарик/u.test(lower)) {
      action = "torch"; params = { enabled: false };
    } else if (/открой настройки/u.test(lower)) {
      action = "open_settings";
    } else {
      return false;
    }

    if (!queueCommand(ctx.from.id, action, params)) {
      await ctx.reply("Телефон сейчас не на связи. Открой NEXUS PHONE и проверь подключение.");
    } else {
      await ctx.reply("📲 Команду отправил на подключённый телефон. Выполнение зависит от разрешений Android и доступности устройства.");
    }
    return true;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const readBody = () => new Promise((resolve, reject) => {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 16384) reject(new Error("too_large")); });
      req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad_json")); } });
      req.on("error", reject);
    });

    if (req.method === "POST" && url.pathname === "/phone/pair") {
      try {
        const body = await readBody();
        const code = String(body.code || "");
        const pending = pendingPairs.get(code);
        if (!pending || pending.expiresAt < now()) { pendingPairs.delete(code); return send(401, { error: "invalid_or_expired_code" }); }
        pendingPairs.delete(code);
        const id = random(12);
        const token = random(32);
        devices.set(id, { id, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), ownerId: pending.ownerId, name: clean(body.deviceName) || "Android", createdAt: now(), revokedAt: null });
        queues.set(id, []);
        return send(200, { deviceId: id, deviceToken: token, pollAfterMs: 2500 });
      } catch { return send(400, { error: "invalid_request" }); }
    }

    const id = url.searchParams.get("deviceId");
    const device = devices.get(id);
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
    const tokenHash = crypto.createHash("sha256").update(bearer).digest("hex");
    if (!device || device.revokedAt || !bearer || !crypto.timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(tokenHash))) {
      return send(401, { error: "unauthorized" });
    }

    if (req.method === "GET" && url.pathname === "/phone/commands") {
      const q = (queues.get(id) || []).filter(c => c.expiresAt > now());
      queues.set(id, []);
      return send(200, { commands: q });
    }
    if (req.method === "POST" && url.pathname === "/phone/result") {
      try {
        const body = await readBody();
        results.set(String(body.commandId || ""), { deviceId: id, ok: Boolean(body.ok), message: clean(body.message), at: now() });
        return send(200, { ok: true });
      } catch { return send(400, { error: "invalid_request" }); }
    }
    return send(404, { error: "not_found" });
  }

  return { handleText, handleHttp };
}

module.exports = { createPhoneBridge };
