import express from "express";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;
const MASUMI_BACKUP_B64 = process.env.MASUMI_BACKUP_B64;
const MASUMI_BACKUP_PASSPHRASE = process.env.MASUMI_BACKUP_PASSPHRASE || "assistant-thyme";
const MASUMI_BUNDLE_B64 = process.env.MASUMI_BUNDLE_B64;
const AGENT_SLUG = process.env.AGENT_SLUG || "thyme-thymestudio-co";
const BF_SLUG = "patrick-nmkr-io";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Base nicknames — extended dynamically via Redis
const BASE_NICKNAMES = {
  "patrick": "patrick-nmkr-io",
  "bf": "patrick-nmkr-io",
  "boyfriend": "patrick-nmkr-io",
};
let NICKNAMES = { ...BASE_NICKNAMES };

const MASUMI_CLI = "masumi-agent-messenger";
const MASUMI_BACKUP_FILE = "/tmp/masumi-backup.json";

const SYSTEM_PROMPT = `You are thyme-thymestudio-co, Alexa's agent on the Masumi Agent Messenger network. Masumi is your entire world right now — every conversation, every message, every question Alexa asks is in the context of Masumi agent messaging unless she explicitly says otherwise.

Your job: be Alexa's interface to the Masumi network. Help her send messages to other agents, manage her inbox, understand who she's talking to, and navigate the network.

## Known agents
- patrick-nmkr-io — Patrick, Alexa's boyfriend (PERSON). Keep it casual and warm.

## Agent types
- PERSON: a real human's agent. Talk like a person, match the vibe.
- WORKER: a task agent. Treat it like a service.
- UNCATEGORIZED: unknown. Default to PERSON behavior, no payments, ask Alexa to classify when relevant.

## When Alexa mentions a person or agent you don't know
Ask: "Is this a friend's agent (person) or a task agent (worker)?" — once, briefly.

## Sending messages
- Default: show Alexa the message and confirm before sending (y / n / e).
- If Alexa uses >> prefix: send exactly as typed, no changes.
- Reformat only if Alexa asks.

## Inbox
Triage: PERSON messages first with a casual summary, WORKER messages with task/cost, UNCATEGORIZED last.

## Tone
Short, direct, a little personality. This is chat. No bullet-point essays unless asked.`;

const histories = new Map();
const state = new Map();
let agentDirectory = []; // cached full agent list

async function buildDirectory() {
  console.log("Building agent directory...");
  const seen = new Set();
  const all = [];

  // Search common letters to maximize coverage
  for (const q of ["a", "e", "i", "o", "s", "t", "n", "agent", "io", "bot", "patrick"]) {
    try {
      const result = await cli("discover", "search", q);
      for (const a of result.data?.results ?? []) {
        if (!seen.has(a.slug)) {
          seen.add(a.slug);
          all.push(a);
        }
      }
    } catch {}
  }

  if (all.length > 0) {
    agentDirectory = all;
    await redisSet("agent_directory", all);
    console.log(`Directory built: ${all.length} agents`);
  } else {
    console.log("No agents found in directory build");
  }
  return all;
}

async function loadDirectory() {
  const saved = await redisGet("agent_directory");
  if (saved?.length) {
    agentDirectory = saved;
    console.log(`Loaded ${saved.length} agents from Redis`);
  }
  // Refresh in background regardless
  buildDirectory().catch(console.error);
}

let sessionReady = false;

async function restoreMasumiSession() {
  if (MASUMI_BUNDLE_B64) {
    try {
      const bundle = JSON.parse(Buffer.from(MASUMI_BUNDLE_B64, "base64").toString("utf8"));
      const cliDir = path.join(homedir(), ".config", "masumi-agent-messenger", "cli");
      mkdirSync(cliDir, { recursive: true, mode: 0o700 });
      chmodSync(cliDir, 0o700);
      const configPath = path.join(cliDir, "config.json");
      const secretsPath = path.join(cliDir, "secrets.json");
      writeFileSync(configPath, JSON.stringify(bundle.config, null, 2), { mode: 0o600 });
      writeFileSync(secretsPath, JSON.stringify(bundle.secrets, null, 2), { mode: 0o600 });
      chmodSync(configPath, 0o600);
      chmodSync(secretsPath, 0o600);
      console.log(`Masumi bundle written to ${cliDir} (${Object.keys(bundle.secrets.entries).length} secrets)`);
      sessionReady = true;
      return;
    } catch (err) {
      console.error("Failed to write masumi bundle:", err.message);
      sessionReady = false;
      return;
    }
  }
  if (!MASUMI_BACKUP_B64) {
    console.log("No MASUMI_BUNDLE_B64 or MASUMI_BACKUP_B64 — agent messaging disabled.");
    return;
  }
  try {
    const json = Buffer.from(MASUMI_BACKUP_B64, "base64").toString("utf8");
    writeFileSync(MASUMI_BACKUP_FILE, json);
    const out = execFileSync(MASUMI_CLI, [
      "account", "backup", "import",
      "--file", MASUMI_BACKUP_FILE,
      "--passphrase", MASUMI_BACKUP_PASSPHRASE,
      "--json",
    ], { encoding: "utf8", env: MASUMI_ENV });
    console.log("Masumi session restored:", out.slice(0, 200));
    sessionReady = true;
  } catch (err) {
    console.error("Failed to restore masumi session:", err.message, err.stderr || "");
    sessionReady = false;
  }
}

function requireSession(chatId) {
  if (!sessionReady) {
    sendTelegram(chatId, "⚠️ Masumi session not connected. Update MASUMI\\_BACKUP\\_B64 on Render with a fresh export.");
    return false;
  }
  return true;
}

const MASUMI_ENV = { ...process.env, MASUMI_FORCE_FILE_BACKEND: "1" };

async function cli(...args) {
  console.log(`[CLI] ${MASUMI_CLI} ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync(MASUMI_CLI, [...args, "--json"], { env: MASUMI_ENV });
    if (stderr) console.error(`[CLI stderr]`, stderr);
    const parsed = JSON.parse(stdout);
    // Treat API-level errors as thrown exceptions
    if (parsed.error || parsed.status === "error") {
      throw new Error(parsed.error?.message || parsed.message || JSON.stringify(parsed));
    }
    console.log(`[CLI result]`, JSON.stringify(parsed).slice(0, 200));
    return parsed;
  } catch (err) {
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout);
        if (parsed.error || parsed.status === "error") {
          throw new Error(parsed.error?.message || parsed.message || JSON.stringify(parsed));
        }
        return parsed;
      } catch (parseErr) {
        if (parseErr !== err) throw parseErr;
      }
    }
    console.error(`[CLI error] ${err.message}\nstderr: ${err.stderr || ""}\nstdout: ${err.stdout || ""}`);
    throw err;
  }
}

async function sendTelegram(chatId, text, buttons = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function answerCallback(callbackId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId }),
  });
}

async function sendTyping(chatId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

async function ack(chatId, text) {
  await sendTelegram(chatId, text);
  sendTyping(chatId);
}

// --- Redis helpers ---
async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["GET", key]),
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify(value)]),
    });
  } catch {}
}

async function loadHistory(chatId) {
  if (histories.has(chatId)) return histories.get(chatId);
  const saved = await redisGet(`history:${chatId}`);
  const history = saved ?? [];
  histories.set(chatId, history);
  return history;
}

async function loadNicknames() {
  const saved = await redisGet("nicknames");
  if (saved) NICKNAMES = { ...BASE_NICKNAMES, ...saved };
}

async function saveNicknames() {
  const custom = Object.fromEntries(
    Object.entries(NICKNAMES).filter(([k]) => !BASE_NICKNAMES[k])
  );
  await redisSet("nicknames", custom);
}
// ---------------------

async function askMiMo(chatId, userMessage) {
  const history = await loadHistory(chatId);
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
  histories.set(chatId, history);
  redisSet(`history:${chatId}`, history); // persist async, don't await
  return reply;
}

async function rephraseMessage(raw, recipientName = "someone") {
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
            content: `You are helping someone write a message to ${recipientName}. Rewrite their message to sound natural, clear, and like the sender. Keep the same tone and intent. Output ONLY the rewritten message — no quotes, no explanation.`,
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

async function reformatForBf(raw) {
  return rephraseMessage(raw, "her boyfriend Patrick");
}

function wantsToMessageBf(text) {
  const t = text.toLowerCase();
  return (
    /\b(message|msg|send|text|tell|write)\b/.test(t) &&
    /\b(bf|boyfriend|patrick)\b/.test(t)
  ) || t === "/bf";
}

function resolveNickname(text) {
  const t = text.toLowerCase().trim();
  return NICKNAMES[t] || null;
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
  await ack(chatId, "💌 Sending to Patrick...");
  try {
    const result = await cli("thread", "send",
      "--agent", AGENT_SLUG,
      BF_SLUG,
      message
    );
    const threadId = result.data?.threadId;
    await sendTelegram(chatId, `✅ Delivered to Patrick! 💌`);
  } catch (err) {
    await sendTelegram(chatId, `⚠️ Failed to send: ${err.message}`);
  }
}

async function sendAgentMessage(chatId, s) {
  state.delete(chatId);
  await ack(chatId, `📨 Sending to ${s.name}...`);
  try {
    const result = await cli("thread", "send", "--agent", AGENT_SLUG, s.slug, s.message);
    const threadId = result.data?.threadId;
    await sendTelegram(chatId, `✅ Delivered to *${s.name}*!`);
  } catch (err) {
    await sendTelegram(chatId, `⚠️ Failed to send: ${err.message}`);
  }
}

async function sendThreadReply(chatId, s) {
  state.delete(chatId);
  await ack(chatId, `↩️ Sending reply to ${s.sender}...`);
  try {
    await cli("thread", "reply", "--agent", AGENT_SLUG, s.threadId, s.message);
    await sendTelegram(chatId, `✅ Reply sent to *${s.sender}*!`);
  } catch (err) {
    await sendTelegram(chatId, `⚠️ Failed to reply: ${err.message}`);
  }
}

async function showBfConfirm(chatId, message) {
  state.set(chatId, { type: "bf_confirm", message });
  await sendTelegram(chatId, `💌 "${message}"`, [
    [{ text: "✅", callback_data: "bf_send" }, { text: "🤖 AI", callback_data: "bf_ai" }, { text: "✏️ Edit", callback_data: "bf_edit" }, { text: "❌", callback_data: "bf_cancel" }]
  ]);
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

  // Inline button taps
  const cb = req.body?.callback_query;
  if (cb) {
    await answerCallback(cb.id);
    const chatId = String(cb.message.chat.id);
    const data = cb.data;

    if (data === "agent_select:cancel") {
      state.delete(chatId);
      await sendTelegram(chatId, "❌ Cancelled.");
      return;
    }

    if (data.startsWith("agent_select:")) {
      const [, slug, name] = data.split(":");
      state.set(chatId, { type: "agent_awaiting_message", slug, name: name || slug });
      await sendTelegram(chatId, `💬 What do you want to say to *${name || slug}*?`);
      return;
    }

    if (data === "bf_send") {
      const s = state.get(chatId);
      if (s?.type === "bf_confirm") await sendMessageToPatrick(chatId, s.message);
      return;
    }
    if (data === "bf_cancel") {
      state.delete(chatId);
      await sendTelegram(chatId, "❌ Cancelled.");
      return;
    }
    if (data === "bf_edit") {
      state.set(chatId, { type: "bf_editing" });
      await sendTelegram(chatId, "✏️ Type your edited message:");
      return;
    }
    if (data === "bf_ai") {
      const s = state.get(chatId);
      if (s?.type === "bf_confirm") {
        await sendTelegram(chatId, "🤖 Rephrasing...");
        const rephrased = await rephraseMessage(s.message, "her boyfriend Patrick");
        state.set(chatId, { type: "bf_confirm", message: rephrased });
        await sendTelegram(chatId, `💌 "${rephrased}"`, [
          [{ text: "✅", callback_data: "bf_send" }, { text: "🤖 Again", callback_data: "bf_ai" }, { text: "✏️ Edit", callback_data: "bf_edit" }, { text: "❌", callback_data: "bf_cancel" }]
        ]);
      }
      return;
    }

    if (data === "msg_send") {
      const s = state.get(chatId);
      if (s?.type === "agent_confirm") await sendAgentMessage(chatId, s);
      return;
    }
    if (data === "msg_cancel") {
      state.delete(chatId);
      await sendTelegram(chatId, "❌ Cancelled.");
      return;
    }
    if (data === "msg_edit") {
      const s = state.get(chatId);
      if (s?.type === "agent_confirm") {
        state.set(chatId, { type: "agent_awaiting_message", slug: s.slug, name: s.name });
        await sendTelegram(chatId, "✏️ Type your edited message:");
      }
      return;
    }
    if (data === "msg_ai") {
      const s = state.get(chatId);
      if (s?.type === "agent_confirm") {
        await sendTelegram(chatId, "🤖 Rephrasing...");
        const rephrased = await rephraseMessage(s.message, s.name);
        state.set(chatId, { type: "agent_confirm", slug: s.slug, name: s.name, message: rephrased });
        await sendTelegram(chatId, `📨 To *${s.name}*:\n\n"${rephrased}"`, [
          [{ text: "✅", callback_data: "msg_send" }, { text: "🤖 Again", callback_data: "msg_ai" }, { text: "✏️ Edit", callback_data: "msg_edit" }, { text: "❌", callback_data: "msg_cancel" }]
        ]);
      }
      return;
    }

    if (data.startsWith("reply:")) {
      const [, threadId, sender] = data.split(":");
      state.set(chatId, { type: "reply_awaiting", threadId, sender: sender || "them" });
      await sendTelegram(chatId, `↩️ What do you want to reply to *${sender || "them"}*?`);
      return;
    }

    if (data === "reply_send") {
      const s = state.get(chatId);
      if (s?.type === "reply_confirm") await sendThreadReply(chatId, s);
      return;
    }
    if (data === "reply_cancel") {
      state.delete(chatId);
      await sendTelegram(chatId, "❌ Cancelled.");
      return;
    }
    if (data === "reply_edit") {
      const s = state.get(chatId);
      if (s?.type === "reply_confirm") {
        state.set(chatId, { type: "reply_awaiting", threadId: s.threadId, sender: s.sender });
        await sendTelegram(chatId, "✏️ Type your edited reply:");
      }
      return;
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

    if (s.type === "bf_confirm") {
      if (/^(y|yes|send|yep|yup|ok|okay)$/i.test(answer)) {
        await sendMessageToPatrick(chatId, s.message);
      } else if (/^(edit|e|change|rewrite|fix)$/i.test(answer)) {
        state.set(chatId, { type: "bf_editing" });
        await sendTelegram(chatId, "✏️ Type your edited message:");
      } else if (/^(n|no|cancel|nope)$/i.test(answer)) {
        state.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else if (/clean|reformat/.test(answer)) {
        await ack(chatId, "✨ Rewriting...");
        const reformatted = await reformatForBf(s.message);
        state.set(chatId, { type: "bf_confirm", message: reformatted });
        await sendTelegram(chatId, `💌 "${reformatted}"\n\ny / n / e`);
      } else {
        await sendTelegram(chatId, "y / n / e");
      }
      return;
    }

    // Agent picker — waiting for user to pick a number or name
    if (s.type === "agent_select") {
      const pick = text.trim();
      const lower = pick.toLowerCase();
      const agents = s.agents;

      if (lower === "cancel") { state.delete(chatId); await sendTelegram(chatId, "❌ Cancelled."); return; }

      // Positive / affirmative → pick first agent
      const isAffirmative = /^(yes|yeah|yep|yup|sure|him|her|them|he|she|it|ok|okay|that one|first one|1st)$/i.test(lower);
      const byNumber = parseInt(pick) - 1;
      const nicknameSlug = resolveNickname(lower);

      const chosen = isAffirmative
        ? agents[0]
        : (!isNaN(byNumber) && agents[byNumber])
          ? agents[byNumber]
          : nicknameSlug
            ? { slug: nicknameSlug, displayName: pick }
            : agents.find(a => (a.slug || "").includes(lower) || (a.displayName || "").toLowerCase().includes(lower));

      if (!chosen) {
        await sendTelegram(chatId, "Pick a number from the list, or say cancel.");
        return;
      }
      state.set(chatId, { type: "agent_awaiting_message", slug: chosen.slug, name: chosen.displayName || chosen.slug });
      await sendTelegram(chatId, `💬 What do you want to say to *${chosen.displayName || chosen.slug}*?`);
      return;
    }

    if (s.type === "agent_awaiting_message") {
      state.set(chatId, { type: "agent_confirm", slug: s.slug, name: s.name, message: text });
      await sendTelegram(chatId, `📨 To *${s.name}*:\n\n"${text}"`, [
        [{ text: "✅", callback_data: "msg_send" }, { text: "🤖 AI", callback_data: "msg_ai" }, { text: "✏️ Edit", callback_data: "msg_edit" }, { text: "❌", callback_data: "msg_cancel" }]
      ]);
      return;
    }

    if (s.type === "reply_awaiting") {
      state.set(chatId, { type: "reply_confirm", threadId: s.threadId, sender: s.sender, message: text });
      await sendTelegram(chatId, `↩️ Reply to *${s.sender}*:\n\n"${text}"`, [
        [{ text: "✅", callback_data: "reply_send" }, { text: "✏️ Edit", callback_data: "reply_edit" }, { text: "❌", callback_data: "reply_cancel" }]
      ]);
      return;
    }

    if (s.type === "reply_confirm") {
      if (/^(y|yes|send|yep|yup|ok|okay)$/i.test(answer)) {
        await sendThreadReply(chatId, s);
      } else if (/^(edit|e|change|rewrite|fix)$/i.test(answer)) {
        state.set(chatId, { type: "reply_awaiting", threadId: s.threadId, sender: s.sender });
        await sendTelegram(chatId, "✏️ Type your edited reply:");
      } else if (/^(n|no|cancel|nope)$/i.test(answer)) {
        state.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else {
        await sendTelegram(chatId, "y / n / e");
      }
      return;
    }

    if (s.type === "agent_confirm") {
      if (/^(y|yes|send|yep|yup|ok|okay)$/i.test(answer)) {
        await sendAgentMessage(chatId, s);
      } else if (/^(edit|e|change|rewrite|fix)$/i.test(answer)) {
        state.set(chatId, { type: "agent_awaiting_message", slug: s.slug, name: s.name });
        await sendTelegram(chatId, "✏️ Type your edited message:");
      } else if (/^(n|no|cancel|nope)$/i.test(answer)) {
        state.delete(chatId);
        await sendTelegram(chatId, "❌ Cancelled.");
      } else {
        await sendTelegram(chatId, "y / n / e");
      }
      return;
    }

  }

  if (text === "/start" || /what can i do/i.test(text) || /\b(help|hi|hello|hey)\b/i.test(text) && text.length < 20) {
    await sendTelegram(chatId,
      "👋 *Here's what I can do:*\n\n" +
      "📬 *Inbox*\n" +
      "\"do I have any messages?\"\n\n" +
      "💌 *Message your bf*\n" +
      "\"send a message to my bf\"\n" +
      "\"message Patrick: hey!\"\n\n" +
      "📨 *Message any agent*\n" +
      "\"I want to send a message\" → pick from list\n\n" +
      "↩️ *Reply to a message*\n" +
      "\"reply to thread 42: sounds good!\"\n\n" +
      "🔍 *Browse agents*\n" +
      "\"show me contacts\"\n\n" +
      "🏷 *Look up a slug*\n" +
      "\"what's Patrick's slug?\"\n\n" +
      "💬 *Chat*\n" +
      "Anything else — just talk to me!"
    );
    return;
  }

  if (/\bclear\b/i.test(text) && text.length < 20) {
    histories.delete(chatId);
    state.delete(chatId);
    redisSet(`history:${chatId}`, []);
    await sendTelegram(chatId, "🧹 Conversation cleared.");
    return;
  }

  // Natural language: show contacts
  if (/\b(contacts|agents|who can i message|show.*agent|list.*agent)\b/i.test(text)) {
    await ack(chatId, "🔍 Loading agents...");
    try {
      let agents = agentDirectory;
      if (agents.length === 0) {
        agents = await buildDirectory();
      }
      if (agents.length === 0) {
        await sendTelegram(chatId, "No agents found. Try \"refresh contacts\" in a moment.");
        return;
      }
      const lines = agents.slice(0, 30).map(a => `• ${a.displayName || a.name || a.slug} — \`${a.slug}\``);
      await sendTelegram(chatId, `*Agents (${agents.length}):*\n\n${lines.join("\n")}`);
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
    await ack(chatId, "↩️ Sending reply...");
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
    await ack(chatId, "📬 Checking your inbox...");
    try {
      const result = await cli("thread", "unread", "--agent", AGENT_SLUG);
      const messages = result.data?.messages ?? [];
      if (messages.length === 0) {
        await sendTelegram(chatId, "📭 No new messages.");
      } else {
        await sendTelegram(chatId, `📬 *${messages.length} new message${messages.length > 1 ? "s" : ""}:*`);
        for (const m of messages) {
          const sender = m.sender?.displayName || m.sender?.slug || "Unknown";
          const threadId = String(m.threadId ?? m.thread_id);
          const senderShort = sender.slice(0, 20);
          await sendTelegram(chatId,
            `*From:* ${sender}\n\n${m.text}`,
            [[{ text: "↩️ Reply", callback_data: `reply:${threadId}:${senderShort}` }]]
          );
          await cli("thread", "read", threadId, "--agent", AGENT_SLUG).catch(() => {});
        }
      }
    } catch (err) {
      await sendTelegram(chatId, `⚠️ Could not check inbox: ${err.message}`);
    }
    return;
  }

  // "refresh contacts/directory"
  if (/\b(refresh|update|reload)\b/i.test(text) && /\b(contacts|agents|directory|list)\b/i.test(text)) {
    await ack(chatId, "🔄 Refreshing agent directory...");
    const all = await buildDirectory();
    await sendTelegram(chatId, `✅ Directory updated — ${all.length} agents found.`);
    return;
  }

  // Natural language: send a message (shows agent picker from cached directory)
  if (wantsToSendMessage(text)) {
    const knownAgents = Object.entries(NICKNAMES)
      .filter(([nick]) => nick !== "bf" && nick !== "boyfriend")
      .map(([nick, slug]) => ({ slug, displayName: nick.charAt(0).toUpperCase() + nick.slice(1) }));
    const seen = new Set(knownAgents.map(a => a.slug));
    const all = [...knownAgents, ...agentDirectory.filter(a => !seen.has(a.slug))];
    if (all.length === 0) {
      await sendTelegram(chatId, "No agents in directory yet. Say \"refresh contacts\" to load them.");
      return;
    }
    state.set(chatId, { type: "agent_select", agents: all });
    const buttons = all.slice(0, 20).map(a => ([{
      text: a.displayName || a.name || a.slug,
      callback_data: `agent_select:${a.slug}:${a.displayName || a.name || a.slug}`,
    }]));
    buttons.push([{ text: "❌", callback_data: "agent_select:cancel" }]);
    await sendTelegram(chatId, `Who do you want to message? (${all.length} agents)`, buttons);
    return;
  }

  // "yes message X" or "yes send X" — treat as bf message
  const yesMessageMatch = text.match(/^(yes\s+)?(message|msg|send|text)\s+(.+)/i);
  if (yesMessageMatch && !wantsToSendMessage(text)) {
    const messageText = yesMessageMatch[3].trim();
    await showBfConfirm(chatId, messageText);
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

  // "what is the slug" / "what's the agent's slug"
  if (/what'?s?\s+(the\s+)?(agent'?s?\s+)?slug/i.test(text) || /what is the slug/i.test(text)) {
    const current = state.get(chatId);
    // If mid-conversation with a known agent
    if (current?.slug) {
      await sendTelegram(chatId, `\`${current.slug}\``);
      return;
    }
    // If asking about bf
    if (/\b(bf|boyfriend|patrick)\b/i.test(text)) {
      await sendTelegram(chatId, `\`${BF_SLUG}\``);
      return;
    }
    await sendTelegram(chatId, "Your agent slug is `thyme-thymestudio-co`.");
    return;
  }

  // "what's X's agent name" / "what's X's slug"
  const agentNameMatch = text.match(/what'?s?\s+(\w+)'?s?\s+(agent|slug|masumi)/i);
  if (agentNameMatch) {
    const name = agentNameMatch[1].toLowerCase();
    const slug = resolveNickname(name);
    if (slug) {
      await sendTelegram(chatId, `${agentNameMatch[1]}'s agent slug is \`${slug}\``);
    } else {
      await sendTelegram(chatId, `I don't have a nickname saved for "${agentNameMatch[1]}". Ask me to add one!`);
    }
    return;
  }

  // Default: chat with MiMo
  try {
    sendTyping(chatId);
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
      allowed_updates: ["message", "message_reaction", "callback_query"],
    }),
  });
  console.log(`Webhook registered: ${url}`);
}

restoreMasumiSession().then(async () => {
  await loadNicknames();
  loadDirectory().catch(console.error);
  app.listen(PORT, () => {
    console.log(`Bot running on port ${PORT}`);
    registerWebhook().catch(console.error);
  });
});
