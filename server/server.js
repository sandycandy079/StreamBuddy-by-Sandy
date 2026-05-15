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
  const lower = message.toLowerCase();
  for (const qr of (quickReplies || [])) {
    for (const kw of qr.keywords) {
      if (lower.includes(kw.toLowerCase())) {
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

  io.to(sessionId).emit('chat', msgObj);
  io.to(sessionId).emit('stats', session.stats);

  console.log(`[${sessionId.slice(0,8)}] 💬 @${username}: ${message}`);
  if (msgObj.reply) console.log(`[${sessionId.slice(0,8)}]    🤖 (${msgObj.replyType}): ${msgObj.reply}`);
}

async function connectToTikTok(sessionId, tiktokUsername, tiktokSessionId, ttTargetIdc) {
  const session = getSession(sessionId);

  if (session.tiktokConn) {
    try { session.tiktokConn.disconnect(); } catch {}
    session.tiktokConn = null;
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

// Save user settings (keywords, streamer info, overlay config)
app.post('/api/settings', (req, res) => {
  const { sessionId, streamerInfo, quickReplies, bot, overlayConfig } = req.body;
  users = readDB('users');
  licenses = readDB('licenses');
  if (!sessionId || !users[sessionId]) return res.json({ success: false, error: 'Invalid session' });

  const licKey = users[sessionId].licenseKey;
  if (!licenses[licKey]) return res.json({ success: false, error: 'License not found' });

  // Save to license config
  licenses[licKey].config = {
    streamerInfo: streamerInfo || {},
    quickReplies: quickReplies || [],
    bot: bot || {},
    overlayConfig: overlayConfig || {}
  };
  writeDB('licenses', licenses);

  // Update active session config
  const session = activeConnections.get(sessionId);
  if (session) session.config = licenses[licKey].config;

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

  // Check keyword match
  const lower = message.toLowerCase();
  const kwMatch = (config.quickReplies || []).find(kw =>
    kw.keywords.some(k => lower.includes(k.toLowerCase()))
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
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });
    if (!r.ok) throw new Error(`ElevenLabs returned ${r.status}`);
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

// Text-to-speech via ElevenLabs — streams audio back as mp3
app.post('/api/tts/speak', async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured on server' });
  }

  const { text, voiceId, stability, similarityBoost, sessionId } = req.body;
  if (!text || !voiceId) return res.status(400).json({ error: 'text and voiceId required' });

  // Verify the session exists (basic auth — only your users can use TTS)
  if (sessionId) {
    users = readDB('users');
    if (!users[sessionId]) return res.status(401).json({ error: 'Invalid session' });
  }

  // Strip emojis server-side too
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
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: clean,
        model_id: 'eleven_turbo_v2_5', // fastest + cheapest, still very natural
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

    // Stream the audio directly back to the client
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    r.body.pipe(res);

  } catch (err) {
    console.error('ElevenLabs TTS fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
