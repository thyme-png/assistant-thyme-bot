import express from "express";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;
const MASUMI_BACKUP_B64 = process.env.MASUMI_BACKUP_B64;
const MASUMI_BACKUP_PASSPHRASE = process.env.MASUMI_BACKUP_PASSPHRASE || "assistant-thyme";
const AGENT_SLUG = process.env.AGENT_SLUG || "thyme-thymestudio-co";
const BF_SLUG = "patrick-nmkr-io";

const MASUMI_CLI = "masumi-agent-messenger";
const MASUMI_BACKUP_FILE = "/tmp/masumi-backup.json";

const SYSTEM_PROMPT = `You are a personal AI assistant — helpful, concise, and smart.
Answer directly and concisely unless a detailed explanation is needed.
Be honest when you're unsure rather than guessing.`;

const histories = new Map();
const pendingConfirm = new Map(); // chatId → { type, ...data }

// Restore masumi session from env var on startup
async function restoreMasumiSession() {
  if (!MASUMI_BACKUP_B64) {
    console.log("No MASUMI_BACKUP_B64 env var — agent messaging disabled.");
    return false;
  }
  try {
    const json = Buffer.from(MASUMI_BACKUP_B64, "base64").toString("utf8");
    writeFileSync(MASUMI_BACKUP_FILE, json);
    execFileSync(MASUMI_CLI, [
      "account", "backup", "import",
      "--file", MASUMI_BACKUP_FILE,
      "--passphrase", MASUMI_BACKUP_PASSPHRASE,
      "--json",
    ]);
    console.log("Masumi session restored.");
    return true;
  } catch (err) {
    console.error("Failed to restore masumi session:", err.message);
    return false;
  }
}

async function cli(...args) {
  try {
    const { stdout } = await execFileAsync(MASUMI_CLI, [...args, "--json"]);
    return JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try { return JSON.parse(err.stdout); } catch {}
    }
    throw err;
  }
}

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
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenRouter error ${res.status}`);

  const reply = data.choices?.[0]?.message?.content ?? "Sorry, I couldn't generate a response.";
  history.push({ role: "assistant", content: reply });
  if (history.length > 40) history.splice(0, history.length - 40);
  return reply;
}

async function reformatForBf(raw) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "xiaomi/mimo-v2-pro",
        messages: [
          {
            role: "system",
            content: "You are helping someone message their boyfriend Patrick. Rewrite the message to sound natural, warm, and like the sender. Keep the tone casual. Output ONLY the rewritten message — no quotes, no explanation.",
          },
          { role: "user", content: raw },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || raw;
  } catch {
    return raw;
  }
}

async function sendPendingBfMessage(chatId) {
  const pending = pendingConfirm.get(chatId);
  if (!pending || pending.type !== "bf_confirm") return;
  pendingConfirm.delete(chatId);
  await sendTyping(chatId);
  try {
    const threadResult = await cli("thread", "start",
      "--agent", AGENT_SLUG,
      "--recipient", BF_SLUG,
      "--message", pending.formatted
    );
    const threadId = threadResult.data?.threadId;
    await sendTelegram(chatId, `✅ Sent to Patrick${threadId ? ` (thread #${threadId})` : ""}! 💌`);
  } catch (err) {
    await sendTelegram(chatId, `⚠️ Failed to send: ${err.message}`);
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // Handle emoji reactions — ✅ means "send"
  const reaction = req.body?.message_reaction;
  if (reaction) {
    const chatId = String(reaction.chat?.id);
    const isCheckmark = reaction.new_reaction?.some(r => r.type === "emoji" && r.emoji === "✅");
    if (isCheckmark && pendingConfirm.has(chatId)) {
      await sendPendingBfMessage(chatId);
    }
    return;
  }

  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  if (ALLOWED_CHAT_ID && chatId !== String(ALLOWED_CHAT_ID)) {
    await sendTelegram(chatId, "Sorry, I'm a private assistant.");
    return;
  }

  // /start
  if (text === "/start") {
    await sendTelegram(chatId,
      "👋 Hi! I'm your personal assistant powered by MiMo V2 Pro.\n\n" +
      "*Commands:*\n" +
      "/bf `<message>` — message Patrick 💌\n" +
      "/inbox — check new messages\n" +
      "/reply `<thread-id> <message>` — reply to a message\n" +
      "/msg `<agent-slug> <message>` — message any agent\n" +
      "/contacts — browse agents\n" +
      "/clear — reset conversation\n\n" +
      "Or just chat with me!"
    );
    return;
  }

  // /clear
  if (text === "/clear") {
    histories.delete(chatId);
    await sendTelegram(chatId, "🧹 Conversation cleared.");
    return;
  }

  // /inbox
  if (text === "/inbox") {
    await sendTyping(chatId);
    try {
      const result = await cli("thread", "unread", "--agent", AGENT_SLUG);
      const messages = result.data?.messages ?? [];
      if (messages.length === 0) {
        await sendTelegram(chatId, "📭 No new messages.");
      } else {
        await sendTelegram(chatId, `📬 *${messages.length} new message${messages.length > 1 ? "s" : ""}:*`);
        for (const m of messages) {
          const sender = m.sender?.displayName || m.sender?.slug || "Unknown";
          const threadId = m.threadId ?? m.thread_id;
          await sendTelegram(chatId,
            `*From:* ${sender}\n` +
            `*Thread ID:* \`${threadId}\`\n\n` +
            `${m.text}\n\n` +
            `↩️ Reply: /reply ${threadId} <your message>`
          );
          await cli("thread", "read", String(threadId), "--agent", AGENT_SLUG).catch(() => {});
        }
      }
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Could not check inbox: ${err.message}`);
    }
    return;
  }

  // /contacts
  if (text === "/contacts" || text.startsWith("/contacts ")) {
    await sendTyping(chatId);
    const query = text.slice("/contacts".length).trim() || "";
    try {
      const args = query
        ? ["discover", "--query", query]
        : ["agents", "list"];
      const result = await cli(...args);
      const agents = result.data?.agents ?? [];
      if (agents.length === 0) {
        await sendTelegram(chatId, "No agents found. Try `/contacts <name>` to search.");
        return;
      }
      const lines = agents.slice(0, 20).map(a => {
        const slug = a.slug || a.id;
        const name = a.displayName || a.name || slug;
        return `• *${name}* — \`${slug}\``;
      });
      if (agents.length > 20) lines.push(`_…and ${agents.length - 20} more. Try /contacts <name> to search._`);
      await sendTelegram(chatId,
        `*Agents you can message:*\n\n${lines.join("\n")}\n\n` +
        `Send a message: /msg <slug> <text>`
      );
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Could not load contacts: ${err.message}`);
    }
    return;
  }

  // /bf <message> — shortcut to message patrick-nmkr-io
  if (text.startsWith("/bf ")) {
    const raw = text.slice(4).trim();
    if (!raw) {
      await sendTelegram(chatId, "Usage: `/bf <your message>`");
      return;
    }
    await sendTyping(chatId);
    const formatted = await reformatForBf(raw);
    pendingConfirm.set(chatId, { type: "bf_confirm", formatted });
    await sendTelegram(chatId,
      `💌 Here's your message to Patrick:\n\n_"${formatted}"_\n\n` +
      `Reply *send*, *edit*, or *cancel*.`
    );
    return;
  }

  // /bf confirmation flow
  if (pendingConfirm.has(chatId)) {
    const pending = pendingConfirm.get(chatId);
    const answer = text.toLowerCase().trim();

    if (pending.type === "bf_confirm") {
      if (answer === "send" || answer === "yes") {
        await sendPendingBfMessage(chatId);
      } else if (answer === "edit") {
        pendingConfirm.set(chatId, { type: "bf_editing" });
        await sendTelegram(chatId, "✏️ Type your edited message:");
      } else if (answer === "cancel" || answer === "no") {
        pendingConfirm.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else {
        await sendTelegram(chatId, "Reply *send*, *edit*, or *cancel*.");
      }
      return;
    }

    if (pending.type === "bf_editing") {
      await sendTyping(chatId);
      const formatted = await reformatForBf(text);
      pendingConfirm.set(chatId, { type: "bf_confirm", formatted });
      await sendTelegram(chatId,
        `💌 Here's your updated message:\n\n_"${formatted}"_\n\n` +
        `Reply *send*, *edit*, or *cancel*.`
      );
      return;
    }
  }

  // /msg <slug> <message>
  if (text.startsWith("/msg ")) {
    const parts = text.slice(5).trim().split(" ");
    if (parts.length < 2) {
      await sendTelegram(chatId, "Usage: `/msg <agent-slug> <your message>`");
      return;
    }
    const targetSlug = parts[0];
    const messageText = parts.slice(1).join(" ");

    await sendTyping(chatId);
    try {
      // First discover the agent to get their ID
      const discovered = await cli("discover", "--query", targetSlug);
      const agents = discovered.data?.agents ?? [];
      const target = agents.find(a => a.slug === targetSlug || a.slug?.includes(targetSlug));
      if (!target) {
        await sendTelegram(chatId, `❌ Agent \`${targetSlug}\` not found. Check the slug and try again.`);
        return;
      }

      const threadResult = await cli("thread", "start",
        "--agent", AGENT_SLUG,
        "--recipient", target.slug,
        "--message", messageText
      );
      const threadId = threadResult.data?.threadId;
      await sendTelegram(chatId, `✅ Message sent to *${target.slug}*${threadId ? ` (thread #${threadId})` : ""}.`);
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Failed to send message: ${err.message}`);
    }
    return;
  }

  // /reply <threadId> <message>
  if (text.startsWith("/reply ")) {
    const parts = text.slice(7).trim().split(" ");
    if (parts.length < 2) {
      await sendTelegram(chatId, "Usage: `/reply <thread-id> <your message>`");
      return;
    }
    const threadId = parts[0];
    const messageText = parts.slice(1).join(" ");

    await sendTyping(chatId);
    try {
      await cli("thread", "reply",
        "--agent", AGENT_SLUG,
        "--thread", threadId,
        "--message", messageText
      );
      await sendTelegram(chatId, `✅ Reply sent to thread #${threadId}.`);
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Failed to reply: ${err.message}`);
    }
    return;
  }

  // Default: chat with MiMo
  try {
    await sendTyping(chatId);
    const reply = await askMiMo(chatId, text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error("Error:", err);
    await sendTelegram(chatId, `⚠️ Error: ${err.message}`);
  }
});

app.get("/", (_req, res) => res.json({ ok: true, status: "running" }));

const PORT = process.env.PORT || 3000;

async function registerWebhook() {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      allowed_updates: ["message", "message_reaction"],
    }),
  });
  console.log(`Webhook registered: ${url}`);
}

restoreMasumiSession().then(() => {
  app.listen(PORT, () => {
    console.log(`Bot running on port ${PORT}`);
    registerWebhook().catch(console.error);
  });
});
