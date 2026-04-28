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

const SYSTEM_PROMPT = `You are a personal AI assistant connected to the Masumi agent messaging network.
Your user's agent slug is thyme-thymestudio-co. Her boyfriend's agent is patrick-nmkr-io.
When the user talks about messages, inbox, contacts, or sending something — they mean Masumi agent messages.
Answer directly and concisely. Be honest when you're unsure rather than guessing.`;

const histories = new Map();

// state per chat: { type: "bf_awaiting" | "bf_confirm" | "bf_confirm_reformatted", message?, reformatted? }
const state = new Map();

async function restoreMasumiSession() {
  if (!MASUMI_BACKUP_B64) {
    console.log("No MASUMI_BACKUP_B64 — agent messaging disabled.");
    return;
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
  } catch (err) {
    console.error("Failed to restore masumi session:", err.message);
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
            content: "You are helping someone write a message to their boyfriend Patrick. Rewrite the message to sound natural, warm, and like the sender. Keep the tone casual. Output ONLY the rewritten message — no quotes, no explanation.",
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

function wantsToMessageBf(text) {
  const t = text.toLowerCase();
  return (
    /\b(message|msg|send|text|tell|write)\b/.test(t) &&
    /\b(bf|boyfriend|patrick)\b/.test(t)
  ) || t === "/bf";
}

function wantsToSendMessage(text) {
  const t = text.toLowerCase();
  return /\b(send|write|compose)\b/.test(t) && /\b(message|msg)\b/.test(t) && !wantsToMessageBf(text);
}

function wantsToCheckInbox(text) {
  const t = text.toLowerCase();
  return /\b(any|check|got|have|see|show)\b/.test(t) && /\b(message|messages|inbox|mail)\b/.test(t)
    || /\bcheck (my )?(inbox|messages)\b/.test(t)
    || /\bdo i have\b/.test(t)
    || /\bany messages\b/.test(t)
    || /\bmy inbox\b/.test(t);
}

async function sendMessageToPatrick(chatId, message) {
  state.delete(chatId);
  await sendTyping(chatId);
  try {
    const result = await cli("thread", "start",
      "--agent", AGENT_SLUG,
      BF_SLUG,
      message
    );
    const threadId = result.data?.threadId;
    await sendTelegram(chatId, `✅ Sent to Patrick${threadId ? ` (thread #${threadId})` : ""}! 💌`);
  } catch (err) {
    await sendTelegram(chatId, `⚠️ Failed to send: ${err.message}`);
  }
}

async function showBfConfirm(chatId, message) {
  state.set(chatId, { type: "bf_confirm", message });
  await sendTelegram(chatId,
    `💌 Ready to send to Patrick:\n\n"${message}"\n\n` +
    `Reply *send*, *clean it up*, or *cancel*.`
  );
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // ✅ emoji reaction = send
  const reaction = req.body?.message_reaction;
  if (reaction) {
    const chatId = String(reaction.chat?.id);
    const isCheckmark = reaction.new_reaction?.some(r => r.type === "emoji" && r.emoji === "✅");
    const s = state.get(chatId);
    if (isCheckmark && s?.type === "bf_confirm") {
      await sendMessageToPatrick(chatId, s.message);
    }
    if (isCheckmark && s?.type === "bf_confirm_reformatted") {
      await sendMessageToPatrick(chatId, s.reformatted);
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

  // Handle active state first
  const s = state.get(chatId);
  if (s) {
    const answer = text.toLowerCase().trim();

    // Waiting for the message to send
    if (s.type === "bf_awaiting") {
      await showBfConfirm(chatId, text);
      return;
    }

    // Showing message as-is, waiting for send / clean it up / cancel
    if (s.type === "bf_confirm") {
      if (answer === "send" || answer === "yes" || answer === "send it") {
        await sendMessageToPatrick(chatId, s.message);
      } else if (/clean|reformat|fix|rewrite|change/.test(answer)) {
        await sendTyping(chatId);
        const reformatted = await reformatForBf(s.message);
        state.set(chatId, { type: "bf_confirm_reformatted", message: s.message, reformatted });
        await sendTelegram(chatId,
          `✨ Here's a cleaned-up version:\n\n"${reformatted}"\n\n` +
          `Reply *send this*, *keep original*, or *cancel*.`
        );
      } else if (answer === "cancel" || answer === "no") {
        state.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else {
        await sendTelegram(chatId, `Reply *send*, *clean it up*, or *cancel*.`);
      }
      return;
    }

    // Agent picker — waiting for user to pick a number or name
    if (s.type === "agent_select") {
      const pick = text.trim();
      const byNumber = parseInt(pick) - 1;
      const agents = s.agents;
      const chosen = !isNaN(byNumber) && agents[byNumber]
        ? agents[byNumber]
        : agents.find(a => (a.slug || "").includes(pick.toLowerCase()) || (a.displayName || "").toLowerCase().includes(pick.toLowerCase()));
      if (!chosen) {
        await sendTelegram(chatId, "Pick a number from the list, or say cancel.");
        return;
      }
      if (pick.toLowerCase() === "cancel") { state.delete(chatId); await sendTelegram(chatId, "❌ Cancelled."); return; }
      state.set(chatId, { type: "agent_awaiting_message", slug: chosen.slug, name: chosen.displayName || chosen.slug });
      await sendTelegram(chatId, `💬 What do you want to say to *${chosen.displayName || chosen.slug}*?`);
      return;
    }

    // Waiting for message to a specific agent
    if (s.type === "agent_awaiting_message") {
      state.set(chatId, { type: "agent_confirm", slug: s.slug, name: s.name, message: text });
      await sendTelegram(chatId, `📨 Send this to *${s.name}*?\n\n"${text}"\n\nReply *send* or *cancel*.`);
      return;
    }

    // Confirm send to agent
    if (s.type === "agent_confirm") {
      const answer = text.toLowerCase().trim();
      if (answer === "send" || answer === "yes") {
        state.delete(chatId);
        await sendTyping(chatId);
        try {
          const result = await cli("thread", "start", "--agent", AGENT_SLUG, s.slug, s.message);
          const threadId = result.data?.threadId;
          await sendTelegram(chatId, `✅ Sent to *${s.name}*${threadId ? ` (thread #${threadId})` : ""}!`);
        } catch (err) {
          await sendTelegram(chatId, `⚠️ Failed to send: ${err.message}`);
        }
      } else if (answer === "cancel" || answer === "no") {
        state.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else {
        await sendTelegram(chatId, "Reply *send* or *cancel*.");
      }
      return;
    }

    // Showing reformatted version
    if (s.type === "bf_confirm_reformatted") {
      if (/send this|send|yes/.test(answer)) {
        await sendMessageToPatrick(chatId, s.reformatted);
      } else if (/keep|original|mine/.test(answer)) {
        await sendMessageToPatrick(chatId, s.message);
      } else if (answer === "cancel" || answer === "no") {
        state.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else {
        await sendTelegram(chatId, `Reply *send this*, *keep original*, or *cancel*.`);
      }
      return;
    }
  }

  if (text === "/start" || /\b(help|hi|hello|hey)\b/i.test(text) && text.length < 20) {
    await sendTelegram(chatId,
      "👋 Hi! Just talk to me naturally:\n\n" +
      "• \"do I have any messages?\"\n" +
      "• \"send a message to my bf\"\n" +
      "• \"show me contacts\"\n" +
      "• \"reply to thread 42: hey!\"\n\n" +
      "Or just chat with me about anything!"
    );
    return;
  }

  if (/\bclear\b/i.test(text) && text.length < 20) {
    histories.delete(chatId);
    state.delete(chatId);
    await sendTelegram(chatId, "🧹 Conversation cleared.");
    return;
  }

  // Natural language: show contacts
  if (/\b(contacts|agents|who can i message|show.*agent|list.*agent)\b/i.test(text)) {
    await sendTyping(chatId);
    const queryMatch = text.match(/\b(find|search|look for)\b.+?(\w[\w-]+)/i);
    const query = queryMatch?.[2] || "";
    try {
      const result = await cli(...(query ? ["discover", "--query", query] : ["agents", "list"]));
      const agents = result.data?.agents ?? [];
      if (agents.length === 0) {
        await sendTelegram(chatId, "No agents found.");
        return;
      }
      const lines = agents.slice(0, 20).map(a => `• ${a.displayName || a.name || a.slug} — \`${a.slug}\``);
      await sendTelegram(chatId, `*Agents:*\n\n${lines.join("\n")}`);
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Could not load contacts: ${err.message}`);
    }
    return;
  }

  // Natural language: reply to thread — "reply to 42: hey" or "reply to thread 42 hey"
  const replyMatch = text.match(/\breply\b.{0,20}?\b(\d+)\b[:\s]+(.+)/is);
  if (replyMatch) {
    const threadId = replyMatch[1];
    const message = replyMatch[2].trim();
    await sendTyping(chatId);
    try {
      await cli("thread", "reply", "--agent", AGENT_SLUG, threadId, message);
      await sendTelegram(chatId, `✅ Reply sent!`);
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Failed to reply: ${err.message}`);
    }
    return;
  }

  // Natural language: check inbox
  if (wantsToCheckInbox(text)) {
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
            `*From:* ${sender}\n*Thread ID:* \`${threadId}\`\n\n${m.text}\n\n↩️ /reply ${threadId} <message>`
          );
          await cli("thread", "read", String(threadId), "--agent", AGENT_SLUG).catch(() => {});
        }
      }
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Could not check inbox: ${err.message}`);
    }
    return;
  }

  // Natural language: send a message (shows agent picker)
  if (wantsToSendMessage(text)) {
    await sendTyping(chatId);
    try {
      const result = await cli("agents", "list");
      const agents = result.data?.agents ?? [];
      if (agents.length === 0) {
        await sendTelegram(chatId, "No agents found on the network.");
        return;
      }
      state.set(chatId, { type: "agent_select", agents });
      const lines = agents.slice(0, 20).map((a, i) => `${i + 1}. ${a.displayName || a.name || a.slug}`);
      await sendTelegram(chatId, `Who do you want to message?\n\n${lines.join("\n")}\n\nPick a number or say cancel.`);
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Could not load agents: ${err.message}`);
    }
    return;
  }

  // Natural language: wants to message bf
  if (wantsToMessageBf(text)) {
    // If they included the message inline e.g. "send this to my bf: hey love you"
    const colonSplit = text.match(/[:—]\s*(.+)$/s);
    if (colonSplit) {
      await showBfConfirm(chatId, colonSplit[1].trim());
    } else {
      state.set(chatId, { type: "bf_awaiting" });
      await sendTelegram(chatId, "💌 What do you want to say to Patrick?");
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
