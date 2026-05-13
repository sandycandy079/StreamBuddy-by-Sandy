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
const CURRENT_VERSION = '1.0.0';            // bump this when you update
const PORT = process.env.PORT || 3000;

// ================================================================
//  DATABASE (flat JSON files — no external DB needed!)
// ================================================================
const DB_PATH = path.join(__dirname, 'db');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

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
        return fillTemplate(qr.reply, username, streamerInfo);
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
    replyType: null
  };

  const quickReply = checkQuickReply(message, username, cfg.quickReplies, cfg.streamerInfo);
  if (quickReply && canReply(session)) {
    msgObj.reply = quickReply;
    msgObj.replyType = 'quick';
    session.stats.quickReplies++;
    session.stats.replies++;
    session.replyTimestamps.push(Date.now());
  } else if (!quickReply && canReply(session)) {
    const shouldReply = cfg.bot?.onlyReplyToQuestions ? isQuestion(message) : true;
    if (shouldReply) {
      const aiReply = await generateAIReply(message, username, cfg.streamerInfo, cfg.bot?.replyLanguage);
      if (aiReply) {
        msgObj.reply = aiReply;
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
  }

  console.log(`[${sessionId.slice(0,8)}] 🔗 Connecting to @${tiktokUsername}...`);

  // All known TikTok datacenters — tried in order until one works
  const IDC_REGIONS = ['alisg', 'useast2a', 'maliva', 'alisg2', 'sg'];

  async function tryConnect(regions, sessionIdCookie, extIdc) {
    // Build candidate list: extension cookie first, then all known regions
    const candidates = [];
    if (extIdc) candidates.push(extIdc);
    for (const r of regions) {
      if (r !== extIdc) candidates.push(r);
    }

    // Also try to auto-detect from TikTok API
    try {
      const idcRes = await fetch('https://www.tiktok.com/api/user/detail/?uniqueId=' + tiktokUsername, {
        headers: {
          'Cookie': `sessionid=${sessionIdCookie}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const setCookie = idcRes.headers.get('set-cookie') || '';
      const idcMatch = setCookie.match(/tt-target-idc=([^;]+)/);
      if (idcMatch && !candidates.includes(idcMatch[1])) {
        candidates.unshift(idcMatch[1]); // put detected region first
        console.log(`[${sessionId.slice(0,8)}] 🌍 Auto-detected region: ${idcMatch[1]}`);
      }
    } catch {}

    for (const idc of candidates) {
      console.log(`[${sessionId.slice(0,8)}] 🔄 Trying region: ${idc}`);
      const opts = { sessionId: sessionIdCookie, 'tt-target-idc': idc };
      const conn = new WebcastPushConnection(tiktokUsername, opts);
      try {
        const state = await conn.connect();
        // Success!
        console.log(`[${sessionId.slice(0,8)}] ✅ Connected with region ${idc}! Room: ${state.roomId}`);
        session.tiktokConn = conn;
        session.tiktokUsername = tiktokUsername;
        session.isConnected = true;
        io.to(sessionId).emit('status', { connected: true, username: tiktokUsername, roomId: state.roomId });

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
          io.to(sessionId).emit('status', { connected: false, error: 'Stream disconnected' });
        });
        conn.on('error', err => {
          io.to(sessionId).emit('status', { connected: false, error: err.message });
        });
        return; // done!
      } catch (err) {
        console.log(`[${sessionId.slice(0,8)}] ❌ Region ${idc} failed: ${err.message}`);
        try { conn.disconnect(); } catch {}
        // continue to next region
      }
    }
    // All regions failed
    console.error(`[${sessionId.slice(0,8)}] ❌ All regions failed`);
    io.to(sessionId).emit('status', { connected: false, error: 'Could not connect. Make sure you are LIVE on TikTok.' });
  }

  if (tiktokSessionId) {
    tryConnect(IDC_REGIONS, tiktokSessionId, ttTargetIdc);
  } else {
    // No sessionId — try without it
    const conn = new WebcastPushConnection(tiktokUsername, {});
    session.tiktokConn = conn;
    session.tiktokUsername = tiktokUsername;
    conn.connect()
      .then(state => {
        session.isConnected = true;
        io.to(sessionId).emit('status', { connected: true, username: tiktokUsername, roomId: state.roomId });
      })
      .catch(err => {
        session.isConnected = false;
        io.to(sessionId).emit('status', { connected: false, error: err.message });
      });

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
app.post('/api/connect', (req, res) => {
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

  connectToTikTok(sessionId, tiktokUsername, tiktokSessionId, ttTargetIdc);
  res.json({ success: true });
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

// Get overlay config for a session (used by overlay.html)
app.get('/api/overlay-config/:sessionId', (req, res) => {
  users = readDB('users');
  licenses = readDB('licenses');
  const user = users[req.params.sessionId];
  if (!user) return res.json({});
  const lic = licenses[user.licenseKey];
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

// Admin dashboard page
app.get('/admin', adminAuth, (req, res) => {
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
