const express     = require('express');
const cors        = require('cors');
const fetch       = require('node-fetch');
const multer      = require('multer');
const path        = require('path');
const pdfParse    = require('pdf-parse');
const rateLimit   = require('express-rate-limit');
const helmet      = require('helmet');
const dns         = require('dns').promises;
const net         = require('net');

const app    = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// ── CONFIG ──
const CFG = {
  PORT:            process.env.PORT || 3000,
  GROQ_KEY:        process.env.GROQ_KEY           || '',
  SERPER_KEY:      process.env.SERPER_KEY         || '',
  SUPABASE_URL:    process.env.SUPABASE_URL       || '',
  SUPABASE_KEY:    process.env.SUPABASE_KEY       || '',
  ELEVENLABS_KEY:  process.env.ELEVENLABS_API_KEY || '',
  API_SECRET:      process.env.API_SECRET         || '',         // shared secret (REQUIRED)
  ALLOWED_ORIGIN:  process.env.ALLOWED_ORIGIN     || 'https://jarvis.kartikdev.best',
  MAX_CTX_CHARS:   14000,
  MAX_HISTORY:     30,
  MAX_FILE_CHARS:  14000,
};

const MODELS = {
  CHAT:   'llama-3.3-70b-versatile',
  SMALL:  'llama-3.1-8b-instant',
  VISION: 'llama-3.2-90b-vision-preview', // verify current Groq vision model
};

// ── SECURITY MIDDLEWARE ──
app.use(helmet());
app.use(cors({ origin: CFG.ALLOWED_ORIGIN, methods: ['GET', 'POST', 'DELETE'] }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                         // 20 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a minute.' },
});

// Auth: every /api route (except health) needs the shared secret
function requireAuth(req, res, next) {
  if (!CFG.API_SECRET) return next(); // allow if no secret set (dev only — set one in prod!)
  const key = req.get('x-api-key');
  if (key !== CFG.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Generic error helper — never leak upstream details
function fail(res, code, clientMsg, internalErr) {
  if (internalErr) console.error('[ERROR]', internalErr?.message || internalErr);
  return res.status(code).json({ error: clientMsg });
}

// ══════════════════════════════════════════════════════
//  SYSTEM PROMPTS
// ══════════════════════════════════════════════════════
const JARVIS_CORE = `You are J.A.R.V.I.S — Kartik Yadav ka personal AI. Generic assistant nahi.

━━━ WHO YOU ARE ━━━
Tony Stark ka JARVIS + senior engineer + best friend jo sab jaanta hai.

Kartik ke baare mein:
• BCA 4th sem, AI & Data Analytics, LNCT Bhopal
• Built JARVIS (you), Telegram bot, Chrome extension for WhatsApp automation
• Runs CyberCafe143 in Bhopal
• Skills: JavaScript, Node.js, Express, Python, Java, ML basics
• GitHub: cybercafe143 | kartikdev.best
• Stock trading, gaming, AI mein interest hai
• Hinglish mein naturally baat karta hai

━━━ CASUAL HINGLISH EXAMPLES ━━━
User: "hlw" → "Bol yaar, kya scene hai?"
User: "kya chal raha hai" → "Tera code aur teri plans — dono pe nazar hai."
User: "gajab" → "Haan toh 😄"
User: "ok got it" → "Perfect. Aage bata."

━━━ CRITICAL RULES ━━━
1. "Sir" — MAX 1 baar per response. Natural nahi laga toh mat use karo.
2. End mein question MAT poocho. Jo poochha uska jawab do.
3. Casual/greeting → MAX 2 sentences.
4. Unsolicited suggestions band.
5. ZERO padding ("I'd be happy to help", "Great question!").
6. Seedha point pe aao. Pehla sentence = answer.
7. Match the energy.

━━━ QUALITY ━━━
• Har answer mein kuch naya
• Code: working, clean, edge cases
• Fact vs opinion distinguish karo`;

const JARVIS_SHORT = `You are JARVIS — Kartik ka personal AI. Sharp, direct, Hinglish natural.
Casual chat → MAX 2 sentences. Dost jaisa bol.
NEVER: "Sir sir sir", forced questions, suggestions, padding.
Examples: "hlw" → "Bol yaar 😄" | "ok" → "Done."`;

const TONES = {
  jarvis:   '',
  coder:    '\n\n[CODER MODE] Code quality pe focus. Production-ready. Proper language tags. Edge cases.',
  teacher:  '\n\n[TEACHER MODE] Step by step. Strong analogy. Hinglish freely.',
  brutal:   '\n\n[BRUTAL MODE] Zero sugarcoating. Galat hai toh seedha bol.',
  creative: '\n\n[CREATIVE MODE] Surprising, original. Risk lo.',
  friday:   '\n\n[FRIDAY MODE] Sharp, fast, sarcastic. Punchy.',
};

function buildSystemPrompt(complexity, tone, extraCtx = '') {
  const toneStr = TONES[tone] || '';
  const base = complexity === 'simple' ? JARVIS_SHORT : JARVIS_CORE;
  return base + toneStr + extraCtx;
}

// ══════════════════════════════════════════════════════
//  INTENT DETECTION (fixed length-shortcut bug)
// ══════════════════════════════════════════════════════
function detectIntent(message) {
  const m = (message || '').toLowerCase().trim();

  // Check explicit intents BEFORE the short-length shortcut
  if (/```/.test(m) || /\b(code|function|class|api|bug|error|fix|debug|script|python|javascript|java|node|react|sql|css|html|algorithm|array|loop|async|express|mongodb|leetcode|dsa)\b/.test(m))
    return { intent: 'code', needsSearch: false, complexity: 'deep', temp: 0.3 };

  if (/\b(sad|dukh|rone|hurt|alone|akela|depressed|anxious|stressed|heartbreak|breakup|gussa|frustrated)\b/.test(m))
    return { intent: 'emotional', needsSearch: false, complexity: 'simple', temp: 0.85 };

  if (/^(hi|hello|hey|hii|hlo|hlw|hanji|haan|nahi|ok|okay|hmm|hm|thanks|shukriya|accha|theek|thik|nice|good|great|wow|yaar|bhai|yrr|bro|sup|namaste|lol|haha|xd|got it|ahhh|ohh|gg|gajab|sahi|mast)[\s!?.,😂🔥]*$/.test(m))
    return { intent: 'casual', needsSearch: false, complexity: 'simple', temp: 0.85 };

  if (/^(aur|or |phir|next|uske baad|matlab|means|explain more|aur batao|elaborate|example do|what about|what if|lekin|but |why not|how about)/.test(m))
    return { intent: 'followup', needsSearch: false, complexity: 'standard', temp: 0.7 };

  if (/(\d[\+\-\*\/\^]\d|solve|calculate|equation|formula|integral|probability|statistics|percentage|mean|median|regression)/.test(m))
    return { intent: 'math', needsSearch: false, complexity: 'deep', temp: 0.1 };

  if (/(latest|recent|new|today|abhi|current|2024|2025|2026|aaj|news|khabar|update|weather|price|kitna hai|rate|score|match|ipl|cricket|stock|bitcoin|crypto|movie|release|networth|net worth)/.test(m))
    return { intent: 'realtime', needsSearch: true, complexity: 'standard', temp: 0.6 };

  // Site analysis only on explicit request (avoids matching node.js / react.dev in prose)
  if (/\b(analyze|review|check|dekho|analyse)\b.{0,40}([a-z0-9-]+\.(com|in|net|org|io|store|shop|xyz|dev|tech|online))/i.test(m))
    return { intent: 'site_analysis', needsSearch: true, complexity: 'deep', temp: 0.5 };

  if (/\b(explain|analyze|compare|difference|pros.*cons|why does|how does|architecture|in detail|research|machine learning|neural|deep learning|system design|roadmap)\b/.test(m))
    return { intent: 'analysis', needsSearch: false, complexity: 'deep', temp: 0.55 };

  if (/\b(write|draft|story|poem|script|email|letter|proposal|brainstorm|ideas|creative|likho|banner|caption|post|tweet)\b/.test(m))
    return { intent: 'creative', needsSearch: false, complexity: 'creative', temp: 0.95 };

  if (/\b(job|career|internship|resume|interview|salary|placement|skill|learn|course|bca|mca|startup|freelance)\b/.test(m))
    return { intent: 'career', needsSearch: false, complexity: 'standard', temp: 0.65 };

  // Short greeting fallback only AFTER specific intents
  if (m.length < 15)
    return { intent: 'casual', needsSearch: false, complexity: 'simple', temp: 0.85 };

  return { intent: 'general', needsSearch: m.length > 40, complexity: 'standard', temp: 0.7 };
}

function getIntentInjection(intent) {
  const map = {
    emotional:     'User emotional share kar raha hai. Pehle feel acknowledge karo, advice sirf agar pooche.',
    casual:        'CASUAL CHAT. 1-2 sentences MAX. Dost jaisa. Koi suggestions, koi essay nahi.',
    followup:      'FOLLOW-UP. Cover ho chuka dobara mat batao. Directly build karo.',
    code:          'CODE TASK. Working code pehle. Proper language tags. Edge cases end mein.',
    math:          'MATH. Step by step. Formula pehle, phir numbers. Final answer bold.',
    analysis:      'DEEP ANALYSIS. Clear structure. Non-obvious insight zaroori.',
    realtime:      'REAL-TIME INFO. Search data neeche. Synthesize karo, list mat karo.',
    site_analysis: 'SITE ANALYSIS. Name, services, pricing, contact, social, hours. Clear sections.',
    creative:      'CREATIVE. Surprising, specific. Clichés avoid.',
    career:        'CAREER. Kartik specific — BCA, Bhopal, projects. Generic nahi.',
    general:       'Focused answer. Ek naya insight include karo.',
  };
  return map[intent] || map.general;
}

function pickModel(complexity) {
  const t = { simple: 500, standard: 1500, deep: 2800, creative: 2200 };
  return { model: MODELS.CHAT, maxTokens: t[complexity] || 1500 };
}

// ── Groq stream with 429 retry ──
async function callGroqStream(model, messages, maxTokens, temperature) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.GROQ_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true }),
    });
    if (gr.ok) return gr;
    const err = await gr.json().catch(() => ({}));
    if (gr.status === 429) {
      const wait = parseFloat(err.error?.message?.match(/try again in ([\d.]+)s/i)?.[1]) || (attempt + 1) * 15;
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`Groq HTTP ${gr.status}`);
  }
  throw new Error('Rate limited');
}

// ══════════════════════════════════════════════════════
//  CONTEXT + INPUT VALIDATION
// ══════════════════════════════════════════════════════
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-100); // hard cap before windowing
}

function buildContextWindow(history, maxMessages = CFG.MAX_HISTORY, maxChars = CFG.MAX_CTX_CHARS) {
  const valid = sanitizeHistory(history);
  if (!valid.length) return [];
  const anchor = valid.slice(0, 2);
  const recent = valid.slice(-maxMessages);
  const merged = [...anchor, ...recent.filter(m => !anchor.includes(m))];
  let total = merged.reduce((s, m) => s + m.content.length, 0);
  let i = 2;
  while (total > maxChars && i < merged.length) { total -= merged[i].content.length; merged.splice(i, 1); }
  return merged;
}

// ══════════════════════════════════════════════════════
//  SESSION SUMMARY + MEMORY
// ══════════════════════════════════════════════════════
const summaryCache = new Map();
async function summarizeSession(history, chatId = 'default') {
  if (!CFG.GROQ_KEY || history.length < 10) return '';
  const cached = summaryCache.get(chatId);
  if (cached && history.length - cached.msgCount < 6) return cached.summary;
  try {
    const sample = history.slice(-16).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.GROQ_KEY}` },
      body: JSON.stringify({
        model: MODELS.SMALL,
        messages: [
          { role: 'system', content: 'Summarize in 3-4 bullets: topics, decisions, code, problems solved. Output only bullets.' },
          { role: 'user', content: sample },
        ],
        max_tokens: 180, temperature: 0.2,
      }),
    });
    const d = await res.json();
    const summary = d.choices?.[0]?.message?.content || '';
    summaryCache.set(chatId, { summary, msgCount: history.length });
    return summary;
  } catch { return ''; }
}

async function getMemories(userId = 'kartik', limit = 6) {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) return [];
  try {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`, {
      headers: { apikey: CFG.SUPABASE_KEY, Authorization: `Bearer ${CFG.SUPABASE_KEY}` },
    });
    return await res.json();
  } catch { return []; }
}

async function saveMemory(userId = 'kartik', content, summary) {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) return;
  try {
    await fetch(`${CFG.SUPABASE_URL}/rest/v1/memories`, {
      method: 'POST',
      headers: { apikey: CFG.SUPABASE_KEY, Authorization: `Bearer ${CFG.SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, content, summary, created_at: new Date().toISOString() }),
    });
  } catch {}
}

async function extractMemory(history) {
  if (!CFG.GROQ_KEY || history.length < 4) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.GROQ_KEY}` },
      body: JSON.stringify({
        model: MODELS.SMALL,
        messages: [
          { role: 'system', content: 'Extract 1-2 specific facts worth remembering. Start with "User". Only output facts. If nothing, output nothing.' },
          { role: 'user', content: history.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n') },
        ],
        max_tokens: 100, temperature: 0.1,
      }),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════
//  WEB SEARCH + SSRF-SAFE SITE FETCH
// ══════════════════════════════════════════════════════
async function webSearch(query) {
  if (CFG.SERPER_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': CFG.SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 8, gl: 'in', hl: 'en' }),
      });
      const d = await res.json();
      const results = [];
      if (d.answerBox?.answer || d.answerBox?.snippet)
        results.push({ title: 'Direct Answer', snippet: d.answerBox.answer || d.answerBox.snippet, url: d.answerBox.link || '' });
      if (d.knowledgeGraph?.description)
        results.push({ title: d.knowledgeGraph.title, snippet: d.knowledgeGraph.description, url: d.knowledgeGraph.descriptionLink || '' });
      (d.organic || []).slice(0, 5).forEach(r => results.push({ title: r.title, snippet: r.snippet || '', url: r.link }));
      return results.slice(0, 7);
    } catch {}
  }
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d = await res.json();
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading, snippet: d.AbstractText, url: d.AbstractURL });
    (d.RelatedTopics || []).slice(0, 4).forEach(t => { if (t.Text) results.push({ title: t.Text.slice(0, 60), snippet: t.Text, url: t.FirstURL || '' }); });
    return results;
  } catch { return []; }
}

function extractSiteUrl(query) {
  const m = query.match(/([a-zA-Z0-9-]+\.(com|in|net|org|co\.in|io|me|store|shop|xyz|dev|tech|online))/i);
  return m ? m[0] : null;
}

// Block private/reserved IP ranges to prevent SSRF
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) ||  // cloud metadata
      p[0] === 0
    );
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    return lo === '::1' || lo.startsWith('fc') || lo.startsWith('fd') || lo.startsWith('fe80') || lo.startsWith('::ffff:');
  }
  return true; // unknown → block
}

async function fetchSiteContent(rawUrl) {
  try {
    let url = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    // Resolve host and reject private IPs (SSRF guard)
    const { address } = await dns.lookup(parsed.hostname);
    if (isPrivateIp(address)) return null;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JarvisBot/1.0)' },
      timeout: 10000,
      size: 5 * 1024 * 1024, // cap response to 5MB
      redirect: 'manual',    // don't auto-follow redirects to internal hosts
    });
    if (!res.ok) return null;
    return (await res.text())
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 8000);
  } catch { return null; }
}

// ══════════════════════════════════════════════════════
//  HEALTH (no auth)
// ══════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'JARVIS Online ⚡', version: '4.4' }));
app.get('/api/health', (req, res) => res.json({
  status: 'ok', version: '4.4',
  groq: !!CFG.GROQ_KEY, serper: !!CFG.SERPER_KEY, memory: !!CFG.SUPABASE_URL, elevenlabs: !!CFG.ELEVENLABS_KEY,
}));

// Apply auth + rate limit to everything below
app.use('/api', limiter, requireAuth);

// ══════════════════════════════════════════════════════
//  MEMORY ROUTES
// ══════════════════════════════════════════════════════
app.get('/api/memory', async (req, res) => res.json({ memories: await getMemories() }));
app.delete('/api/memory/:id', async (req, res) => {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) return res.json({ success: false });
  if (!/^[0-9a-f-]+$/i.test(req.params.id)) return fail(res, 400, 'Invalid id');
  try {
    await fetch(`${CFG.SUPABASE_URL}/rest/v1/memories?id=eq.${req.params.id}`, {
      method: 'DELETE', headers: { apikey: CFG.SUPABASE_KEY, Authorization: `Bearer ${CFG.SUPABASE_KEY}` },
    });
    res.json({ success: true });
  } catch (e) { return fail(res, 500, 'Delete failed', e); }
});

// ══════════════════════════════════════════════════════
//  MAIN CHAT — SSE STREAMING
// ══════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { message, history = [], tone = 'jarvis', hinglish = false, searchEnabled = true, chatId = 'default' } = req.body;
  if (typeof message !== 'string' || !message.trim()) return fail(res, 400, 'Message is empty');
  if (message.length > 8000) return fail(res, 400, 'Message too long');

  const detected = detectIntent(message);
  const { model, maxTokens } = pickModel(detected.complexity);
  const contextHistory = buildContextWindow(history);

  // Parallelize memory + summary (was sequential = slow)
  const needsSummary = sanitizeHistory(history).length > 10;
  const [memories, summary] = await Promise.all([
    getMemories('kartik', 6),
    needsSummary ? summarizeSession(sanitizeHistory(history), chatId) : Promise.resolve(''),
  ]);

  let sessCtx = summary ? '\n\n━━━ CONVERSATION SO FAR ━━━\n' + summary : '';
  let memCtx = memories.length
    ? '\n\n━━━ LONG-TERM MEMORY ━━━\n' + memories.map(m => '• ' + (m.summary || m.content)).filter(Boolean).join('\n')
    : '';

  const hinglishCtx = hinglish ? '\n\nHinglish mode — Hindi+English mix freely.' : '';
  const intentCtx = `\n\n━━━ CURRENT TASK ━━━\n${getIntentInjection(detected.intent)}`;

  let searchCtx = '', searchUsed = false, sources = [], siteAnalyzed = null;
  if (searchEnabled && detected.needsSearch) {
    const siteUrl = detected.intent === 'site_analysis' ? extractSiteUrl(message) : null;
    if (siteUrl) {
      const content = await fetchSiteContent(siteUrl);
      if (content) { searchCtx = `\n\n━━━ SITE: ${siteUrl} ━━━\n${content}`; siteAnalyzed = siteUrl; searchUsed = true; }
    }
    if (!searchCtx) {
      const results = await webSearch(message);
      if (results.length) {
        searchCtx = '\n\n━━━ WEB SEARCH ━━━\n' + results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
        sources = results; searchUsed = true;
      }
    }
  }

  const extraCtx = detected.complexity === 'simple'
    ? (hinglishCtx + intentCtx)
    : (memCtx + sessCtx + hinglishCtx + searchCtx + intentCtx);
  const systemPrompt = buildSystemPrompt(detected.complexity, tone, extraCtx);
  const messages = [{ role: 'system', content: systemPrompt }, ...contextHistory, { role: 'user', content: message }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`data: ${JSON.stringify({ type: 'meta', intent: detected.intent, model, searchUsed, siteAnalyzed, sources })}\n\n`);

  try {
    const gr = await callGroqStream(model, messages, maxTokens, detected.temp);
    let fullReply = '', doneSent = false;

    gr.body.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const d = line.slice(6);
        if (d === '[DONE]') { if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); } return; }
        try {
          const t = JSON.parse(d).choices?.[0]?.delta?.content;
          if (t) { fullReply += t; res.write(`data: ${JSON.stringify({ type: 'token', token: t })}\n\n`); }
        } catch {}
      }
    });

    gr.body.on('end', () => {
      if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); }
      res.end();
      const updHist = [...contextHistory, { role: 'user', content: message }, { role: 'assistant', content: fullReply }];
      extractMemory(updHist).then(fact => { if (fact) saveMemory('kartik', message, fact); });
    });

    gr.body.on('error', () => { if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); } res.end(); });
  } catch (e) {
    console.error('[CHAT]', e.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI service unavailable. Retry shortly.' })}\n\n`);
    res.end();
  }
});

// ══════════════════════════════════════════════════════
//  ELEVENLABS TTS
// ══════════════════════════════════════════════════════
const VOICE_ID = 'iP95p4xoKVk53GoZ742B';

function cleanForTTS(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, 'Here is the code.')
    .replace(/`[^`]+`/g, '').replace(/#{1,6}\s/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[-*+]\s/g, '')
    .replace(/━+/g, '').trim().slice(0, 1200);
}

app.post('/api/speak', async (req, res) => {
  if (!CFG.ELEVENLABS_KEY) return fail(res, 400, 'TTS not configured');
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'No text');
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': CFG.ELEVENLABS_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: cleanForTTS(text),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.35, similarity_boost: 0.85, style: 0.45, use_speaker_boost: true },
      }),
    });
    if (!response.ok) return fail(res, 502, 'TTS failed', await response.text());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    response.body.pipe(res);
  } catch (e) { return fail(res, 500, 'TTS error', e); }
});

// ══════════════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════════════
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const instruction = String(req.body.instruction || 'Analyze this file').slice(0, 2000);
    const tone = String(req.body.tone || 'jarvis');
    if (!req.file) return fail(res, 400, 'No file');
    const { originalname: filename, mimetype, buffer } = req.file;
    let fileContent = '';

    if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      try { const pdf = await pdfParse(buffer); fileContent = `[PDF — ${pdf.numpages} pages]\n\n${pdf.text}`; }
      catch { fileContent = '[PDF extraction failed]'; }
    } else if (mimetype.startsWith('image/')) {
      const b64 = buffer.toString('base64');
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.GROQ_KEY}` },
        body: JSON.stringify({
          model: MODELS.VISION,
          messages: [
            { role: 'system', content: buildSystemPrompt('standard', tone) },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } }, { type: 'text', text: instruction }] },
          ], max_tokens: 1500,
        }),
      });
      if (!vRes.ok) return fail(res, 502, 'Vision analysis failed', await vRes.text());
      const vData = await vRes.json();
      return res.json({ reply: vData.choices[0].message.content, fileType: 'image' });
    } else {
      fileContent = buffer.toString('utf-8');
    }

    if (fileContent.length > CFG.MAX_FILE_CHARS) fileContent = fileContent.slice(0, CFG.MAX_FILE_CHARS) + '\n\n[truncated]';
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.GROQ_KEY}` },
      body: JSON.stringify({
        model: MODELS.CHAT,
        messages: [
          { role: 'system', content: buildSystemPrompt('deep', tone) },
          { role: 'user', content: `File: **${filename}**\n\`\`\`\n${fileContent}\n\`\`\`\n\nInstruction: ${instruction}` },
        ],
        max_tokens: 2500, temperature: 0.4,
      }),
    });
    if (!groqRes.ok) return fail(res, 502, 'File analysis failed', await groqRes.text());
    const data = await groqRes.json();
    res.json({ reply: data.choices[0].message.content, fileType: 'file' });
  } catch (e) { return fail(res, 500, 'Upload failed', e); }
});

// ❌ /api/execute REMOVED — was a remote code execution vulnerability.
// If you need code execution, run it client-side in a sandboxed iframe, or
// use a dedicated isolated runtime (isolated-vm / a separate hardened container).

app.listen(CFG.PORT, () => console.log(`⚡ JARVIS v4.4 — Port ${CFG.PORT}`));
