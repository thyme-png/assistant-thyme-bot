import express from "express";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID; // only respond to your chat

const SYSTEM_PROMPT = `You are a personal AI assistant — helpful, concise, and smart.
Answer directly and concisely unless a detailed explanation is needed.
Be honest when you're unsure rather than guessing.`;

// In-memory conversation history per chat
const histories = new Map();

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function sendTyping(chatId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

async function askMiMo(chatId, userMessage) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  const history = histories.get(chatId);

  history.push({ role: "user", content: userMessage });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://telegram-assistant.railway.app",
      "X-Title": "Personal Assistant Telegram Bot",
    },
    body: JSON.stringify({
      model: "xiaomi/mimo-v2-pro",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenRouter error ${res.status}`);

  const reply = data.choices?.[0]?.message?.content ?? "Sorry, I couldn't generate a response.";
  history.push({ role: "assistant", content: reply });

  // Keep last 40 messages to avoid token bloat
  if (history.length > 40) history.splice(0, history.length - 40);

  return reply;
}

// Telegram webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text;

  // Only respond to the allowed user
  if (ALLOWED_CHAT_ID && chatId !== String(ALLOWED_CHAT_ID)) {
    await sendTelegram(chatId, "Sorry, I'm a private assistant.");
    return;
  }

  // Handle /start and /clear
  if (text === "/start") {
    await sendTelegram(chatId, "👋 Hi! I'm your personal assistant powered by MiMo V2 Pro. What can I help you with?");
    return;
  }
  if (text === "/clear") {
    histories.delete(chatId);
    await sendTelegram(chatId, "🧹 Conversation cleared.");
    return;
  }

  try {
    await sendTyping(chatId);
    const reply = await askMiMo(chatId, text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error("Error:", err);
    await sendTelegram(chatId, `⚠️ Error: ${err.message}`);
  }
});

// Health check
app.get("/", (_req, res) => res.json({ ok: true, status: "running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
