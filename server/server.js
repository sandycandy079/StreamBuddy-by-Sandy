// ================================================================
//  StreamBuddy By Sandy — Settings Script (v2)
// ================================================================

const SERVER_URL = 'https://streambuddy-by-sandy-production.up.railway.app';

let settings = {
  keywords: [],
  bot: { onlyReplyToQuestions: false, replyLanguage: 'English', replyCooldownSeconds: 3, maxRepliesPerMinute: 10 },
  streamerInfo: { name: '', age: '', location: '', phone: '', setup: '', streamingFor: '', about: '' },
  overlay: { layout: 'bottom-left', accentColor: '#fe2c55', bgOpacity: 0.82, blurStrength: 12, borderRadius: 16, cardWidth: 580, orientation: 'vertical', template: 'tiktok' },
  fonts: { fontFamily: "'Segoe UI', Arial, sans-serif", fontSize: 22, fontWeight: 700, textColor: '#ffffff', letterSpacing: -0.2, lineHeight: 1.4, questionFontSize: 13 },
  animation: { type: 'slide-up', displayDuration: 7, animSpeed: 0.5, showProgress: true, showGlow: true, showBlur: true, showBadgeDot: true },
  typewriter: { color: '#ffffff', fontSize: 32, glow: 12, speed: 50, showCursor: true, showQuestion: true },
  messenger: { bubbleColor: '#0b84ff', fontSize: 20, bgOpacity: 0.85, readReceipts: true, showTimestamp: true },
  tts: { enabled: false, engine: 'browser', voice: '', rate: 1, pitch: 1, volume: 1, speakAI: true, sayName: false,
         elVoiceId: '', elStability: 0.5, elSimilarity: 0.75, elVolume: 1,
         googleVoice: '', googleVoiceType: 'Neural2', googleRate: 1, googlePitch: 0, googleVolume: 1 },
  features: { overlayEnabled: true, chatReplyEnabled: false, voiceEnabled: false },
  wl: { template: 'neon', winLabel: 'WINS', lossLabel: 'LOSSES', title: '🎮 Stats', separator: '—',
        winColor: '#00e676', lossColor: '#fe2c55', bgOpacity: 0.8,
        font: "'Segoe UI', sans-serif", numSize: 48, labelSize: 11, radius: 16,
        position: 'top-right' }
};

let editingKeywordIndex = -1;
let currentPreviewOrient = 'vertical';

let serverDataLoaded = false; // ✅ prevents saving empty keywords before server loads

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

  // Load from local cache first
  const stored = await chrome.storage.local.get(['overlaySettings', 'serverConfig', 'sessionId']);
  if (stored.overlaySettings) settings = deepMerge(settings, stored.overlaySettings);
  if (stored.serverConfig) {
    if (stored.serverConfig.quickReplies) settings.keywords = stored.serverConfig.quickReplies;
    if (stored.serverConfig.streamerInfo) settings.streamerInfo = { ...settings.streamerInfo, ...stored.serverConfig.streamerInfo };
    if (stored.serverConfig.bot) settings.bot = { ...settings.bot, ...stored.serverConfig.bot };
  }

  // Fetch latest from server (source of truth)
  if (stored.sessionId) {
    try {
      const res = await fetch(`${SERVER_URL}/api/settings/${stored.sessionId}`);
      if (res.ok) {
        const d = await res.json();
        if (d.quickReplies) settings.keywords = d.quickReplies;
        if (d.streamerInfo) settings.streamerInfo = { ...settings.streamerInfo, ...d.streamerInfo };
        if (d.bot) settings.bot = { ...settings.bot, ...d.bot };
        // ✅ Load features from server (chatReplyEnabled, overlayEnabled etc)
        if (d.features) settings.features = { ...settings.features, ...d.features };
        if (d.wl) settings.wl = { ...settings.wl, ...d.wl };
        if (d.overlayConfig) {
          if (d.overlayConfig.overlay) settings.overlay = { ...settings.overlay, ...d.overlayConfig.overlay };
          if (d.overlayConfig.fonts) settings.fonts = { ...settings.fonts, ...d.overlayConfig.fonts };
          if (d.overlayConfig.animation) settings.animation = { ...settings.animation, ...d.overlayConfig.animation };
          if (d.overlayConfig.typewriter) settings.typewriter = { ...settings.typewriter, ...d.overlayConfig.typewriter };
          if (d.overlayConfig.messenger) settings.messenger = { ...settings.messenger, ...d.overlayConfig.messenger };
          if (d.overlayConfig.tts) settings.tts = { ...settings.tts, ...d.overlayConfig.tts };
        }
        await chrome.storage.local.set({ overlaySettings: settings });
        serverDataLoaded = true; // ✅ safe to save now
      }
    } catch {
      serverDataLoaded = true; // allow save even if server unreachable
    }

    // ✅ Start socket connection for live TTS as soon as session is known
    initSettingsSocket(stored.sessionId);
  } else {
    serverDataLoaded = true; // no session — safe to save immediately
  }

  // ── Wire tabs ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.getElementById('backBtn').addEventListener('click', () => window.close());
  document.getElementById('saveBtn').addEventListener('click', saveAll);
  document.getElementById('addKeywordBtn').addEventListener('click', () => openKwModal(-1));
  document.getElementById('kwCancel').addEventListener('click', closeKwModal);
  document.getElementById('kwSave').addEventListener('click', saveKeyword);

  // ── Win/Loss tab ──
  document.querySelectorAll('.wl-tpl-card').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('.wl-tpl-card').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      settings.wl.template = c.dataset.wltpl;
      updateWLPreview();
    });
  });
  document.querySelectorAll('.wl-pos-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.wl-pos-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      settings.wl.position = b.dataset.wlpos;
      updateWLPreview();
    });
  });
  document.querySelectorAll('[data-wlwincolor]').forEach(s => {
    s.addEventListener('click', () => {
      document.querySelectorAll('[data-wlwincolor]').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      settings.wl.winColor = s.dataset.wlwincolor;
      document.getElementById('wlWinColor').value = s.dataset.wlwincolor;
      updateWLPreview();
    });
  });
  document.getElementById('wlWinColor').addEventListener('input', e => {
    document.querySelectorAll('[data-wlwincolor]').forEach(x => x.classList.remove('active'));
    settings.wl.winColor = e.target.value;
    updateWLPreview();
  });
  document.querySelectorAll('[data-wllosscolor]').forEach(s => {
    s.addEventListener('click', () => {
      document.querySelectorAll('[data-wllosscolor]').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      settings.wl.lossColor = s.dataset.wllosscolor;
      document.getElementById('wlLossColor').value = s.dataset.wllosscolor;
      updateWLPreview();
    });
  });
  document.getElementById('wlLossColor').addEventListener('input', e => {
    document.querySelectorAll('[data-wllosscolor]').forEach(x => x.classList.remove('active'));
    settings.wl.lossColor = e.target.value;
    updateWLPreview();
  });
  setupRange('wlBgOpacity','wlBgOpacityVal', v => Math.round(v*100)+'%', v => { settings.wl.bgOpacity=parseFloat(v); updateWLPreview(); });
  setupRange('wlNumSize','wlNumSizeVal', v => v+'px', v => { settings.wl.numSize=parseInt(v); updateWLPreview(); });
  setupRange('wlLabelSize','wlLabelSizeVal', v => v+'px', v => { settings.wl.labelSize=parseInt(v); updateWLPreview(); });
  setupRange('wlRadius','wlRadiusVal', v => v+'px', v => { settings.wl.radius=parseInt(v); updateWLPreview(); });
  document.getElementById('wlFont').addEventListener('change', e => { settings.wl.font=e.target.value; updateWLPreview(); });
  ['wlWinLabel','wlLossLabel','wlTitle','wlSeparator'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      const key = id.slice(2,3).toLowerCase() + id.slice(3);
      settings.wl[key.charAt(0).toLowerCase()+key.slice(1)] = e.target.value;
      updateWLPreview();
    });
  });
  document.getElementById('copyWlObsBtn').addEventListener('click', () => {
    const url = document.getElementById('wlObsUrl').textContent;
    if (!url || url === 'Loading...') return;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copyWlObsBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
  loadWLObsUrl();

  // ── Feature toggle bar ──
  document.getElementById('ft-overlay').addEventListener('click', () => {
    settings.features.overlayEnabled = !settings.features.overlayEnabled;
    updateFeatureBar();
    saveFeatures();
  });
  document.getElementById('ft-chatreply').addEventListener('click', () => {
    settings.features.chatReplyEnabled = !settings.features.chatReplyEnabled;
    updateFeatureBar();
    saveFeatures();
  });
  document.getElementById('ft-voice').addEventListener('click', () => {
    settings.features.voiceEnabled = !settings.features.voiceEnabled;
    settings.tts.enabled = settings.features.voiceEnabled;
    document.getElementById('ttsEnabled').checked = settings.features.voiceEnabled;
    document.getElementById('ttsOptions').style.display = settings.features.voiceEnabled ? '' : 'none';
    document.getElementById('kwSpeechField').style.display = settings.features.voiceEnabled ? '' : 'none';
    updateFeatureBar();
    saveFeatures();
  });

  // ── Template cards ──
  document.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.template-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      settings.overlay.template = card.dataset.template;
      showTemplateOptions(card.dataset.template);
      updatePreview();
    });
  });

  // ── Layout cards ──
  document.querySelectorAll('.layout-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.layout-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      settings.overlay.layout = card.dataset.layout;
      updatePreview();
    });
  });

  // ── Orientation cards (left panel) ──
  document.querySelectorAll('.orient-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.orient-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      settings.overlay.orientation = card.dataset.orient;
      setPreviewOrient(card.dataset.orient);
    });
  });

  // ── Preview orientation buttons (top of right panel) ──
  document.getElementById('pvOrientV').addEventListener('click', () => setPreviewOrient('vertical'));
  document.getElementById('pvOrientL').addEventListener('click', () => setPreviewOrient('landscape'));

  // ── Accent color swatches (TikTok) ──
  document.querySelectorAll('#colorRow .color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('#colorRow .color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      settings.overlay.accentColor = sw.dataset.color;
      document.getElementById('customColor').value = sw.dataset.color;
      updatePreview();
    });
  });
  document.getElementById('customColor').addEventListener('input', e => {
    document.querySelectorAll('#colorRow .color-swatch').forEach(s => s.classList.remove('active'));
    settings.overlay.accentColor = e.target.value;
    updatePreview();
  });

  // ── Text color swatches ──
  document.querySelectorAll('[data-textcolor]').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('[data-textcolor]').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      settings.fonts.textColor = sw.dataset.textcolor;
      document.getElementById('customTextColor').value = sw.dataset.textcolor;
      updatePreview();
    });
  });
  document.getElementById('customTextColor').addEventListener('input', e => {
    document.querySelectorAll('[data-textcolor]').forEach(s => s.classList.remove('active'));
    settings.fonts.textColor = e.target.value;
    updatePreview();
  });

  // ── Typewriter color swatches ──
  document.querySelectorAll('[data-twcolor]').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('[data-twcolor]').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      settings.typewriter.color = sw.dataset.twcolor;
      document.getElementById('twColor').value = sw.dataset.twcolor;
      updatePreview();
    });
  });
  document.getElementById('twColor').addEventListener('input', e => {
    document.querySelectorAll('[data-twcolor]').forEach(s => s.classList.remove('active'));
    settings.typewriter.color = e.target.value;
    updatePreview();
  });

  // ── Messenger color swatches ──
  document.querySelectorAll('[data-msgcolor]').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('[data-msgcolor]').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      settings.messenger.bubbleColor = sw.dataset.msgcolor;
      document.getElementById('msgColor').value = sw.dataset.msgcolor;
      updatePreview();
    });
  });
  document.getElementById('msgColor').addEventListener('input', e => {
    document.querySelectorAll('[data-msgcolor]').forEach(s => s.classList.remove('active'));
    settings.messenger.bubbleColor = e.target.value;
    updatePreview();
  });

  // ── Animation cards ──
  document.querySelectorAll('.anim-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.anim-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      settings.animation.type = card.dataset.anim;
    });
  });

  // ── Range sliders ──
  setupRange('bgOpacity', 'bgOpacityVal', v => Math.round(v * 100) + '%', v => { settings.overlay.bgOpacity = parseFloat(v); updatePreview(); });
  setupRange('blurStrength', 'blurVal', v => v + 'px', v => { settings.overlay.blurStrength = parseInt(v); updatePreview(); });
  setupRange('borderRadius', 'radiusVal', v => v + 'px', v => { settings.overlay.borderRadius = parseInt(v); updatePreview(); });
  setupRange('cardWidth', 'widthVal', v => v, v => { settings.overlay.cardWidth = parseInt(v); updatePreview(); });
  setupRange('fontSize', 'fontSizeVal', v => v + 'px', v => { settings.fonts.fontSize = parseInt(v); updatePreview(); });
  setupRange('letterSpacing', 'letterSpacingVal', v => v, v => { settings.fonts.letterSpacing = parseFloat(v); updatePreview(); });
  setupRange('lineHeight', 'lineHeightVal', v => v, v => { settings.fonts.lineHeight = parseFloat(v); updatePreview(); });
  setupRange('questionFontSize', 'questionFontSizeVal', v => v + 'px', v => settings.fonts.questionFontSize = parseInt(v));
  setupRange('displayDuration', 'durationVal', v => v + 's', v => settings.animation.displayDuration = parseInt(v));
  setupRange('animSpeed', 'animSpeedVal', v => v + 's', v => settings.animation.animSpeed = parseFloat(v));
  setupRange('twFontSize', 'twFontSizeVal', v => v + 'px', v => { settings.typewriter.fontSize = parseInt(v); updatePreview(); });
  setupRange('twGlow', 'twGlowVal', v => v + 'px', v => { settings.typewriter.glow = parseInt(v); updatePreview(); });
  setupRange('twSpeed', 'twSpeedVal', v => v + 'ms', v => { settings.typewriter.speed = parseInt(v); });
  setupRange('msgFontSize', 'msgFontSizeVal', v => v + 'px', v => { settings.messenger.fontSize = parseInt(v); updatePreview(); });
  setupRange('msgBgOpacity', 'msgBgOpacityVal', v => Math.round(v * 100) + '%', v => { settings.messenger.bgOpacity = parseFloat(v); updatePreview(); });

  // ── Select + checkbox ──
  document.getElementById('fontFamily').addEventListener('change', e => { settings.fonts.fontFamily = e.target.value; updatePreview(); });
  document.getElementById('fontWeight').addEventListener('change', e => { settings.fonts.fontWeight = parseInt(e.target.value); updatePreview(); });
  document.getElementById('onlyQuestions').addEventListener('change', e => settings.bot.onlyReplyToQuestions = e.target.checked);
  document.getElementById('replyLanguage').addEventListener('change', e => settings.bot.replyLanguage = e.target.value);
  document.getElementById('cooldown').addEventListener('change', e => settings.bot.replyCooldownSeconds = parseInt(e.target.value));
  document.getElementById('maxReplies').addEventListener('change', e => settings.bot.maxRepliesPerMinute = parseInt(e.target.value));
  document.getElementById('showProgress').addEventListener('change', e => { settings.animation.showProgress = e.target.checked; updatePreview(); });
  document.getElementById('showGlow').addEventListener('change', e => { settings.animation.showGlow = e.target.checked; updatePreview(); });
  document.getElementById('showBlur').addEventListener('change', e => { settings.animation.showBlur = e.target.checked; updatePreview(); });
  document.getElementById('showBadgeDot').addEventListener('change', e => settings.animation.showBadgeDot = e.target.checked);
  document.getElementById('twCursor').addEventListener('change', e => { settings.typewriter.showCursor = e.target.checked; updatePreview(); });
  document.getElementById('twShowQuestion').addEventListener('change', e => { settings.typewriter.showQuestion = e.target.checked; updatePreview(); });
  document.getElementById('msgReadReceipts').addEventListener('change', e => { settings.messenger.readReceipts = e.target.checked; updatePreview(); });
  document.getElementById('msgTimestamp').addEventListener('change', e => { settings.messenger.showTimestamp = e.target.checked; updatePreview(); });

  // ── TTS controls ──
  document.getElementById('ttsEnabled').addEventListener('change', e => {
    settings.tts.enabled = e.target.checked;
    document.getElementById('ttsOptions').style.display = e.target.checked ? '' : 'none';
    document.getElementById('kwSpeechField').style.display = e.target.checked ? '' : 'none';
    if (e.target.checked && settings.tts.engine === 'elevenlabs') loadElevenLabsVoices();
  });

  // Engine cards
  document.querySelectorAll('.tts-engine-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.tts-engine-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      settings.tts.engine = card.dataset.engine;
      document.getElementById('browserVoiceOpts').style.display = card.dataset.engine === 'browser' ? '' : 'none';
      document.getElementById('elevenlabsVoiceOpts').style.display = card.dataset.engine === 'elevenlabs' ? '' : 'none';
      document.getElementById('googleVoiceOpts').style.display = card.dataset.engine === 'google' ? '' : 'none';
      if (card.dataset.engine === 'elevenlabs') loadElevenLabsVoices();
      if (card.dataset.engine === 'google') loadGoogleVoices();
    });
  });

  document.getElementById('ttsSpeakAI').addEventListener('change', e => settings.tts.speakAI = e.target.checked);
  document.getElementById('ttsSayName').addEventListener('change', e => settings.tts.sayName = e.target.checked);

  // Browser voice controls
  setupRange('ttsRate', 'ttsRateVal', v => parseFloat(v).toFixed(1) + 'x', v => settings.tts.rate = parseFloat(v));
  setupRange('ttsPitch', 'ttsPitchVal', v => parseFloat(v).toFixed(1), v => settings.tts.pitch = parseFloat(v));
  setupRange('ttsVolume', 'ttsVolumeVal', v => Math.round(v * 100) + '%', v => settings.tts.volume = parseFloat(v));

  // ElevenLabs controls
  setupRange('elStability', 'elStabilityVal', v => parseFloat(v).toFixed(2), v => settings.tts.elStability = parseFloat(v));
  setupRange('elSimilarity', 'elSimilarityVal', v => parseFloat(v).toFixed(2), v => settings.tts.elSimilarity = parseFloat(v));
  setupRange('elVolume', 'elVolumeVal', v => Math.round(v * 100) + '%', v => settings.tts.elVolume = parseFloat(v));
  document.getElementById('elVoice').addEventListener('change', e => settings.tts.elVoiceId = e.target.value);

  // Google TTS controls
  setupRange('googleRate', 'googleRateVal', v => parseFloat(v).toFixed(2) + 'x', v => settings.tts.googleRate = parseFloat(v));
  setupRange('googlePitch', 'googlePitchVal', v => parseFloat(v).toFixed(1), v => settings.tts.googlePitch = parseFloat(v));
  setupRange('googleVolume', 'googleVolumeVal', v => Math.round(v * 100) + '%', v => settings.tts.googleVolume = parseFloat(v));
  document.getElementById('googleVoice').addEventListener('change', e => settings.tts.googleVoice = e.target.value);
  document.getElementById('googleVoiceType').addEventListener('change', e => {
    settings.tts.googleVoiceType = e.target.value;
    filterGoogleVoices(e.target.value);
  });

  // Browser voice list
  // Chrome extensions often return empty on first getVoices() call
  // and onvoiceschanged doesn't always fire — use polling as fallback
  function populateVoices() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return false; // not ready yet
    const sel = document.getElementById('ttsVoice');
    // Group by language for easier browsing
    const grouped = {};
    voices.forEach(v => {
      const lang = v.lang.split('-')[0].toUpperCase();
      if (!grouped[lang]) grouped[lang] = [];
      grouped[lang].push(v);
    });
    sel.innerHTML = Object.entries(grouped)
      .sort(([a], [b]) => a === 'EN' ? -1 : b === 'EN' ? 1 : a.localeCompare(b))
      .map(([lang, vs]) =>
        `<optgroup label="${lang}">` +
        vs.map(v => `<option value="${v.name}" ${v.name === settings.tts.voice ? 'selected' : ''}>${v.name}</option>`).join('') +
        `</optgroup>`
      ).join('');
    if (!settings.tts.voice && voices.length) {
      // Default to first English voice
      const eng = voices.find(v => v.lang.startsWith('en')) || voices[0];
      settings.tts.voice = eng.name;
      sel.value = eng.name;
    } else if (settings.tts.voice) {
      sel.value = settings.tts.voice;
    }
    return true;
  }

  // Try immediately, then poll until voices load (Chrome extension fix)
  function initVoices() {
    if (populateVoices()) return; // loaded on first try
    // Poll every 100ms for up to 3 seconds
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (populateVoices() || attempts > 30) clearInterval(poll);
    }, 100);
  }

  // Also hook onvoiceschanged as backup
  window.speechSynthesis.onvoiceschanged = populateVoices;
  initVoices();
  document.getElementById('ttsVoice').addEventListener('change', e => settings.tts.voice = e.target.value);

  // Test voice button
  document.getElementById('ttsTestBtn').addEventListener('click', async () => {
    const btn = document.getElementById('ttsTestBtn');
    btn.textContent = '⏳ Speaking...';
    btn.disabled = true;
    const prefix = settings.tts.sayName ? 'TestViewer asked. ' : '';
    await speakText('Hello! This is your StreamBuddy AI voice. How does it sound?', null);
    btn.textContent = '🔊 Test Voice Now';
    btn.disabled = false;
  });

  // ── Streamer info ──
  ['sName','sAge','sLocation','sPhone','sSetup','sStreamingFor','sAbout'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      const key = id.slice(1,2).toLowerCase() + id.slice(2);
      settings.streamerInfo[key] = e.target.value;
    });
  });

  // ── Test mode ──
  document.getElementById('testModeBtn').addEventListener('click', () => {
    switchTab('keywords');
    document.getElementById('testInput').focus();
  });
  document.getElementById('testSendBtn').addEventListener('click', sendTestMessage);
  document.getElementById('testInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendTestMessage();
  });

  // Quick test message buttons
  document.getElementById('tqPhone').addEventListener('click', () => setTestMsg('which phone are you using?'));
  document.getElementById('tqLocation').addEventListener('click', () => setTestMsg('where are you from?'));
  document.getElementById('tqSetup').addEventListener('click', () => setTestMsg('what is your setup?'));
  document.getElementById('tqAge').addEventListener('click', () => setTestMsg('how old are you?'));
  document.getElementById('tqTime').addEventListener('click', () => setTestMsg('how long have you been streaming?'));

  // Test link buttons
  document.getElementById('testLinkCopyBtn').addEventListener('click', copyTestLink);
  document.getElementById('testLinkOpenBtn').addEventListener('click', openTestLink);

  populateUI();
  populateWLUI();
  renderKeywords();
  updatePreview();
  setPreviewOrient(settings.overlay.orientation || 'vertical');
  showTemplateOptions(settings.overlay.template || 'tiktok');
  loadTestLink(); // ← populate overlay test URL

  // Re-scale on window resize
  window.addEventListener('resize', () => setPreviewOrient(currentPreviewOrient));
});

// ── Deep merge ────────────────────────────────────────────────
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Feature toggle bar ────────────────────────────────────────
function updateFeatureBar() {
  setFeatureToggle('ft-overlay', 'ft-overlay-dot', settings.features.overlayEnabled);
  setFeatureToggle('ft-chatreply', 'ft-chatreply-dot', settings.features.chatReplyEnabled);
  setFeatureToggle('ft-voice', 'ft-voice-dot', settings.features.voiceEnabled);
}

function setFeatureToggle(btnId, dotId, active) {
  const btn = document.getElementById(btnId);
  const dot = document.getElementById(dotId);
  if (active) {
    btn.classList.add('active');
    btn.classList.remove('inactive');
    dot.classList.add('active');
    dot.classList.remove('inactive');
  } else {
    btn.classList.remove('active');
    btn.classList.add('inactive');
    dot.classList.remove('active');
    dot.classList.add('inactive');
  }
}

async function saveFeatures() {
  await chrome.storage.local.set({ featureSettings: settings.features });
  const stored = await chrome.storage.local.get(['sessionId']);
  if (!stored.sessionId) return;
  try {
    // ✅ Use dedicated route — doesn't wipe other config like keywords/streamer info
    await fetch(`${SERVER_URL}/api/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: stored.sessionId,
        features: settings.features
      })
    });
  } catch {}
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

// ── Preview orientation ───────────────────────────────────────
function setPreviewOrient(orient) {
  currentPreviewOrient = orient;
  settings.overlay.orientation = orient;

  const frame = document.getElementById('phoneFrame');
  frame.className = 'phone-frame ' + orient;

  // Scale the frame to fit preview area if needed
  requestAnimationFrame(() => {
    const area = document.querySelector('.preview-area');
    const areaW = area.clientWidth - 32; // minus padding
    const areaH = area.clientHeight - 32;
    const frameW = orient === 'landscape' ? 360 : 190;
    const frameH = orient === 'landscape' ? 202 : 360;
    const scaleX = areaW / frameW;
    const scaleY = areaH / frameH;
    const scale = Math.min(scaleX, scaleY, 1); // never scale up, only down
    frame.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : '';
  });

  document.getElementById('pvOrientV').classList.toggle('active', orient === 'vertical');
  document.getElementById('pvOrientL').classList.toggle('active', orient === 'landscape');

  // Sync orient cards in overlay tab
  document.querySelectorAll('.orient-card').forEach(c => {
    c.classList.toggle('active', c.dataset.orient === orient);
  });

  updatePreview();
}

// ── Show/hide template-specific options ───────────────────────
function showTemplateOptions(tpl) {
  document.getElementById('tpl-opts-tiktok').style.display = tpl === 'tiktok' ? '' : 'none';
  document.getElementById('tpl-opts-typewriter').style.display = tpl === 'typewriter' ? '' : 'none';
  document.getElementById('tpl-opts-messenger').style.display = tpl === 'messenger' ? '' : 'none';
}

// ── Populate UI from settings ─────────────────────────────────
function populateUI() {
  // Bot
  document.getElementById('onlyQuestions').checked = settings.bot.onlyReplyToQuestions;
  document.getElementById('replyLanguage').value = settings.bot.replyLanguage;
  document.getElementById('cooldown').value = settings.bot.replyCooldownSeconds;
  document.getElementById('maxReplies').value = settings.bot.maxRepliesPerMinute;

  // Streamer
  document.getElementById('sName').value = settings.streamerInfo.name || '';
  document.getElementById('sAge').value = settings.streamerInfo.age || '';
  document.getElementById('sLocation').value = settings.streamerInfo.location || '';
  document.getElementById('sPhone').value = settings.streamerInfo.phone || '';
  document.getElementById('sSetup').value = settings.streamerInfo.setup || '';
  document.getElementById('sStreamingFor').value = settings.streamerInfo.streamingFor || '';
  document.getElementById('sAbout').value = settings.streamerInfo.about || '';

  // Template
  const tpl = settings.overlay.template || 'tiktok';
  document.querySelectorAll('.template-card').forEach(c => c.classList.toggle('active', c.dataset.template === tpl));

  // Layout
  document.querySelectorAll('.layout-card').forEach(c => c.classList.toggle('active', c.dataset.layout === settings.overlay.layout));

  // Orientation
  document.querySelectorAll('.orient-card').forEach(c => c.classList.toggle('active', c.dataset.orient === (settings.overlay.orientation || 'vertical')));

  // Colors
  document.getElementById('customColor').value = settings.overlay.accentColor;
  document.getElementById('customTextColor').value = settings.fonts.textColor;
  document.getElementById('twColor').value = settings.typewriter.color || '#ffffff';
  document.getElementById('msgColor').value = settings.messenger.bubbleColor || '#0b84ff';

  // Ranges
  setRangeValue('bgOpacity', settings.overlay.bgOpacity, Math.round(settings.overlay.bgOpacity * 100) + '%', 'bgOpacityVal');
  setRangeValue('blurStrength', settings.overlay.blurStrength, settings.overlay.blurStrength + 'px', 'blurVal');
  setRangeValue('borderRadius', settings.overlay.borderRadius, settings.overlay.borderRadius + 'px', 'radiusVal');
  setRangeValue('cardWidth', settings.overlay.cardWidth, settings.overlay.cardWidth, 'widthVal');
  setRangeValue('fontSize', settings.fonts.fontSize, settings.fonts.fontSize + 'px', 'fontSizeVal');
  setRangeValue('letterSpacing', settings.fonts.letterSpacing, settings.fonts.letterSpacing, 'letterSpacingVal');
  setRangeValue('lineHeight', settings.fonts.lineHeight, settings.fonts.lineHeight, 'lineHeightVal');
  setRangeValue('questionFontSize', settings.fonts.questionFontSize, settings.fonts.questionFontSize + 'px', 'questionFontSizeVal');
  setRangeValue('displayDuration', settings.animation.displayDuration, settings.animation.displayDuration + 's', 'durationVal');
  setRangeValue('animSpeed', settings.animation.animSpeed, settings.animation.animSpeed + 's', 'animSpeedVal');
  setRangeValue('twFontSize', settings.typewriter.fontSize || 32, (settings.typewriter.fontSize || 32) + 'px', 'twFontSizeVal');
  setRangeValue('twGlow', settings.typewriter.glow || 12, (settings.typewriter.glow || 12) + 'px', 'twGlowVal');
  setRangeValue('twSpeed', settings.typewriter.speed || 50, (settings.typewriter.speed || 50) + 'ms', 'twSpeedVal');
  setRangeValue('msgFontSize', settings.messenger.fontSize || 20, (settings.messenger.fontSize || 20) + 'px', 'msgFontSizeVal');
  setRangeValue('msgBgOpacity', settings.messenger.bgOpacity || 0.85, Math.round((settings.messenger.bgOpacity || 0.85) * 100) + '%', 'msgBgOpacityVal');

  // Selects
  document.getElementById('fontFamily').value = settings.fonts.fontFamily;
  document.getElementById('fontWeight').value = settings.fonts.fontWeight;

  // Checkboxes
  document.getElementById('showProgress').checked = settings.animation.showProgress;
  document.getElementById('showGlow').checked = settings.animation.showGlow;
  document.getElementById('showBlur').checked = settings.animation.showBlur;
  document.getElementById('showBadgeDot').checked = settings.animation.showBadgeDot;
  document.getElementById('twCursor').checked = settings.typewriter.showCursor !== false;
  document.getElementById('twShowQuestion').checked = settings.typewriter.showQuestion !== false;
  document.getElementById('msgReadReceipts').checked = settings.messenger.readReceipts !== false;
  document.getElementById('msgTimestamp').checked = settings.messenger.showTimestamp !== false;

  // Features
  if (settings.features) {
    settings.features.voiceEnabled = settings.tts.enabled;
    updateFeatureBar();
  }

  // Anim card
  document.querySelectorAll('.anim-card').forEach(c => c.classList.toggle('active', c.dataset.anim === settings.animation.type));

  // TTS
  document.getElementById('ttsEnabled').checked = settings.tts.enabled;
  document.getElementById('ttsOptions').style.display = settings.tts.enabled ? '' : 'none';
  document.getElementById('kwSpeechField').style.display = settings.tts.enabled ? '' : 'none';
  document.getElementById('ttsSpeakAI').checked = settings.tts.speakAI !== false;
  document.getElementById('ttsSayName').checked = settings.tts.sayName === true;
  // Engine
  const eng = settings.tts.engine || 'browser';
  document.querySelectorAll('.tts-engine-card').forEach(c => c.classList.toggle('active', c.dataset.engine === eng));
  document.getElementById('browserVoiceOpts').style.display = eng === 'browser' ? '' : 'none';
  document.getElementById('elevenlabsVoiceOpts').style.display = eng === 'elevenlabs' ? '' : 'none';
  document.getElementById('googleVoiceOpts').style.display = eng === 'google' ? '' : 'none';
  // Browser sliders
  setRangeValue('ttsRate', settings.tts.rate || 1, (settings.tts.rate || 1).toFixed(1) + 'x', 'ttsRateVal');
  setRangeValue('ttsPitch', settings.tts.pitch || 1, (settings.tts.pitch || 1).toFixed(1), 'ttsPitchVal');
  setRangeValue('ttsVolume', settings.tts.volume ?? 1, Math.round((settings.tts.volume ?? 1) * 100) + '%', 'ttsVolumeVal');
  // ElevenLabs sliders
  setRangeValue('elStability', settings.tts.elStability ?? 0.5, (settings.tts.elStability ?? 0.5).toFixed(2), 'elStabilityVal');
  setRangeValue('elSimilarity', settings.tts.elSimilarity ?? 0.75, (settings.tts.elSimilarity ?? 0.75).toFixed(2), 'elSimilarityVal');
  setRangeValue('elVolume', settings.tts.elVolume ?? 1, Math.round((settings.tts.elVolume ?? 1) * 100) + '%', 'elVolumeVal');
  // Google sliders
  setRangeValue('googleRate', settings.tts.googleRate ?? 1, (settings.tts.googleRate ?? 1).toFixed(2) + 'x', 'googleRateVal');
  setRangeValue('googlePitch', settings.tts.googlePitch ?? 0, (settings.tts.googlePitch ?? 0).toFixed(1), 'googlePitchVal');
  setRangeValue('googleVolume', settings.tts.googleVolume ?? 1, Math.round((settings.tts.googleVolume ?? 1) * 100) + '%', 'googleVolumeVal');
  if (settings.tts.googleVoiceType) document.getElementById('googleVoiceType').value = settings.tts.googleVoiceType;
  if (settings.tts.enabled && eng === 'elevenlabs') loadElevenLabsVoices();
  if (settings.tts.enabled && eng === 'google') loadGoogleVoices();
}

function setRangeValue(inputId, value, display, valId) {
  const el = document.getElementById(inputId);
  if (el) el.value = value;
  const val = document.getElementById(valId);
  if (val) val.textContent = display;
}

// ── Range slider helper ───────────────────────────────────────
function setupRange(inputId, valId, formatter, onChange) {
  const input = document.getElementById(inputId);
  const valEl = document.getElementById(valId);
  if (!input) return;
  input.addEventListener('input', () => {
    if (valEl) valEl.textContent = formatter(input.value);
    onChange(input.value);
  });
}

// ── Live preview update ───────────────────────────────────────
function updatePreview() {
  const tpl = settings.overlay.template || 'tiktok';

  // Show correct card type
  document.getElementById('pvTiktok').style.display = tpl === 'tiktok' ? '' : 'none';
  document.getElementById('pvTypewriter').style.display = tpl === 'typewriter' ? '' : 'none';
  document.getElementById('pvMessenger').style.display = tpl === 'messenger' ? '' : 'none';

  // Position wrapper
  const wrap = document.getElementById('pvWrap');
  wrap.className = 'pv-wrap ' + layoutToClass(settings.overlay.layout);

  if (tpl === 'tiktok') updateTiktokPreview();
  else if (tpl === 'typewriter') updateTypewriterPreview();
  else if (tpl === 'messenger') updateMessengerPreview();
}

function layoutToClass(layout) {
  return { 'bottom-left': 'bl', 'bottom-right': 'br', 'top-left': 'tl', 'top-right': 'tr', 'center-bottom': 'cb', 'minimal': 'bl' }[layout] || 'bl';
}

// ── ElevenLabs voice loader ───────────────────────────────────
async function loadElevenLabsVoices() {
  const bar = document.getElementById('elStatusBar');
  const sel = document.getElementById('elVoice');
  bar.className = 'el-status-bar loading';
  bar.textContent = '⏳ Loading ElevenLabs voices...';
  bar.style.display = '';
  try {
    const stored = await chrome.storage.local.get(['sessionId']);
    const res = await fetch(`${SERVER_URL}/api/tts/voices`);
    const data = await res.json();
    if (!data.available) {
      bar.className = 'el-status-bar err';
      bar.textContent = '❌ ' + (data.error || 'ElevenLabs not configured — add ELEVENLABS_API_KEY to Railway Variables');
      sel.innerHTML = '<option value="">Not available</option>';
      return;
    }
    // Populate voice dropdown grouped by category
    const grouped = {};
    data.voices.forEach(v => {
      const cat = v.category || 'premade';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(v);
    });
    sel.innerHTML = Object.entries(grouped).map(([cat, voices]) =>
      `<optgroup label="${cat.charAt(0).toUpperCase() + cat.slice(1)}">
        ${voices.map(v => `<option value="${v.id}" ${v.id === settings.tts.elVoiceId ? 'selected' : ''}>${v.name}</option>`).join('')}
      </optgroup>`
    ).join('');
    // Set default if none selected
    if (!settings.tts.elVoiceId && data.voices.length) {
      settings.tts.elVoiceId = data.voices[0].id;
      sel.value = settings.tts.elVoiceId;
    }
    bar.className = 'el-status-bar ok';
    bar.textContent = `✓ ${data.voices.length} ElevenLabs voices loaded`;
    setTimeout(() => bar.style.display = 'none', 3000);
  } catch (err) {
    bar.className = 'el-status-bar err';
    bar.textContent = '❌ Could not reach server — check Railway is running';
  }
}

// ── TTS — speaks from settings page ──────────────────────────
// OBS/TikTok Studio can't output audio, so speech runs here
// ─────────────────────────────────────────────────────────────
async function speakText(text, speechReply) {
  if (!settings.tts.enabled) return;
  const raw = (speechReply || text || '').trim();
  if (!raw) return;

  // Strip emojis
  const clean = raw.replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
                   .replace(/[\u2600-\u27BF]/g, '')
                   .replace(/\s+/g, ' ').trim();
  if (!clean) return;

  // ✅ Always cancel any currently playing speech first (prevents double TTS)
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (elAudio) { elAudio.pause(); elAudio = null; }
  if (googleAudio) { googleAudio.pause(); googleAudio = null; }

  const engine = settings.tts.engine || 'browser';

  if (engine === 'elevenlabs' && settings.tts.elVoiceId) {
    await speakElevenLabs(clean);
  } else if (engine === 'google' && settings.tts.googleVoice) {
    await speakGoogle(clean);
  } else {
    speakBrowser(clean);
  }
}

function speakBrowser(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  function doSpeak() {
    const utt = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    if (settings.tts.voice && voices.length) {
      const chosen = voices.find(v => v.name === settings.tts.voice);
      if (chosen) utt.voice = chosen;
    }
    utt.rate = settings.tts.rate || 1;
    utt.pitch = settings.tts.pitch || 1;
    utt.volume = settings.tts.volume ?? 1;
    window.speechSynthesis.speak(utt);
  }

  // If voices not loaded yet, wait a moment then speak
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    doSpeak();
  } else {
    setTimeout(doSpeak, 300);
  }
}

let elAudio = null; // keep reference to stop previous audio
async function speakElevenLabs(text) {
  try {
    // Stop any currently playing EL audio
    if (elAudio) { elAudio.pause(); elAudio = null; }

    const stored = await chrome.storage.local.get(['sessionId']);
    const res = await fetch(`${SERVER_URL}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceId: settings.tts.elVoiceId,
        stability: settings.tts.elStability ?? 0.5,
        similarityBoost: settings.tts.elSimilarity ?? 0.75,
        sessionId: stored.sessionId || null
      })
    });

    if (!res.ok) {
      console.warn('ElevenLabs TTS failed:', res.status);
      return; // don't fallback — prevents double TTS
    }

    // Play the streamed MP3 audio
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    elAudio = new Audio(url);
    elAudio.volume = settings.tts.elVolume ?? 1;
    elAudio.play();
    elAudio.onended = () => { URL.revokeObjectURL(url); elAudio = null; };

  } catch (err) {
    console.warn('ElevenLabs error:', err.message);
    // Don't fallback to browser — would cause double TTS
  }
}

// ── Google Cloud TTS ──────────────────────────────────────────
let allGoogleVoices = [];
let googleAudio = null;

async function loadGoogleVoices() {
  const bar = document.getElementById('googleStatusBar');
  const sel = document.getElementById('googleVoice');
  bar.className = 'el-status-bar loading';
  bar.textContent = '⏳ Loading Google voices...';
  bar.style.display = '';
  try {
    const res = await fetch(`${SERVER_URL}/api/tts/google-voices`);
    const data = await res.json();
    if (!data.available) {
      bar.className = 'el-status-bar err';
      bar.textContent = '❌ ' + (data.error || 'Google TTS not configured — add GOOGLE_TTS_KEY to Railway Variables');
      sel.innerHTML = '<option value="">Not available</option>';
      return;
    }
    allGoogleVoices = data.voices;
    filterGoogleVoices(settings.tts.googleVoiceType || 'Neural2');
    bar.className = 'el-status-bar ok';
    bar.textContent = `✓ ${data.voices.length} Google voices loaded`;
    setTimeout(() => bar.style.display = 'none', 3000);
  } catch (err) {
    bar.className = 'el-status-bar err';
    bar.textContent = '❌ Could not reach server';
  }
}

function filterGoogleVoices(type) {
  const sel = document.getElementById('googleVoice');
  const filtered = allGoogleVoices.filter(v => v.type === type || v.name.includes(type));
  if (!filtered.length) {
    sel.innerHTML = '<option value="">No voices of this type found</option>';
    return;
  }
  sel.innerHTML = filtered.map(v => {
    const lang = v.languageCodes?.[0] || '';
    const gender = v.gender === 'FEMALE' ? '♀' : v.gender === 'MALE' ? '♂' : '';
    return `<option value="${v.name}" ${v.name === settings.tts.googleVoice ? 'selected' : ''}>${gender} ${v.name} (${lang})</option>`;
  }).join('');
  if (!settings.tts.googleVoice && filtered.length) {
    // Default to English voice
    const eng = filtered.find(v => v.languageCodes?.[0]?.startsWith('en')) || filtered[0];
    settings.tts.googleVoice = eng.name;
    sel.value = eng.name;
  }
}

async function speakGoogle(text) {
  try {
    if (googleAudio) { googleAudio.pause(); googleAudio = null; }
    const stored = await chrome.storage.local.get(['sessionId']);
    const res = await fetch(`${SERVER_URL}/api/tts/google-speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceName: settings.tts.googleVoice,
        speakingRate: settings.tts.googleRate ?? 1,
        pitch: settings.tts.googlePitch ?? 0,
        sessionId: stored.sessionId || null
      })
    });
    if (!res.ok) {
      console.warn('Google TTS failed:', res.status);
      return; // don't fallback — prevents double TTS
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    googleAudio = new Audio(url);
    googleAudio.volume = settings.tts.googleVolume ?? 1;
    googleAudio.play();
    googleAudio.onended = () => { URL.revokeObjectURL(url); googleAudio = null; };
  } catch (err) {
    console.warn('Google TTS error:', err.message);
    // don't fallback — prevents double TTS
  }
}

async function loadTestLink() {
  const stored = await chrome.storage.local.get(['sessionId']);
  const el = document.getElementById('testLinkUrl');
  if (!el) return;
  if (stored.sessionId) {
    const url = `${SERVER_URL}/overlay/${stored.sessionId}?test=1`;
    el.textContent = url;
    el.title = url;
    // Socket already initialized at startup — no need to init again here
  } else {
    el.textContent = 'Activate your license first';
    el.style.color = 'var(--muted)';
  }
}

// ── Socket for live TTS — speaks on real stream replies ───────
let settingsSocket = null;
function initSettingsSocket(sessionId) {
  if (settingsSocket) return;
  // socket.io is loaded as a static script tag in settings.html
  // No dynamic injection needed — io() is available globally
  if (typeof io === 'undefined') {
    console.warn('socket.io not loaded yet, retrying...');
    setTimeout(() => initSettingsSocket(sessionId), 500);
    return;
  }
  settingsSocket = io(SERVER_URL);
  settingsSocket.on('connect', () => {
    settingsSocket.emit('join', sessionId);
    console.log('Settings socket connected for TTS');
  });

  // ✅ Listen for dedicated tts event (fires regardless of overlay toggle)
  settingsSocket.on('tts', data => {
    if (!data.reply) return;
    const shouldSpeak = data.replyType === 'quick' || settings.tts.speakAI !== false;
    if (shouldSpeak) speakText(data.reply, data.speechReply);
  });

  // Also listen to chat for when overlay IS enabled (belt and braces)
  settingsSocket.on('chat', data => {
    if (!data.reply) return;
    // Only speak here if tts event won't fire (voiceEnabled check is on server side)
    // This handles the case where voiceEnabled flag isn't saved yet
    if (!settings.features?.voiceEnabled) return;
    // Already handled by tts event — skip to avoid double
  });

  // Test mode replies from server
  settingsSocket.on('test-chat', data => {
    if (!data.reply) return;
    const shouldSpeak = data.replyType === 'quick' || settings.tts.speakAI !== false;
    if (shouldSpeak) speakText(data.reply, data.speechReply);
  });
}

function copyTestLink() {
  const url = document.getElementById('testLinkUrl').textContent;
  if (!url || url.includes('Activate')) return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('testLinkCopyBtn');
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}

function openTestLink() {
  const url = document.getElementById('testLinkUrl').textContent;
  if (!url || url.includes('Activate')) return;
  chrome.tabs.create({ url });
}

function updateTiktokPreview() {
  const color = settings.overlay.accentColor;
  const tk = document.getElementById('pvTiktok');
  const blur = settings.animation.showBlur ? `blur(${settings.overlay.blurStrength}px)` : 'none';
  const glow = settings.animation.showGlow ? `0 4px 16px rgba(0,0,0,0.6), 0 0 8px ${color}50` : '0 4px 16px rgba(0,0,0,0.6)';
  tk.style.background = `rgba(0,0,0,${settings.overlay.bgOpacity})`;
  tk.style.border = `2px solid ${color}cc`;
  tk.style.borderRadius = Math.min(settings.overlay.borderRadius, 12) + 'px';
  tk.style.backdropFilter = blur;
  tk.style.boxShadow = glow;

  document.getElementById('pvHeader').style.background = color + 'e6';
  document.getElementById('pvProgress').style.background = color + '80';
  document.getElementById('pvProgress').style.display = settings.animation.showProgress ? '' : 'none';

  const reply = document.getElementById('pvReply');
  reply.style.fontFamily = settings.fonts.fontFamily;
  reply.style.fontSize = Math.round(settings.fonts.fontSize * 0.42) + 'px';
  reply.style.fontWeight = settings.fonts.fontWeight;
  reply.style.color = settings.fonts.textColor;
  reply.style.letterSpacing = settings.fonts.letterSpacing + 'px';
  reply.style.lineHeight = settings.fonts.lineHeight;
}

function updateTypewriterPreview() {
  const tw = document.getElementById('pvTypewriter');
  const color = settings.typewriter.color || '#ffffff';
  const glow = settings.typewriter.glow || 12;
  tw.style.color = color;
  tw.style.textShadow = glow > 0 ? `0 0 ${glow}px ${color}80, 0 0 ${glow * 2}px ${color}30` : 'none';
  tw.style.fontSize = Math.round((settings.typewriter.fontSize || 32) * 0.3) + 'px';
  const cursor = document.getElementById('pvCursor');
  cursor.style.display = settings.typewriter.showCursor ? 'inline-block' : 'none';
  cursor.style.height = Math.round((settings.typewriter.fontSize || 32) * 0.3) + 'px';
}

function updateMessengerPreview() {
  const color = settings.messenger.bubbleColor || '#0b84ff';
  const bgAlpha = settings.messenger.bgOpacity || 0.85;
  const fs = Math.round((settings.messenger.fontSize || 20) * 0.38) + 'px';

  // Parse the bubble color to create a dark background
  const bg = hexToRgba(color, 0.08);
  const pvMsg = document.getElementById('pvMessenger');
  pvMsg.style.background = `rgba(10,10,26,${bgAlpha})`;
  pvMsg.style.borderRadius = '8px';
  pvMsg.style.padding = '5px';

  document.getElementById('pvMsgR').style.background = color;
  document.getElementById('pvMsgR').style.fontSize = fs;
  document.getElementById('pvMsgQ').style.fontSize = fs;

  const meta = document.getElementById('pvMsgMeta');
  meta.style.display = (settings.messenger.readReceipts || settings.messenger.showTimestamp) ? 'flex' : 'none';
  document.getElementById('pvMsgRead').style.display = settings.messenger.readReceipts ? '' : 'none';
  document.getElementById('pvMsgTime').style.display = settings.messenger.showTimestamp ? '' : 'none';
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Test mode ─────────────────────────────────────────────────
function setTestMsg(msg) {
  document.getElementById('testInput').value = msg;
  document.getElementById('testInput').focus();
}

async function sendTestMessage() {
  const msg = document.getElementById('testInput').value.trim();
  if (!msg) return;

  const btn = document.getElementById('testSendBtn');
  const status = document.getElementById('testStatus');
  btn.disabled = true;
  status.className = 'test-status thinking';
  status.textContent = '🤔 Bot is thinking...';

  // Check for keyword match — whole-word only to avoid "age" matching "rampage"
  const kwMatch = settings.keywords.find(kw =>
    kw.keywords.some(k => {
      const escaped = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(msg);
    })
  );

  if (kwMatch) {
    const reply = fillTemplate(kwMatch.reply, 'testviewer', settings.streamerInfo);
    const speechReply = kwMatch.speechReply ? fillTemplate(kwMatch.speechReply, 'testviewer', settings.streamerInfo) : null;
    showTestReply(msg, reply, 'quick');
    speakText(reply, speechReply); // ✅ speak from settings page
    status.className = 'test-status ok';
    status.textContent = '⚡ Quick keyword reply matched!';
    btn.disabled = false;
    return;
  }

  // Otherwise simulate AI reply using streamer info
  const stored = await chrome.storage.local.get(['sessionId']);
  if (!stored.sessionId) {
    // Offline test — build a simulated reply from streamer info
    const reply = simulateAIReply(msg, settings.streamerInfo);
    showTestReply(msg, reply, 'ai');
    if (settings.tts.speakAI !== false) speakText(reply, null); // ✅ speak AI reply
    status.className = 'test-status ok';
    status.textContent = '✓ Simulated AI reply (not connected to server)';
    btn.disabled = false;
    return;
  }

  try {
    const res = await fetch(`${SERVER_URL}/api/test-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: stored.sessionId, message: msg, username: 'TestViewer' })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.reply) {
        showTestReply(msg, data.reply, data.replyType || 'ai');
        // ✅ Don't call speakText here — the socket 'chat' event fires too
        // and would cause double TTS. Speech is handled by initSettingsSocket listener.
        status.className = 'test-status ok';
        status.textContent = `✓ ${data.replyType === 'quick' ? 'Keyword' : 'AI'} reply received!`;
      } else {
        status.className = 'test-status err';
        status.textContent = '⚠ No reply — message may not match any keywords or AI settings';
      }
    } else {
      throw new Error('Server error');
    }
  } catch {
    // Fallback to simulation
    const reply = simulateAIReply(msg, settings.streamerInfo);
    showTestReply(msg, reply, 'ai');
    status.className = 'test-status ok';
    status.textContent = '✓ Simulated reply (server offline)';
  }

  btn.disabled = false;
}

function simulateAIReply(msg, info) {
  const lower = msg.toLowerCase();
  // ✅ Whole-word matching helper
  const hasWord = (...words) => words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(msg));

  if (hasWord('phone', 'iphone', 'device', 'mobile')) return info.phone ? `I use ${info.phone} for streaming! 📱` : "I'll share my phone details soon! 📱";
  if (hasWord('from', 'country', 'location', 'where')) return info.location ? `I'm from ${info.location}! 🌍` : "I'll share where I'm from soon!";
  if (hasWord('setup', 'gear', 'pc', 'computer', 'equipment')) return info.setup ? `My setup: ${info.setup} 🖥️` : "I'll share my setup details soon!";
  if (hasWord('age', 'old', 'born')) return info.age ? `I'm ${info.age} years old! 😊` : "That's a secret! 🤫";
  if (hasWord('stream', 'streaming', 'long', 'since', 'started')) return info.streamingFor ? `I've been streaming for ${info.streamingFor}! 🎮` : "I've been streaming for a while now!";
  if (hasWord('name', 'who', 'call')) return info.name ? `My name is ${info.name}! 👋` : "You can call me Streamer! 👋";
  return info.about ? info.about.substring(0, 80) + (info.about.length > 80 ? '...' : '') : "Thanks for the question! 🙏 Follow for more!";
}

function fillTemplate(template, username, info) {
  return template
    .replace(/\{username\}/g, username)
    .replace(/\{name\}/g, info.name || '')
    .replace(/\{age\}/g, info.age || '')
    .replace(/\{location\}/g, info.location || '')
    .replace(/\{phone\}/g, info.phone || '')
    .replace(/\{setup\}/g, info.setup || '');
}

function showTestReply(question, reply, type) {
  // Update preview card with test content
  const qText = `@TestViewer: "${question.substring(0, 50)}${question.length > 50 ? '…' : ''}"`;
  const replyText = reply;

  document.getElementById('pvQuestion').textContent = qText;
  document.getElementById('pvReply').textContent = replyText;
  document.getElementById('pvTwText').textContent = replyText;
  document.getElementById('pvMsgQ').textContent = `@TestViewer: ${question.substring(0, 40)}`;
  document.getElementById('pvMsgR').textContent = replyText;
  document.getElementById('pvMsgTime').textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

// ── Keywords ──────────────────────────────────────────────────
function renderKeywords() {
  const list = document.getElementById('keywordList');
  if (settings.keywords.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:14px">No keywords yet. Add one below!</div>';
    return;
  }
  list.innerHTML = settings.keywords.map((kw, i) => `
    <div class="keyword-item">
      <div class="kw-keywords">${kw.keywords.map(k => `<span class="kw-tag">${k}</span>`).join('')}</div>
      <div class="kw-reply">${kw.reply}</div>
      ${kw.speechReply ? `<div style="font-size:10px;color:var(--yellow);margin-top:4px;padding-right:48px">🔊 ${kw.speechReply}</div>` : ''}
      <div class="kw-actions">
        <button class="kw-btn kw-edit" data-i="${i}">✏️</button>
        <button class="kw-btn kw-delete" data-i="${i}">🗑️</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.kw-edit').forEach(btn => btn.addEventListener('click', () => openKwModal(parseInt(btn.dataset.i))));
  list.querySelectorAll('.kw-delete').forEach(btn => btn.addEventListener('click', () => { settings.keywords.splice(parseInt(btn.dataset.i), 1); renderKeywords(); }));
}

function openKwModal(index) {
  editingKeywordIndex = index;
  document.getElementById('kwModalTitle').textContent = index === -1 ? 'Add Keyword Reply' : 'Edit Keyword Reply';
  if (index >= 0) {
    document.getElementById('kwKeywords').value = settings.keywords[index].keywords.join(', ');
    document.getElementById('kwReply').value = settings.keywords[index].reply;
    document.getElementById('kwSpeechReply').value = settings.keywords[index].speechReply || '';
  } else {
    document.getElementById('kwKeywords').value = '';
    document.getElementById('kwReply').value = '';
    document.getElementById('kwSpeechReply').value = '';
  }
  // Show speech field only if TTS is enabled
  document.getElementById('kwSpeechField').style.display = settings.tts.enabled ? '' : 'none';
  document.getElementById('kwModal').classList.add('open');
}

function closeKwModal() { document.getElementById('kwModal').classList.remove('open'); }

function saveKeyword() {
  const keywords = document.getElementById('kwKeywords').value.split(',').map(k => k.trim()).filter(Boolean);
  const reply = document.getElementById('kwReply').value.trim();
  const speechReply = document.getElementById('kwSpeechReply').value.trim() || null;
  if (!keywords.length || !reply) return;
  const kw = { keywords, reply };
  if (speechReply) kw.speechReply = speechReply;
  if (editingKeywordIndex >= 0) settings.keywords[editingKeywordIndex] = kw;
  else settings.keywords.push(kw);
  closeKwModal();
  renderKeywords();
}

// ── Save all ──────────────────────────────────────────────────
async function saveAll() {
  const btn = document.getElementById('saveBtn');

  // ✅ If server data hasn't loaded yet, wait up to 5 seconds
  if (!serverDataLoaded) {
    btn.textContent = 'Loading...';
    btn.disabled = true;
    let waited = 0;
    while (!serverDataLoaded && waited < 5000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
  }

  btn.textContent = 'Saving...';
  btn.disabled = true;

  await chrome.storage.local.set({ overlaySettings: settings });

  const stored = await chrome.storage.local.get(['sessionId']);
  if (stored.sessionId) {
    try {
      await fetch(`${SERVER_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: stored.sessionId,
          streamerInfo: settings.streamerInfo,
          quickReplies: settings.keywords,
          bot: settings.bot,
          overlayConfig: {
            overlay: settings.overlay,
            fonts: settings.fonts,
            animation: settings.animation,
            typewriter: settings.typewriter,
            messenger: settings.messenger,
            tts: settings.tts
          },
          features: settings.features,
          wl: settings.wl
        })
      });
    } catch {}
  }

  btn.textContent = 'Saved ✓';
  btn.classList.add('saved');
  showToast('✓ Settings saved!');
  setTimeout(() => { btn.textContent = 'Save All'; btn.classList.remove('saved'); btn.disabled = false; }, 2000);
}

// ── Win/Loss Settings ─────────────────────────────────────────
async function loadWLObsUrl() {
  const stored = await chrome.storage.local.get(['sessionId']);
  const el = document.getElementById('wlObsUrl');
  if (!el) return;
  if (stored.sessionId) {
    const url = `${SERVER_URL}/wl-overlay/${stored.sessionId}`;
    el.textContent = url;
    el.title = url;
  } else {
    el.textContent = 'Activate your license first';
  }
}

function updateWLPreview() {
  // Update the right-side preview phone with WL card
  // The WL preview is separate from the overlay preview
  // Just update the template card active states visually
}

function populateWLUI() {
  if (!settings.wl) return;
  document.querySelectorAll('.wl-tpl-card').forEach(c =>
    c.classList.toggle('active', c.dataset.wltpl === settings.wl.template));
  document.querySelectorAll('.wl-pos-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.wlpos === settings.wl.position));
  const wlEl = id => document.getElementById(id);
  if (wlEl('wlWinLabel')) wlEl('wlWinLabel').value = settings.wl.winLabel || 'WINS';
  if (wlEl('wlLossLabel')) wlEl('wlLossLabel').value = settings.wl.lossLabel || 'LOSSES';
  if (wlEl('wlTitle')) wlEl('wlTitle').value = settings.wl.title || '🎮 Stats';
  if (wlEl('wlSeparator')) wlEl('wlSeparator').value = settings.wl.separator || '—';
  if (wlEl('wlWinColor')) wlEl('wlWinColor').value = settings.wl.winColor || '#00e676';
  if (wlEl('wlLossColor')) wlEl('wlLossColor').value = settings.wl.lossColor || '#fe2c55';
  setRangeValue('wlBgOpacity', settings.wl.bgOpacity ?? 0.8, Math.round((settings.wl.bgOpacity ?? 0.8)*100)+'%', 'wlBgOpacityVal');
  setRangeValue('wlNumSize', settings.wl.numSize || 48, (settings.wl.numSize||48)+'px', 'wlNumSizeVal');
  setRangeValue('wlLabelSize', settings.wl.labelSize || 11, (settings.wl.labelSize||11)+'px', 'wlLabelSizeVal');
  setRangeValue('wlRadius', settings.wl.radius ?? 16, (settings.wl.radius??16)+'px', 'wlRadiusVal');
  if (wlEl('wlFont')) wlEl('wlFont').value = settings.wl.font || "'Segoe UI', sans-serif";
}
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
