// src/utils/telegram.js (FINAL v1.0)
import { cfg } from "../config.js";

export async function sendTelegram({ text }) {
  // DEFAULT: OFF
  if (!cfg.TELEGRAM_ENABLED) return { ok: true, skipped: "TELEGRAM_ENABLED=0" };

  const token = String(cfg.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(cfg.TELEGRAM_CHAT_ID || "").trim();
  const msg = String(text || "").trim();

  if (!token || !chatId || !msg) {
    return { ok: false, error: "missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / text" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    });
    const t = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, text: t.slice(0, 800) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}