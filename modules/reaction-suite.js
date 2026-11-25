const sentMessages = new Map();
const autoReactCooldown = new Map();
const MAX_TRACKED = 2500;

function reactionKey(chatId, messageId) {
  return String(chatId) + ":" + String(messageId);
}

function pickReaction(text) {
  const value = String(text || "").toLocaleLowerCase("ru");
  if (/(спасибо|благодар|люблю|обнял|обняла|❤️|💖|🥰)/u.test(value)) return "❤️";
  if (/(ахах|хах|лол|смешно|😂|🤣)/u.test(value)) return "😂";
  if (/(круто|класс|заебись|отлично|супер|огонь|🔥)/u.test(value)) return "🔥";
  if (/[?？]/u.test(value)) return "🤔";
  // Not every message gets a reaction: leave ordinary messages alone most of the time.
  if (Math.random() < 0.22) return Math.random() < 0.5 ? "👍" : "🤔";
  return null;
}

function reactionText(emoji) {
  const responses = {
    "❤️": "О, сердечко прилетело ❤️",
    "🥰": "Ну всё, взаимно 🥰",
    "😂": "АХАХ, реакция красноречивее слов 😂",
    "🤣": "Вот это оценка 🤣",
    "👍": "Принято 👍",
    "🔥": "Ого, огонь 🔥",
    "🤔": "Есть над чем подумать 🤔",
    "😢": "Эй, надеюсь, всё нормально ❤️",
    "👏": "Спасибо за аплодисменты 👏",
    "💯": "Сто из ста, записал 💯"
  };
  return responses[emoji] || "Вижу реакцию " + emoji + " 🙂";
}

function addedReactions(oldList, newList) {
  const oldKeys = new Set((oldList || []).map(item => item.type === "emoji"
    ? "emoji:" + item.emoji
    : item.type === "custom_emoji" ? "custom:" + item.custom_emoji_id : item.type));
  return (newList || []).filter(item => {
    const key = item.type === "emoji"
      ? "emoji:" + item.emoji
      : item.type === "custom_emoji" ? "custom:" + item.custom_emoji_id : item.type;
    return !oldKeys.has(key);
  });
}

function installReactionSuite(bot) {
  // Track messages sent by NEXUS so reactions to its own messages can get a contextual response.
  const originalSendMessage = bot.api.sendMessage.bind(bot.api);
  bot.api.sendMessage = async (...args) => {
    const result = await originalSendMessage(...args);
    const chatId = args[0];
    if (result?.message_id != null) {
      const key = reactionKey(chatId, result.message_id);
      sentMessages.set(key, { sentAt: Date.now(), respondedAt: 0 });
      if (sentMessages.size > MAX_TRACKED) {
        const oldest = sentMessages.keys().next().value;
        if (oldest) sentMessages.delete(oldest);
      }
    }
    return result;
  };

  // Always enabled. React selectively, with a per-user cooldown; there is no off switch.
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (message?.text && ctx.from && ctx.chat?.type === "private" &&
        !message.text.startsWith("/") && !message.text.startsWith("!")) {
      try {
        const userId = String(ctx.from.id);
        const last = Number(autoReactCooldown.get(userId) || 0);
        if (Date.now() - last > 30 * 1000) {
          const emoji = pickReaction(message.text);
          if (emoji) {
            await ctx.api.setMessageReaction(ctx.chat.id, message.message_id, [
              { type: "emoji", emoji }
            ]);
            autoReactCooldown.set(userId, Date.now());
          }
        }
      } catch (error) {
        console.warn("AUTO REACTION:", error.message);
      }
    }
    await next();
  });

  // Telegram only delivers message_reaction updates to bots that are admins in the chat.
  bot.on("message_reaction", async ctx => {
    const update = ctx.update.message_reaction;
    if (!update?.user) return;
    const key = reactionKey(update.chat.id, update.message_id);
    const tracked = sentMessages.get(key);
    if (!tracked) return; // Only answer reactions to NEXUS messages.
    const added = addedReactions(update.old_reaction, update.new_reaction);
    const emoji = added.find(item => item.type === "emoji")?.emoji;
    if (!emoji) return;
    const now = Date.now();
    if (tracked.respondedAt && now - tracked.respondedAt < 60 * 1000) return;
    tracked.respondedAt = now;
    sentMessages.set(key, tracked);
    await ctx.api.sendMessage(update.chat.id, reactionText(emoji), {
      reply_parameters: { message_id: update.message_id, allow_sending_without_reply: true }
    }).catch(error => console.warn("REACTION RESPONSE:", error.message));
  });
}

module.exports = { installReactionSuite };
