"use strict";

const QRCode = require("qrcode");
const { InputFile } = require("grammy");

function installQrSuite(bot) {
  bot.command("qr", async ctx => {
    const quoted = ctx.message && ctx.message.reply_to_message;
    const value = String(ctx.match || "").trim() ||
      String(quoted && (quoted.text || quoted.caption) || "").trim();
    if (!value) return ctx.reply("Формат: /qr текст или ссылка. Можно ответить /qr на сообщение.");
    if (value.length > 2000) return ctx.reply("Максимум 2000 символов для QR-кода.");
    try {
      const png = await QRCode.toBuffer(value, {
        type: "png", width: 900, margin: 2, errorCorrectionLevel: "M"
      });
      return ctx.replyWithPhoto(new InputFile(png, "nexus-qr.png"), {
        caption: "▦ QR-код готов. Содержимое обработано локально, без стороннего API."
      });
    } catch (error) {
      return ctx.reply("❌ Не удалось создать QR-код: " + String(error.message).slice(0, 300));
    }
  });
}

module.exports = { installQrSuite };
