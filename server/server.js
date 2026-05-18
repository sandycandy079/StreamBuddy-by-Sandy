// ================================================================
// StreamBuddy By Sandy — SaaS Server
//  Multi-user | License Keys | Auto-update | Gemini AI
// ================================================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { WebcastPushConnection } from 'tiktok-live-connector';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
//  CONFIG — All secrets come from environment variables
//  Set these in Railway → your service → Variables tab
// ================================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_me_now';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || ''; // full service account JSON string
const CURRENT_VERSION = '1.0.0';
const PORT = process.env.PORT || 3000;

// ================================================================
//  DATABASE (flat JSON files — persistent across Railway deploys!)
//
//  ⚠️  Railway ephemeral filesystem fix:
//  Files under __dirname are wiped on every deploy.
//  Store data in /data which is a Railway Persistent Volume mount.
//  Falls back to ./db for local development.
// ================================================================
const VOLUME_PATH = '/data';
const DB_PATH = fs.existsSync(VOLUME_PATH) ? VOLUME_PATH : path.join(__dirname, 'db');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
console.log(`[DB] Storage path: ${DB_PATH}`);

function readDB(name) {
  const file = path.join(DB_PATH, `${name}.json`);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeDB(name, data) {
  fs.writeFileSync(path.join(DB_PATH, `${name}.json`), JSON.stringify(data, null, 2));
}

// Initialize DBs
let licenses = readDB('licenses');
let users = readDB('users'); // sessionId → { licenseKey, tiktokUsername, connectedAt }

// ================================================================
//  LICENSE KEY SYSTEM
// ================================================================
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `NUMB-${seg()}-${seg()}-${seg()}`;
}

function isValidLicense(key) {
  const lic = licenses[key];
  if (!lic) return { valid: false, reason: 'Invalid license key' };
  if (!lic.active) return { valid: false, reason: 'License has been revoked' };
  if (lic.expiresAt && new Date() > new Date(lic.expiresAt)) return { valid: false, reason: 'License has expired' };
  return { valid: true, license: lic };
}

function getLicenseByTikTok(tiktokUsername) {
  return Object.entries(licenses).find(([k, v]) => 
    v.tiktokUsername && v.tiktokUsername.toLowerCase() === tiktokUsername.toLowerCase()
  );
}

// ================================================================
//  ACTIVE CONNECTIONS (in-memory, one per user session)
// ================================================================
const activeConnections = new Map(); // sessionId → { tiktokConn, stats, messages, replyTimestamps }

function getSession(sessionId) {
  if (!activeConnections.has(sessionId)) {
    activeConnections.set(sessionId, {
      tiktokConn: null,
      isConnected: false,
      tiktokUsername: null,
      stats: { messages: 0, replies: 0, quickReplies: 0, aiReplies: 0, gifts: 0, likes: 0, followers: 0 },
      messages: [],
      replyTimestamps: [],
      config: null
    });
  }
  return activeConnections.get(sessionId);
}

// ================================================================
//  BOT LOGIC
// ================================================================
function fillTemplate(template, username = '', streamerInfo = {}) {
  return template
    .replace(/\{name\}/g, streamerInfo.name || '')
    .replace(/\{age\}/g, streamerInfo.age || '')
    .replace(/\{phone\}/g, streamerInfo.phone || '')
    .replace(/\{setup\}/g, streamerInfo.setup || '')
    .replace(/\{location\}/g, streamerInfo.location || '')
    .replace(/\{streamingFor\}/g, streamerInfo.streamingFor || '')
    .replace(/\{about\}/g, streamerInfo.about || '')
    .replace(/\{username\}/g, username);
}

function checkQuickReply(message, username, quickReplies, streamerInfo) {
  for (const qr of (quickReplies || [])) {
    for (const kw of qr.keywords) {
      // ✅ Whole-word match — "age" won't fire inside "rampage", "package", "erage" etc.
      // Escapes special regex chars in keyword, then wraps with \b word boundaries
      const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(message)) {
        return {
          reply: fillTemplate(qr.reply, username, streamerInfo),
          speechReply: qr.speechReply ? fillTemplate(qr.speechReply, username, streamerInfo) : null
        };
      }
    }
  }
  return null;
}

function canReply(session) {
  const now = Date.now();
  const cfg = session.config?.bot || {};
  const maxPerMin = cfg.maxRepliesPerMinute || 10;
  const cooldownMs = (cfg.replyCooldownSeconds || 3) * 1000;

  session.replyTimestamps = session.replyTimestamps.filter(t => t > now - 60000);
  if (session.replyTimestamps.length >= maxPerMin) return false;
  const last = session.replyTimestamps[session.replyTimestamps.length - 1];
  if (last && (now - last) < cooldownMs) return false;
  return true;
}

async function generateAIReply(message, username, streamerInfo, replyLanguage) {
  const info = streamerInfo || {};
  const prompt = `You are a friendly TikTok live stream chatbot for streamer ${info.name || 'the streamer'}.
Reply to viewer messages in a casual, warm, short way (1-2 sentences MAX).
Always use "I" as the streamer. Be energetic and use 1-2 emojis max.
Reply in ${replyLanguage || 'English'}.

Streamer facts:
- Name: ${info.name || 'unknown'}
- Age: ${info.age || 'unknown'}
- From: ${info.location || 'unknown'}
- Phone: ${info.phone || 'unknown'}
- Setup: ${info.setup || 'unknown'}
- Streaming for: ${info.streamingFor || 'unknown'}
- About: ${info.about || ''}

Keep replies under 150 characters.
Now reply to: @${username} says: "${message}"`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 100, temperature: 0.8 }
        })
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('AI error:', err.message);
    return null;
  }
}

function isQuestion(message) {
  const lower = message.toLowerCase();
  return ['?','what','which','how','who','where','when','why','can you','do you','are you','is your'].some(w => lower.includes(w));
}

// ── Reply to TikTok chat using bot account ────────────────────
// Uses the bot account's session cookie to post a comment
// Rate limited to protect the bot account from being flagged
const replyQueue = new Map(); // sessionId → queue of pending replies
const replyInProgress = new Set();

async function replyToTikTokChat(sessionId, message, replyText) {
  const session = activeConnections.get(sessionId);
  if (!session) return;

  const botCfg = session.config?.botAccount;
  const roomId = session?.roomId;

  if (!roomId) {
    console.log(`[${sessionId.slice(0,8)}] ⚠️ Bot reply skipped — no roomId`);
    return;
  }

  // ✅ Use bot account if configured, otherwise fall back to main account
  let replySessionId, replyTtTargetIdc, replyAccountName;
  if (botCfg?.enabled && botCfg?.sessionId) {
    replySessionId = botCfg.sessionId;
    replyTtTargetIdc = botCfg.ttTargetIdc || 'useast2a';
    replyAccountName = `@${botCfg.username || 'bot'}`;
  } else if (session.mainSessionId) {
    // Use main account session — streamer replies as themselves
    replySessionId = session.mainSessionId;
    replyTtTargetIdc = session.mainTtTargetIdc || 'useast2a';
    replyAccountName = `@${session.tiktokUsername} (main)`;
    console.log(`[${sessionId.slice(0,8)}] ℹ️ No bot account — using main account session`);
  } else {
    console.log(`[${sessionId.slice(0,8)}] ⚠️ Bot reply skipped — no session available`);
    return;
  }

  if (!replyQueue.has(sessionId)) replyQueue.set(sessionId, []);
  replyQueue.get(sessionId).push({ message, replyText, replySessionId, replyTtTargetIdc, replyAccountName });
  processReplyQueue(sessionId);
}

async function processReplyQueue(sessionId) {
  if (replyInProgress.has(sessionId)) return;
  const queue = replyQueue.get(sessionId);
  if (!queue?.length) return;

  replyInProgress.add(sessionId);
  const item = queue.shift();
  const { replyText, replySessionId, replyTtTargetIdc, replyAccountName } = item;

  try {
    const session = activeConnections.get(sessionId);
    const roomId = session?.roomId;
    if (!roomId) {
      console.log(`[${sessionId.slice(0,8)}] ⚠️ Reply skipped — no roomId`);
      return;
    }

    const cookieStr = `sessionid=${replySessionId}; tt-target-idc=${replyTtTargetIdc}`;
    console.log(`[${sessionId.slice(0,8)}] 🤖 ${replyAccountName} posting: "${replyText.substring(0, 50)}" room:${roomId}`);

    const res = await fetch('https://webcast.tiktok.com/webcast/room/chat/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://www.tiktok.com/@${session?.tiktokUsername}/live`,
        'Origin': 'https://www.tiktok.com',
        'Accept': 'application/json, text/plain, */*'
      },
      body: new URLSearchParams({
        room_id: roomId,
        content: replyText,
        type: '1',
        aid: '1988',
        app_name: 'tiktok_web',
        device_platform: 'web_pc'
      })
    });

    const rawText = await res.text();
    console.log(`[${sessionId.slice(0,8)}] 📡 TikTok ${res.status}: ${rawText.substring(0, 200)}`);

    let data = {};
    try { data = JSON.parse(rawText); } catch {}

    if (data.status_code === 0) {
      console.log(`[${sessionId.slice(0,8)}] ✅ Reply posted by ${replyAccountName}!`);
    } else {
      console.log(`[${sessionId.slice(0,8)}] ⚠️ status_code=${data.status_code} trying alternate...`);
      await tryAlternateCommentEndpoint(sessionId, roomId, replyText, cookieStr, session);
    }

  } catch (err) {
    console.error(`[${sessionId.slice(0,8)}] ❌ Reply error:`, err.message);
  } finally {
    replyInProgress.delete(sessionId);
    const session = activeConnections.get(sessionId);
    const delay = (session?.config?.botAccount?.replyDelay || 3) * 1000;
    setTimeout(() => processReplyQueue(sessionId), delay);
  }
}

// Alternate TikTok comment endpoint (older API)
async function tryAlternateCommentEndpoint(sessionId, roomId, replyText, cookieStr, session) {
  try {
    console.log(`[${sessionId.slice(0,8)}] 🔄 Trying alternate comment endpoint...`);
    const res = await fetch('https://www.tiktok.com/api/live/comment/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `https://www.tiktok.com/@${session?.tiktokUsername}/live`,
        'Origin': 'https://www.tiktok.com'
      },
      body: new URLSearchParams({
        room_id: roomId,
        content: replyText,
        type: '1',
        aid: '1988'
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.status_code === 0) {
      console.log(`[${sessionId.slice(0,8)}] ✅ Bot replied via alternate endpoint`);
    } else {
      console.log(`[${sessionId.slice(0,8)}] ⚠️ Alternate endpoint: ${data.status_code} — ${data.message || 'unknown'}`);
    }
  } catch (e) {
    console.error(`[${sessionId.slice(0,8)}] ❌ Alternate endpoint error:`, e.message);
  }
}

async function handleChatMessage(data, sessionId) {
  const session = activeConnections.get(sessionId);
  if (!session) return;

  const username = data.uniqueId || data.nickname || 'viewer';
  const message = data.comment || '';
  if (!message.trim()) return;

  session.stats.messages++;

  const cfg = session.config || {};
  const msgObj = {
    id: Date.now() + Math.random(),
    type: 'chat',
    username,
    message,
    timestamp: new Date().toLocaleTimeString(),
    reply: null,
    speechReply: null,
    replyType: null
  };

  const quickResult = checkQuickReply(message, username, cfg.quickReplies, cfg.streamerInfo);
  if (quickResult && canReply(session)) {
    msgObj.reply = quickResult.reply;
    msgObj.speechReply = quickResult.speechReply; // ✅ separate speech text
    msgObj.replyType = 'quick';
    session.stats.quickReplies++;
    session.stats.replies++;
    session.replyTimestamps.push(Date.now());
  } else if (!quickResult && canReply(session)) {
    const shouldReply = cfg.bot?.onlyReplyToQuestions ? isQuestion(message) : true;
    if (shouldReply) {
      const aiReply = await generateAIReply(message, username, cfg.streamerInfo, cfg.bot?.replyLanguage);
      if (aiReply) {
        msgObj.reply = aiReply;
        msgObj.speechReply = null; // AI replies use the reply text itself for speech
        msgObj.replyType = 'ai';
        session.stats.aiReplies++;
        session.stats.replies++;
        session.replyTimestamps.push(Date.now());
      }
    }
  }

  session.messages.unshift(msgObj);
  if (session.messages.length > 100) session.messages.pop();

  // ✅ Always read config fresh from disk — in-memory config can be stale
  // This ensures features and botAccount are always current
  const diskLicenses = readDB('licenses');
  const diskUsers = readDB('users');
  const diskUser = diskUsers[sessionId];
  const diskConfig = diskUser ? (diskLicenses[diskUser.licenseKey]?.config || {}) : {};

  // Merge disk config into session.config to keep it current
  if (diskConfig && Object.keys(diskConfig).length) {
    session.config = diskConfig;
  }

  const features = diskConfig.features || {};
  const botAccount = diskConfig.botAccount || {};

  // Only emit to overlay if overlay feature is enabled (default: true)
  if (features.overlayEnabled !== false) {
    io.to(sessionId).emit('chat', msgObj);
  }
  io.to(sessionId).emit('stats', session.stats);

  // ✅ Always emit tts event regardless of overlay toggle
  // Settings page listens for this to speak replies
  if (msgObj.reply && features.voiceEnabled) {
    io.to(sessionId).emit('tts', {
      reply: msgObj.reply,
      speechReply: msgObj.speechReply || null,
      replyType: msgObj.replyType,
      username: msgObj.username
    });
  }

  console.log(`[${sessionId.slice(0,8)}] 💬 @${username}: ${message}`);
  if (msgObj.reply) {
    console.log(`[${sessionId.slice(0,8)}]    🤖 (${msgObj.replyType}): ${msgObj.reply}`);
    console.log(`[${sessionId.slice(0,8)}] 🔍 chatReply=${features.chatReplyEnabled} bot.enabled=${botAccount.enabled} hasSession=${!!botAccount.sessionId} roomId=${session?.roomId}`);
    if (features.chatReplyEnabled === true && botAccount.enabled && botAccount.sessionId) {
      await replyToTikTokChat(sessionId, message, msgObj.reply);
    }
  }
}

async function connectToTikTok(sessionId, tiktokUsername, tiktokSessionId, ttTargetIdc) {
  const session = getSession(sessionId);

  if (session.tiktokConn) {
    try { session.tiktokConn.disconnect(); } catch {}
    session.tiktokConn = null;
  }

  // ✅ Store main account session for chat replies
  if (tiktokSessionId) {
    session.mainSessionId = tiktokSessionId;
    session.mainTtTargetIdc = ttTargetIdc || '';
  }

  console.log(`[${sessionId.slice(0,8)}] 🔗 Connecting to @${tiktokUsername}...`);

  // ── Attach all event listeners to a successful connection ──
  function attachListeners(conn) {
    conn.on('chat', data => {
      console.log(`[${sessionId.slice(0,8)}] 📨 Raw chat: ${data.uniqueId}: ${data.comment}`);
      handleChatMessage(data, sessionId);
    });
    conn.on('gift', data => {
      session.stats.gifts++;
      const event = { id: Date.now(), type: 'gift', username: data.uniqueId, giftName: data.giftName || 'a gift', timestamp: new Date().toLocaleTimeString() };
      session.messages.unshift(event);
      io.to(sessionId).emit('event', event);
      io.to(sessionId).emit('stats', session.stats);
    });
    conn.on('follow', data => {
      session.stats.followers++;
      const event = { id: Date.now(), type: 'follow', username: data.uniqueId, timestamp: new Date().toLocaleTimeString() };
      session.messages.unshift(event);
      io.to(sessionId).emit('event', event);
      io.to(sessionId).emit('stats', session.stats);
    });
    conn.on('like', data => {
      session.stats.likes += data.likeCount || 1;
      io.to(sessionId).emit('stats', session.stats);
    });
    conn.on('disconnected', () => {
      session.isConnected = false;
      io.to(sessionId).emit('status', { connected: false, error: 'Stream ended' });
    });
    conn.on('error', err => {
      session.isConnected = false;
      io.to(sessionId).emit('status', { connected: false, error: err.message });
    });
  }

  // ── Try one region, returns { success, conn } or throws ──
  async function tryRegion(sessionIdCookie, idc) {
    // ✅ CRITICAL FIX: constructor throws synchronously if tt-target-idc is
    // missing when sessionId is set — wrap it in try/catch to prevent server crash
    let conn;
    try {
      conn = new WebcastPushConnection(tiktokUsername, {
        sessionId: sessionIdCookie,
        'tt-target-idc': idc
      });
    } catch (constructErr) {
      throw new Error(`Constructor failed (${idc}): ${constructErr.message}`);
    }
    const state = await conn.connect(); // throws if not live
    return { conn, state };
  }

  // ── Build ordered list of regions to try ──
  async function tryConnect(sessionIdCookie, extIdc) {
    const IDC_REGIONS = ['alisg', 'useast2a', 'maliva', 'alisg2', 'sg', 'i18n'];
    const candidates = [];

    // 1. Extension-supplied idc first
    if (extIdc) candidates.push(extIdc);

    // 2. Auto-detect from TikTok API
    try {
      const idcRes = await fetch('https://www.tiktok.com/api/user/detail/?uniqueId=' + tiktokUsername, {
        headers: {
          'Cookie': `sessionid=${sessionIdCookie}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: AbortSignal.timeout(5000)
      });
      const setCookie = idcRes.headers.get('set-cookie') || '';
      const idcMatch = setCookie.match(/tt-target-idc=([^;]+)/);
      if (idcMatch?.[1] && !candidates.includes(idcMatch[1])) {
        candidates.unshift(idcMatch[1]);
        console.log(`[${sessionId.slice(0,8)}] 🌍 Auto-detected region: ${idcMatch[1]}`);
      }
    } catch {}

    // 3. All known regions as fallback
    for (const r of IDC_REGIONS) {
      if (!candidates.includes(r)) candidates.push(r);
    }

    // Try each candidate
    for (const idc of candidates) {
      console.log(`[${sessionId.slice(0,8)}] 🔄 Trying region: ${idc}`);
      try {
        const { conn, state } = await tryRegion(sessionIdCookie, idc);
        console.log(`[${sessionId.slice(0,8)}] ✅ Connected! Region: ${idc} Room: ${state.roomId}`);
        session.tiktokConn = conn;
        session.tiktokUsername = tiktokUsername;
        session.isConnected = true;
        session.roomId = state.roomId; // ✅ store for bot replies
        io.to(sessionId).emit('status', { connected: true, username: tiktokUsername, roomId: state.roomId });
        attachListeners(conn);
        return { success: true };
      } catch (err) {
        console.log(`[${sessionId.slice(0,8)}] ❌ Region ${idc} failed: ${err.message}`);
      }
    }

    // All regions with sessionId failed — try once without any sessionId (public streams)
    console.log(`[${sessionId.slice(0,8)}] 🔄 Trying without sessionId (public stream)...`);
    try {
      const conn = new WebcastPushConnection(tiktokUsername, {});
      const state = await conn.connect();
      console.log(`[${sessionId.slice(0,8)}] ✅ Connected (no session)! Room: ${state.roomId}`);
      session.tiktokConn = conn;
      session.tiktokUsername = tiktokUsername;
      session.isConnected = true;
      session.roomId = state.roomId; // ✅ store roomId for bot replies
      io.to(sessionId).emit('status', { connected: true, username: tiktokUsername, roomId: state.roomId });
      attachListeners(conn);
      return { success: true };
    } catch (err) {
      console.log(`[${sessionId.slice(0,8)}] ❌ No-session fallback failed: ${err.message}`);
    }

    const errMsg = 'Could not connect. Make sure you are LIVE on TikTok right now.';
    console.error(`[${sessionId.slice(0,8)}] ❌ All connection attempts failed`);
    io.to(sessionId).emit('status', { connected: false, error: errMsg });
    return { success: false, error: errMsg };
  }

  if (tiktokSessionId) {
    return tryConnect(tiktokSessionId, ttTargetIdc);
  } else {
    // No sessionId at all — try public connection directly
    console.log(`[${sessionId.slice(0,8)}] 🔄 No sessionId, trying public connection...`);
    try {
      const conn = new WebcastPushConnection(tiktokUsername, {});
      const state = await conn.connect();
      session.tiktokConn = conn;
      session.tiktokUsername = tiktokUsername;
      session.isConnected = true;
      session.roomId = state.roomId; // ✅ store roomId for bot replies
      io.to(sessionId).emit('status', { connected: true, username: tiktokUsername, roomId: state.roomId });
      attachListeners(conn);
      return { success: true };
    } catch (err) {
      session.isConnected = false;
      const errMsg = err.message || 'Connection failed. Make sure you are LIVE on TikTok.';
      io.to(sessionId).emit('status', { connected: false, error: errMsg });
      return { success: false, error: errMsg };
    }
  }
}

// ================================================================
//  EXTENSION API ROUTES
// ================================================================

// Check version for auto-update
app.get('/api/version', (req, res) => {
  res.json({ version: CURRENT_VERSION });
});

// Validate license key + get config
app.post('/api/validate', (req, res) => {
  const { licenseKey, tiktokUsername } = req.body;
  if (!licenseKey) return res.json({ success: false, error: 'License key required' });

  const check = isValidLicense(licenseKey);
  if (!check.valid) return res.json({ success: false, error: check.reason });

  const lic = check.license;

  // Bind key to TikTok username on first use
  if (!lic.tiktokUsername && tiktokUsername) {
    lic.tiktokUsername = tiktokUsername;
    licenses[licenseKey] = lic;
    writeDB('licenses', licenses);
  }

  // Enforce one TikTok per license
  if (lic.tiktokUsername && tiktokUsername && lic.tiktokUsername.toLowerCase() !== tiktokUsername.toLowerCase()) {
    return res.json({ success: false, error: `This key is registered to @${lic.tiktokUsername}` });
  }

  // Issue a session ID for this device
  const sessionId = uuidv4();
  users[sessionId] = { licenseKey, tiktokUsername: tiktokUsername || lic.tiktokUsername, connectedAt: new Date().toISOString() };
  writeDB('users', users);

  res.json({
    success: true,
    sessionId,
    config: lic.config || getDefaultConfig(lic),
    expiresAt: lic.expiresAt || null,
    plan: lic.plan || 'lifetime'
  });
});

// Connect to TikTok live
app.post('/api/connect', async (req, res) => {
  const { sessionId, tiktokUsername, tiktokSessionId, ttTargetIdc } = req.body;

  // Reload users from disk on every request (survives Railway restarts)
  users = readDB('users');
  licenses = readDB('licenses');

  // If session not found, try to recover by re-validating via TikTok username
  if (!sessionId) return res.json({ success: false, error: 'Session ID required' });

  if (!users[sessionId]) {
    // Session lost after server restart — find license by TikTok username
    const found = getLicenseByTikTok(tiktokUsername);
    if (!found) return res.json({ success: false, error: 'Session expired. Please re-activate your license in the extension.' });
    const [licKey, lic] = found;
    // Re-register the session
    users[sessionId] = { licenseKey: licKey, tiktokUsername, connectedAt: new Date().toISOString() };
    writeDB('users', users);
  }

  const session = getSession(sessionId);
  const lic = licenses[users[sessionId].licenseKey];
  session.config = lic?.config || getDefaultConfig(lic);

  // ✅ FIX: Await the TikTok connection so we return real success/failure
  const result = await connectToTikTok(sessionId, tiktokUsername, tiktokSessionId, ttTargetIdc);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: result.error });
  }
});

// Disconnect
app.post('/api/disconnect', (req, res) => {
  const { sessionId } = req.body;
  const session = activeConnections.get(sessionId);
  if (session?.tiktokConn) {
    try { session.tiktokConn.disconnect(); } catch {}
    session.isConnected = false;
  }
  res.json({ success: true });
});

// Get messages & stats
app.get('/api/messages/:sessionId', (req, res) => {
  const session = activeConnections.get(req.params.sessionId);
  res.json(session?.messages || []);
});

app.get('/api/stats/:sessionId', (req, res) => {
  const session = activeConnections.get(req.params.sessionId);
  res.json(session?.stats || {});
});

// Overlay page (per user)
app.get('/overlay/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// Test bot reply — call this from browser to see exactly what TikTok returns
app.post('/api/test-bot-reply', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.json({ error: 'sessionId required' });

  const session = activeConnections.get(sessionId);
  if (!session) return res.json({ error: 'No active session — click Start Bot first' });

  const botCfg = session?.config?.botAccount;
  const useMain = !botCfg?.sessionId;
  const replySessionId = botCfg?.sessionId || session?.mainSessionId;
  const replyTtTargetIdc = botCfg?.ttTargetIdc || session?.mainTtTargetIdc || 'useast2a';

  if (!replySessionId) return res.json({ error: 'No session available — connect bot or restart main account' });
  if (!roomId) return res.json({ error: 'No roomId — are you live?', sessionKeys: Object.keys(session) });

  const testText = message || 'StreamBuddy bot is connected! 🤖';
  const cookieStr = `sessionid=${replySessionId}; tt-target-idc=${replyTtTargetIdc}`;

  try {
    const r = await fetch('https://webcast.tiktok.com/webcast/room/chat/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://www.tiktok.com/@${session?.tiktokUsername}/live`,
        'Origin': 'https://www.tiktok.com',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        room_id: roomId,
        content: testText,
        type: '1',
        aid: '1988',
        app_name: 'tiktok_web',
        device_platform: 'web_pc'
      })
    });
    const raw = await r.text();
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}
    res.json({
      httpStatus: r.status,
      tiktokStatus: parsed.status_code,
      message: parsed.message || parsed.status_msg || raw.substring(0, 300),
      roomId,
      usingAccount: useMain ? `main (@${session?.tiktokUsername})` : `bot (@${botCfg?.username})`,
      hasTtTargetIdc: !!replyTtTargetIdc
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// View raw keywords for a session (for recovery)
app.get('/api/keywords/:sessionId', (req, res) => {
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[req.params.sessionId];
  if (!user) return res.json({ error: 'Session not found' });
  const lic = licenses[user.licenseKey];
  res.json({ quickReplies: lic?.config?.quickReplies || [] });
});

// Restore keywords without touching other settings
app.post('/api/keywords', (req, res) => {
  const { sessionId, quickReplies } = req.body;
  if (!sessionId || !Array.isArray(quickReplies)) return res.json({ success: false });
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[sessionId];
  if (!user) return res.json({ success: false });
  const licKey = user.licenseKey;
  if (!licenses[licKey]) return res.json({ success: false });
  if (!licenses[licKey].config) licenses[licKey].config = {};
  licenses[licKey].config.quickReplies = quickReplies;
  writeDB('licenses', licenses);
  const session = activeConnections.get(sessionId);
  if (session?.config) session.config.quickReplies = quickReplies;
  console.log(`[${sessionId.slice(0,8)}] 📝 Keywords restored: ${quickReplies.length} entries`);
  res.json({ success: true, count: quickReplies.length });
});

// Win/Loss config for overlay styling
app.get('/api/wl-config/:sessionId', (req, res) => {
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[req.params.sessionId];
  if (!user) return res.json({});
  const lic = licenses[user.licenseKey];
  res.json(lic?.config?.wl || {});
});

// Win/Loss stats — update from extension popup
app.post('/api/wl-stats', (req, res) => {
  const { sessionId, wins, losses, games } = req.body;
  if (!sessionId) return res.json({ success: false });
  const statsData = { games: games || 0, wins: wins || 0, losses: losses || 0 };
  const session = activeConnections.get(sessionId);
  if (!session) {
    if (!global.wlStats) global.wlStats = {};
    global.wlStats[sessionId] = statsData;
  } else {
    session.wlStats = statsData;
  }
  io.to(sessionId).emit('wl-update', statsData);
  res.json({ success: true });
});

// Win/Loss overlay page
app.get('/wl-overlay/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wl-overlay.html'));
});

// Get current WL stats (for overlay on load)
app.get('/api/wl-stats/:sessionId', (req, res) => {
  const session = activeConnections.get(req.params.sessionId);
  if (session?.wlStats) return res.json(session.wlStats);
  const stored = global.wlStats?.[req.params.sessionId];
  res.json(stored || { wins: 0, losses: 0 });
});

// Get user settings — called by settings page on load
app.get('/api/settings/:sessionId', (req, res) => {
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[req.params.sessionId];
  if (!user) return res.json({});
  const lic = licenses[user.licenseKey];
  const config = lic?.config || {};
  res.json({
    streamerInfo: config.streamerInfo || {},
    quickReplies: config.quickReplies || [],
    bot: config.bot || {},
    overlayConfig: config.overlayConfig || {},
    features: config.features || { overlayEnabled: true, chatReplyEnabled: false, voiceEnabled: false },
    wl: config.wl || {}
  });
});

// Update only feature flags — doesn't touch other config
app.post('/api/features', (req, res) => {
  const { sessionId, features } = req.body;
  if (!sessionId || !features) return res.json({ success: false });
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[sessionId];
  if (!user) return res.json({ success: false });
  const licKey = user.licenseKey;
  if (!licenses[licKey]) return res.json({ success: false });
  if (!licenses[licKey].config) licenses[licKey].config = {};
  licenses[licKey].config.features = features;
  writeDB('licenses', licenses);
  // Update active session immediately
  const session = activeConnections.get(sessionId);
  if (session) {
    if (!session.config) session.config = {};
    session.config.features = features;
    console.log(`[${sessionId.slice(0,8)}] 🔧 Features: overlay=${features.overlayEnabled} chatReply=${features.chatReplyEnabled} voice=${features.voiceEnabled}`);
  }
  res.json({ success: true });
});

// Save user settings (keywords, streamer info, overlay config)
app.post('/api/settings', (req, res) => {
  const { sessionId, streamerInfo, quickReplies, bot, overlayConfig, features, wl } = req.body;
  users = readDB('users');
  licenses = readDB('licenses');
  if (!sessionId || !users[sessionId]) return res.json({ success: false, error: 'Invalid session' });

  const licKey = users[sessionId].licenseKey;
  if (!licenses[licKey]) return res.json({ success: false, error: 'License not found' });

  const existingConfig = licenses[licKey].config || {};
  const existingBotAccount = existingConfig.botAccount || {};

  // ✅ CRITICAL: Never overwrite quickReplies with empty array
  // If client sends [] but server has data, keep server data
  // Only update if client sends actual keywords
  const existingKeywords = existingConfig.quickReplies || [];
  const incomingKeywords = quickReplies || [];
  const finalKeywords = incomingKeywords.length > 0 ? incomingKeywords : existingKeywords;

  licenses[licKey].config = {
    streamerInfo: streamerInfo || existingConfig.streamerInfo || {},
    quickReplies: finalKeywords,
    bot: bot || existingConfig.bot || {},
    overlayConfig: overlayConfig || existingConfig.overlayConfig || {},
    features: features || existingConfig.features || { overlayEnabled: true, chatReplyEnabled: false, voiceEnabled: false },
    wl: wl || existingConfig.wl || {},
    botAccount: existingBotAccount
  };
  writeDB('licenses', licenses);

  const session = activeConnections.get(sessionId);
  if (session) session.config = licenses[licKey].config;

  // Push wl config to overlay immediately via socket
  if (wl) io.to(sessionId).emit('wl-config', wl);

  res.json({ success: true });
});

// Test reply — called from settings page test mode
app.post('/api/test-reply', async (req, res) => {
  const { sessionId, message, username } = req.body;
  if (!sessionId) return res.json({ reply: null });

  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[sessionId];
  if (!user) return res.json({ reply: null });

  const lic = licenses[user.licenseKey];
  const config = lic?.config || {};

  // Check keyword match — whole-word only to avoid "age" matching "rampage"
  const kwMatch = (config.quickReplies || []).find(kw =>
    kw.keywords.some(k => {
      const escaped = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(message);
    })
  );

  let reply, speechReply, replyType;
  if (kwMatch) {
    reply = fillTemplate(kwMatch.reply, username || 'TestViewer', config.streamerInfo || {});
    speechReply = kwMatch.speechReply ? fillTemplate(kwMatch.speechReply, username || 'TestViewer', config.streamerInfo || {}) : null;
    replyType = 'quick';
  } else {
    reply = await generateAIReply(message, username || 'TestViewer', config);
    speechReply = null;
    replyType = 'ai';
  }

  if (reply) {
    // ✅ Emit to the overlay via Socket.IO so it shows in OBS/TikTok Studio
    io.to(sessionId).emit('test-chat', {
      username: username || 'TestViewer',
      message,
      reply,
      speechReply,
      replyType
    });
  }

  res.json({ reply: reply || null, speechReply, replyType });
});

// ================================================================
//  ELEVENLABS TTS — API key never leaves the server
// ================================================================

// Get available ElevenLabs voices (cached 10 min)
let elVoicesCache = null;
let elVoicesCacheTime = 0;

app.get('/api/tts/voices', async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.json({ available: false, error: 'ElevenLabs API key not set in Railway Variables' });
  }
  // Return cache if fresh
  if (elVoicesCache && Date.now() - elVoicesCacheTime < 600000) {
    return res.json({ available: true, voices: elVoicesCache });
  }
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY.trim(), // ✅ trim whitespace from key
        'Content-Type': 'application/json'
      }
    });
    if (!r.ok) {
      elVoicesCache = null; // ✅ clear cache on auth failure
      throw new Error(`ElevenLabs returned ${r.status}`);
    }
    const data = await r.json();
    elVoicesCache = data.voices.map(v => ({
      id: v.voice_id,
      name: v.name,
      category: v.category || 'premade',
      preview_url: v.preview_url || null
    }));
    elVoicesCacheTime = Date.now();
    res.json({ available: true, voices: elVoicesCache });
  } catch (err) {
    console.error('ElevenLabs voices error:', err.message);
    res.json({ available: false, error: err.message });
  }
});

// Text-to-speech via ElevenLabs — returns audio as mp3
app.post('/api/tts/speak', async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured on server' });
  }

  const { text, voiceId, stability, similarityBoost, sessionId } = req.body;
  if (!text || !voiceId) return res.status(400).json({ error: 'text and voiceId required' });

  // Verify the session exists
  if (sessionId) {
    users = readDB('users');
    if (!users[sessionId]) return res.status(401).json({ error: 'Invalid session' });
  }

  // Strip emojis server-side
  const clean = text
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return res.status(400).json({ error: 'No speakable text after cleaning' });

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY.trim(), // ✅ trim whitespace
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: clean,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: stability ?? 0.5,
          similarity_boost: similarityBoost ?? 0.75,
          style: 0.3,
          use_speaker_boost: true
        }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('ElevenLabs TTS error:', r.status, errText);
      return res.status(r.status).json({ error: `ElevenLabs error: ${r.status}` });
    }

    // ✅ FIX: node-fetch v3 uses Web Streams — must use arrayBuffer, NOT .pipe()
    // .pipe() is a Node.js stream method and doesn't exist on Web ReadableStream
    // Using .pipe() caused the server to crash with an unhandled exception
    const audioBuffer = await r.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Length', audioBuffer.byteLength);
    res.send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error('ElevenLabs TTS fetch error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  GOOGLE CLOUD TTS — Service account JSON stored in Railway var
// ================================================================

// Google OAuth2 token cache
let googleTokenCache = null;
let googleTokenExpiry = 0;

async function getGoogleAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (googleTokenCache && Date.now() < googleTokenExpiry - 60000) {
    return googleTokenCache;
  }

  if (!GOOGLE_TTS_KEY) throw new Error('GOOGLE_TTS_KEY not set in Railway Variables');

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(GOOGLE_TTS_KEY);
  } catch {
    throw new Error('GOOGLE_TTS_KEY is not valid JSON — paste the full service account file');
  }

  // Build JWT for Google OAuth2
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  // Encode JWT parts
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;

  // Sign with RSA private key using Node.js crypto
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Google auth failed: ${err}`);
  }

  const tokenData = await tokenRes.json();
  googleTokenCache = tokenData.access_token;
  googleTokenExpiry = Date.now() + (tokenData.expires_in * 1000);
  return googleTokenCache;
}

// Get Google TTS voices list
let googleVoicesCache = null;
let googleVoicesCacheTime = 0;

app.get('/api/tts/google-voices', async (req, res) => {
  if (!GOOGLE_TTS_KEY) {
    return res.json({ available: false, error: 'GOOGLE_TTS_KEY not set in Railway Variables' });
  }
  if (googleVoicesCache && Date.now() - googleVoicesCacheTime < 3600000) {
    return res.json({ available: true, voices: googleVoicesCache });
  }
  try {
    const token = await getGoogleAccessToken();
    const r = await fetch('https://texttospeech.googleapis.com/v1/voices', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Google TTS returned ${r.status}`);
    const data = await r.json();

    // Filter to only high-quality voices — Neural2, WaveNet, Studio, Chirp
    const quality = ['Neural2', 'WaveNet', 'Studio', 'Chirp', 'Journey'];
    googleVoicesCache = data.voices
      .filter(v => quality.some(q => v.name.includes(q)))
      .map(v => ({
        name: v.name,
        languageCodes: v.languageCodes,
        gender: v.ssmlGender,
        type: quality.find(q => v.name.includes(q)) || 'Standard',
        naturalSampleRateHertz: v.naturalSampleRateHertz
      }))
      .sort((a, b) => {
        // Sort: Neural2 first, then WaveNet, then others
        const order = ['Neural2', 'Studio', 'Journey', 'Chirp', 'WaveNet'];
        return order.indexOf(a.type) - order.indexOf(b.type);
      });

    googleVoicesCacheTime = Date.now();
    res.json({ available: true, voices: googleVoicesCache });
  } catch (err) {
    console.error('Google TTS voices error:', err.message);
    res.json({ available: false, error: err.message });
  }
});

// Google TTS synthesize
app.post('/api/tts/google-speak', async (req, res) => {
  if (!GOOGLE_TTS_KEY) {
    return res.status(503).json({ error: 'GOOGLE_TTS_KEY not configured on server' });
  }

  const { text, voiceName, languageCode, speakingRate, pitch, sessionId } = req.body;
  if (!text || !voiceName) return res.status(400).json({ error: 'text and voiceName required' });

  if (sessionId) {
    users = readDB('users');
    if (!users[sessionId]) return res.status(401).json({ error: 'Invalid session' });
  }

  const clean = text
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/\s+/g, ' ').trim();

  if (!clean) return res.status(400).json({ error: 'No speakable text' });

  try {
    const token = await getGoogleAccessToken();
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: { text: clean },
        voice: {
          languageCode: languageCode || voiceName.split('-').slice(0, 2).join('-'),
          name: voiceName
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: speakingRate ?? 1.0,
          pitch: pitch ?? 0,
          effectsProfileId: ['headphone-class-device']
        }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Google TTS error:', r.status, errText);
      return res.status(r.status).json({ error: `Google TTS error: ${r.status}` });
    }

    const data = await r.json();
    // Google returns base64-encoded MP3
    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Length', audioBuffer.byteLength);
    res.send(audioBuffer);

  } catch (err) {
    console.error('Google TTS fetch error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Save bot account credentials for a session
app.post('/api/bot-account', (req, res) => {
  const { sessionId, botUsername, botSessionId, botTtTargetIdc, enabled, replyDelay } = req.body;
  if (!sessionId) return res.json({ success: false, error: 'Session required' });

  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[sessionId];
  if (!user) return res.json({ success: false, error: 'Invalid session' });

  // Store bot account config in the license config
  const lic = licenses[user.licenseKey];
  if (!lic) return res.json({ success: false, error: 'License not found' });
  if (!lic.config) lic.config = {};
  lic.config.botAccount = {
    enabled: enabled !== false,
    username: botUsername || '',
    sessionId: botSessionId || '',
    ttTargetIdc: botTtTargetIdc || '',
    replyDelay: replyDelay || 3
  };
  licenses[user.licenseKey] = lic;
  writeDB('licenses', licenses);

  // Also update active session config if connected
  const session = activeConnections.get(sessionId);
  if (session) {
    // ✅ session.config may be null if bot saved before Start Bot clicked
    if (!session.config) session.config = {};
    session.config.botAccount = lic.config.botAccount;
  }

  console.log(`[${sessionId.slice(0,8)}] 🤖 Bot account updated: @${botUsername} (enabled: ${enabled})`);
  res.json({ success: true });
});

// Get bot account status
app.get('/api/bot-account/:sessionId', (req, res) => {
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[req.params.sessionId];
  if (!user) return res.json({ enabled: false });
  const lic = licenses[user.licenseKey];
  const botCfg = lic?.config?.botAccount || {};
  // Never send the session cookie back to client
  res.json({
    enabled: botCfg.enabled || false,
    username: botCfg.username || '',
    hasSession: !!botCfg.sessionId,
    replyDelay: botCfg.replyDelay || 3
  });
});

// Get overlay config for a session (used by overlay.html)
app.get('/api/overlay-config/:sessionId', (req, res) => {
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[req.params.sessionId];
  if (!user) return res.json({});
  const lic = licenses[user.licenseKey];
  // ✅ Return full overlayConfig including template, typewriter, messenger
  res.json(lic?.config?.overlayConfig || {});
});

// ================================================================
//  ADMIN API ROUTES (password protected)
// ================================================================
function adminAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Get all licenses
app.get('/admin/licenses', adminAuth, (req, res) => {
  res.json(licenses);
});

// Create a new license key
app.post('/admin/licenses', adminAuth, (req, res) => {
  const { plan = 'monthly', email = '', daysValid = 30, note = '' } = req.body;
  const key = generateLicenseKey();
  const expiresAt = plan === 'lifetime' ? null : new Date(Date.now() + daysValid * 86400000).toISOString();

  licenses[key] = {
    key,
    plan,
    email,
    note,
    active: true,
    createdAt: new Date().toISOString(),
    expiresAt,
    tiktokUsername: null,
    config: null
  };
  writeDB('licenses', licenses);
  res.json({ success: true, key, expiresAt });
});

// Revoke a license
app.post('/admin/licenses/:key/revoke', adminAuth, (req, res) => {
  if (!licenses[req.params.key]) return res.json({ success: false, error: 'Key not found' });
  licenses[req.params.key].active = false;
  writeDB('licenses', licenses);
  res.json({ success: true });
});

// Reactivate a license
app.post('/admin/licenses/:key/activate', adminAuth, (req, res) => {
  if (!licenses[req.params.key]) return res.json({ success: false, error: 'Key not found' });
  licenses[req.params.key].active = true;
  writeDB('licenses', licenses);
  res.json({ success: true });
});

// Extend expiry
app.post('/admin/licenses/:key/extend', adminAuth, (req, res) => {
  const { days = 30 } = req.body;
  const lic = licenses[req.params.key];
  if (!lic) return res.json({ success: false, error: 'Key not found' });
  const base = lic.expiresAt && new Date(lic.expiresAt) > new Date() ? new Date(lic.expiresAt) : new Date();
  lic.expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  writeDB('licenses', licenses);
  res.json({ success: true, expiresAt: lic.expiresAt });
});

// Stats overview
app.get('/admin/stats', adminAuth, (req, res) => {
  const total = Object.keys(licenses).length;
  const active = Object.values(licenses).filter(l => l.active).length;
  const expired = Object.values(licenses).filter(l => l.expiresAt && new Date() > new Date(l.expiresAt)).length;
  const online = activeConnections.size;
  res.json({ total, active, expired, online });
});

// Admin dashboard page — served without auth (login is handled client-side)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ================================================================
//  SOCKET.IO
// ================================================================
io.on('connection', (socket) => {
  socket.on('join', (sessionId) => {
    socket.join(sessionId);
    const session = activeConnections.get(sessionId);
    if (session) {
      socket.emit('init', { messages: session.messages, stats: session.stats, isConnected: session.isConnected });
    }
  });
});

// ================================================================
//  HELPERS
// ================================================================
function getDefaultConfig(lic) {
  return {
    streamerInfo: {
      name: lic?.email?.split('@')[0] || 'Streamer',
      age: '',
      location: '',
      phone: '',
      setup: '',
      streamingFor: '',
      about: ''
    },
    bot: {
      onlyReplyToQuestions: false,
      replyCooldownSeconds: 3,
      maxRepliesPerMinute: 10,
      replyLanguage: 'English'
    },
    quickReplies: [
      { keywords: ['hi', 'hello', 'hey', 'hola', 'salam'], reply: 'Hey {username}! Welcome to the stream! 👋🔥' },
      { keywords: ['from', 'country', 'location', 'where'], reply: "I'm from {location}! 🌍" },
      { keywords: ['age', 'old', 'born'], reply: "I'm {age} years old! 🎂" },
      { keywords: ['phone', 'iphone', 'android'], reply: 'I use {phone} for streaming! 📱' },
      { keywords: ['setup', 'equipment', 'gear', 'pc'], reply: 'My setup: {setup} 🎙️' },
      { keywords: ['name', 'who are you'], reply: 'My name is {name}! Nice to meet you 👋' }
    ]
  };
}

// ================================================================
//  START
// ================================================================
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   NUMB Chatbot Server — Running on port ${PORT}    ║
╠══════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}               ║
║  Admin:      http://localhost:${PORT}/admin?pwd=... ║
║  Version:    ${CURRENT_VERSION}                             ║
╚══════════════════════════════════════════════════╝
  `);
});

// ================================================================
//  GLOBAL CRASH GUARDS — keeps Railway alive on unexpected errors
// ================================================================
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception (server kept alive):', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled Promise Rejection (server kept alive):', reason);
});
