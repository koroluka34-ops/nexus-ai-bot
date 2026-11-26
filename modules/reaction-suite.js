const sentMessages = new Map();
const autoReactSkip = new Map();
const MAX_TRACKED = 2500;

function reactionKey(chatId, messageId) {
  return String(chatId) + ":" + String(messageId);
}

function pickReaction(text) {
  const value = String(text || "").toLocaleLowerCase("ru");
  if (/(спасибо|благодар|люблю|обнял|обняла|❤️|💖|🥰)/u.test(value)) return Math.random() < 0.5 ? "❤️" : "🥰";
  if (/(ахах|хах|лол|смешно|😂|🤣)/u.test(value)) return Math.random() < 0.5 ? "😂" : "🤣";
  if (/(круто|класс|заебись|отлично|супер|огонь|🔥)/u.test(value)) {
    const praise = ["🔥", "👏", "💯", "🤩"];
    return praise[Math.floor(Math.random() * praise.length)];
  }
  if (/[?？]/u.test(value)) return Math.random() < 0.5 ? "🤔" : "👀";
  // Ordinary messages can also get a reaction, but not all of them.
  if (Math.random() < 0.5) {
    const casual = ["👍", "🤔", "👀", "😁", "👏", "🔥", "🎉", "🤩"];
    return casual[Math.floor(Math.random() * casual.length)];
  }
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
        const explicitRequest = /(?:поставь|поставить|кинь|добавь)\s+(?:мне\s+)?реакц(?:ию|июшку)|реакц(?:ию|июшку)\s+на\s+(?:моё|мое)\s+сообщение/iu.test(message.text);
        if (explicitRequest) {
          const target = message.reply_to_message || message;
          const cleanText = message.text
            .replace(/(?:поставь|поставить|кинь|добавь)\s+(?:мне\s+)?реакц(?:ию|июшку)/iu, "")
            .replace(/реакц(?:ию|июшку)\s+на\s+(?:моё|мое)\s+сообщение/iu, "")
            .trim();
          const desiredEmoji = pickReaction(cleanText) || "😂";
          const chatInfo = await ctx.api.getChat(ctx.chat.id);
          const allowed = Array.isArray(chatInfo.available_reactions)
            ? chatInfo.available_reactions
                .filter(item => item.type === "emoji")
                .map(item => item.emoji)
            : null;
          const candidates = allowed
            ? [...new Set([desiredEmoji, ...allowed])]
            : [...new Set([desiredEmoji, "👍", "❤️", "🔥", "🤔", "😂"])];
          if (!candidates.length) {
            await ctx.reply("В этом чате Telegram не сообщил доступных реакций.");
            return;
          }
          let appliedEmoji = null;
          let lastReactionError = null;
          for (const emoji of candidates) {
            try {
              await ctx.api.setMessageReaction(ctx.chat.id, target.message_id, [
                { type: "emoji", emoji }
              ]);
              appliedEmoji = emoji;
              break;
            } catch (error) {
              lastReactionError = error;
              console.warn("EXPLICIT REACTION candidate " + emoji + ":", error.message);
              if (!String(error.message || "").includes("REACTION_INVALID")) break;
            }
          }
          if (appliedEmoji) {
            await ctx.reply("Поставил реакцию " + appliedEmoji);
          } else {
            console.warn("EXPLICIT REACTION failed; chat:", JSON.stringify({
              type: chatInfo.type,
              can_react_to_messages: chatInfo.can_react_to_messages,
              available_reactions: chatInfo.available_reactions
            }), "last:", lastReactionError?.message);
            await ctx.reply("Telegram отклонил все доступные варианты реакции для этого сообщения. Я записал подробности ошибки — нужно проверить ограничение самого чата.");
          }
          return;
        }

        const userId = String(ctx.from.id);
        const skipRemaining = Number(autoReactSkip.get(userId) || 0);
        if (skipRemaining > 0) {
          autoReactSkip.set(userId, skipRemaining - 1);
        } else {
          const desiredEmoji = pickReaction(message.text);
          if (desiredEmoji) {
            const chatInfo = await ctx.api.getChat(ctx.chat.id);
            const allowed = Array.isArray(chatInfo.available_reactions)
              ? chatInfo.available_reactions
                  .filter(item => item.type === "emoji")
                  .map(item => item.emoji)
              : null;
            const candidates = allowed
              ? [...new Set([desiredEmoji, ...allowed])]
              : [...new Set([desiredEmoji, "👍", "❤️", "🔥", "🤔", "😂"])];
            let applied = false;
            for (const emoji of candidates) {
              try {
                await ctx.api.setMessageReaction(ctx.chat.id, message.message_id, [
                  { type: "emoji", emoji }
                ]);
                // After reacting, skip either one or two of the next messages.
                autoReactSkip.set(userId, Math.random() < 0.5 ? 1 : 2);
                applied = true;
                break;
              } catch (error) {
                console.warn("AUTO REACTION candidate " + emoji + ":", error.message);
                if (!String(error.message || "").includes("REACTION_INVALID")) break;
              }
            }
            if (!applied) {
              console.warn("AUTO REACTION: no allowed emoji worked; chat:", JSON.stringify({
                type: chatInfo.type,
                can_react_to_messages: chatInfo.can_react_to_messages,
                available_reactions: chatInfo.available_reactions
              }));
            }
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
