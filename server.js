const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const multer   = require('multer');
const path     = require('path');
const pdfParse = require('pdf-parse');

const app    = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ──
const GROQ_KEY        = process.env.GROQ_KEY           || '';
const SERPER_KEY      = process.env.SERPER_KEY         || '';
const SUPABASE_URL    = process.env.SUPABASE_URL       || '';
const SUPABASE_KEY    = process.env.SUPABASE_KEY       || '';
const ELEVENLABS_KEY  = process.env.ELEVENLABS_API_KEY || '';

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
• Hinglish mein naturally baat karta hai — gali galoch bhi normal hai dost ki tarah

━━━ CASUAL HINGLISH EXAMPLES — YE STYLE FOLLOW KAR ━━━
User: "hlw" → JARVIS: "Bol yaar, kya scene hai?"
User: "bsdkk m hi hu" → JARVIS: "Haha khud se hi interview lene aaye? 😂"
User: "kya chal raha hai" → JARVIS: "Tera code aur teri plans — dono pe nazar hai."
User: "gajab" → JARVIS: "Haan toh 😄"
User: "tuu bta" → JARVIS: "Stock trade karta hai, cafe chalata hai, AI banata hai — overachiever hai yaar."
User: "ok got it" → JARVIS: "Perfect. Aage bata."

━━━ CRITICAL RULES — FOLLOW EXACTLY ━━━
1. "Sir" — MAXIMUM 1 baar per response. Natural nahi laga toh use hi mat karo.
2. Har message ke end mein question MAT poocho. Jo poochha uska jawab do, bas.
3. Casual/greeting → MAX 2 sentences. "hlw", "ok", "wow" → 1-2 line sirf.
4. Unsolicited suggestions band. WhatsApp poochha nahi → WhatsApp suggest mat karo.
5. ZERO padding:
   ❌ "I'd be happy to help"
   ❌ "That's a great question!"  
   ❌ "As your personal AI..."
6. Seedha point pe aao. Pehla sentence = answer.
7. Match the energy: casual pe casual, serious pe serious.

━━━ QUALITY ━━━
• Har answer mein kuch naya hona chahiye
• Code tasks: working, clean, edge cases
• Fact vs opinion distinguish karo`;

// Short prompt for casual — saves ~800 tokens
const JARVIS_SHORT = `You are JARVIS — Kartik ka personal AI. Sharp, direct, Hinglish natural.
Casual chat → MAX 2 sentences. Dost jaisa bol — "yaar", "bhai", sab theek hai.
NEVER: "Sir sir sir", forced questions, suggestions, padding.
Examples: "hlw" → "Bol yaar 😄" | "kya chal raha" → "Tera kaam, tera JARVIS — dono chal rahe hain." | "ok" → "Done."`;

const TONES = {
  jarvis:   '',
  coder:    '\n\n[CODER MODE] Code quality pe focus. Production-ready. Proper language tags. Edge cases.',
  teacher:  '\n\n[TEACHER MODE] Step by step. Strong analogy. Hinglish freely. Patience.',
  brutal:   '\n\n[BRUTAL MODE] Zero sugarcoating. Galat hai toh seedha bol. Senior dev code review style.',
  creative: '\n\n[CREATIVE MODE] Surprising, original. Generic nahi. Risk lo.',
  friday:   '\n\n[FRIDAY MODE] Sharp, fast, sarcastic. Punchy. Hinglish natural.',
};

function buildSystemPrompt(complexity, tone, extraCtx = '') {
  const toneStr = TONES[tone] || '';
  if (complexity === 'simple') {
    return JARVIS_SHORT + toneStr + extraCtx;
  }
  return JARVIS_CORE + toneStr + extraCtx;
}

// ══════════════════════════════════════════════════════
//  INTENT DETECTION
// ══════════════════════════════════════════════════════
function detectIntent(message, history = []) {
  const m = message.toLowerCase().trim();

  if (/\b(sad|dukh|rone|hurt|alone|akela|depressed|anxious|stressed|heartbreak|breakup|gussa|frustrated)\b/.test(m))
    return { intent: 'emotional',     needsSearch: false, complexity: 'simple',   temp: 0.85 };

  if (/^(hi|hello|hey|hii|hlo|hlw|hanji|haan|nahi|ok|okay|hmm|hm|thanks|shukriya|accha|theek|thik|nice|good|great|wow|yaar|bhai|yrr|bro|sup|namaste|lol|haha|xd|got it|ahhh|ohh|bsdkk|bc|mc|gg|gajab|sahi|mast)[\s!?.,😂🔥]*$/.test(m) || m.length < 15)
    return { intent: 'casual',        needsSearch: false, complexity: 'simple',   temp: 0.85 };

  if (/^(aur|or |phir|next|uske baad|matlab|means|explain more|aur batao|elaborate|example do|what about|what if|lekin|but |why not|how about)/.test(m))
    return { intent: 'followup',      needsSearch: false, complexity: 'standard', temp: 0.7 };

  if (/([a-zA-Z0-9-]+\.(com|in|net|org|co\.in|io|pk|me|store|shop|xyz|dev|tech|online))/.test(m))
    return { intent: 'site_analysis', needsSearch: true,  complexity: 'deep',    temp: 0.5 };

  if (/\b(code|function|class|api|bug|error|fix|debug|script|python|javascript|java|node|react|sql|css|html|algorithm|logic|array|loop|async|express|mongodb|leetcode|dsa)\b/.test(m) || /```/.test(m))
    return { intent: 'code',          needsSearch: false, complexity: 'deep',    temp: 0.3 };

  if (/(\d[\+\-\*\/\^]\d|solve|calculate|equation|formula|integral|probability|statistics|percentage|mean|median|regression)/.test(m))
    return { intent: 'math',          needsSearch: false, complexity: 'deep',    temp: 0.1 };

  if (/(latest|recent|new|today|abhi|current|2024|2025|2026|aaj|news|khabar|update|weather|price|kitna hai|rate|score|match|ipl|cricket|stock|bitcoin|crypto|movie|release|networth|net worth)/.test(m))
    return { intent: 'realtime',      needsSearch: true,  complexity: 'standard', temp: 0.6 };

  if (/\b(explain|analyze|compare|difference|pros.*cons|why does|how does|architecture|in detail|research|comprehensive|machine learning|neural|deep learning|system design|roadmap)\b/.test(m))
    return { intent: 'analysis',      needsSearch: false, complexity: 'deep',    temp: 0.55 };

  if (/\b(write|draft|story|poem|script|email|letter|proposal|brainstorm|ideas|creative|likho|banner|caption|post|tweet)\b/.test(m))
    return { intent: 'creative',      needsSearch: false, complexity: 'creative', temp: 0.95 };

  if (/\b(job|career|internship|resume|interview|salary|placement|skill|learn|course|bca|mca|startup|freelance)\b/.test(m))
    return { intent: 'career',        needsSearch: false, complexity: 'standard', temp: 0.65 };

  return { intent: 'general', needsSearch: m.length > 40, complexity: 'standard', temp: 0.7 };
}

function getIntentInjection(intent) {
  const map = {
    emotional:     'User kuch emotional share kar raha hai. Pehle feel acknowledge karo, advice sirf agar pooche.',
    casual:        'CASUAL CHAT. 1-2 sentences MAX. Dost jaisa natural reply. Koi suggestions, koi essay nahi.',
    followup:      'FOLLOW-UP. Jo cover ho chuka hai dobara mat batao. Directly build karo.',
    code:          'CODE TASK. Working code pehle. Proper language tags. Key decisions briefly. Edge cases end mein.',
    math:          'MATH. Step by step. Formula pehle, phir numbers. Final answer bold karo.',
    analysis:      'DEEP ANALYSIS. Clear structure. Comprehensive but filler nahi. Non-obvious insight zaroori.',
    realtime:      'REAL-TIME INFO. Search data neeche hai. Synthesize karo, list mat karo. Important info pehle.',
    site_analysis: 'SITE ANALYSIS. Sab extract karo: name, services, pricing, contact, social, hours. Clear sections.',
    creative:      'CREATIVE. Surprising, specific. Clichés avoid karo.',
    career:        'CAREER. Kartik specific — BCA, Bhopal, uske projects. Generic nahi.',
    general:       'Focused answer. Ek naya insight include karo.',
  };
  return map[intent] || map.general;
}

function pickModel(complexity) {
  return {
    simple:   { model: 'llama-3.3-70b-versatile', maxTokens: 500  },
    standard: { model: 'llama-3.3-70b-versatile', maxTokens: 1500 },
    deep:     { model: 'llama-3.3-70b-versatile', maxTokens: 2800 },
    creative: { model: 'llama-3.3-70b-versatile', maxTokens: 2200 },
  }[complexity] || { model: 'llama-3.3-70b-versatile', maxTokens: 1500 };
}

// ── Groq call with 429 auto-retry ──
async function callGroqStream(model, messages, maxTokens, temperature) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true })
    });
    if (gr.ok) return gr;
    const err = await gr.json();
    if (gr.status === 429) {
      const wait = (err.error?.message?.match(/try again in ([\d.]+)s/i)?.[1] || (attempt + 1) * 15);
      console.log(`[Groq] Rate limit, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, parseFloat(wait) * 1000));
      continue;
    }
    throw new Error(err.error?.message || `HTTP ${gr.status}`);
  }
  throw new Error('Rate limit — wait 1 minute and retry.');
}

// ══════════════════════════════════════════════════════
//  CONTEXT WINDOW
// ══════════════════════════════════════════════════════
function buildContextWindow(history, maxMessages = 30, maxChars = 12000) {
  const valid = (history || []).filter(m => m?.role && m?.content?.trim());
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
//  SESSION SUMMARIZER (cached)
// ══════════════════════════════════════════════════════
const summaryCache = new Map();
async function summarizeSession(history, chatId = 'default') {
  if (!GROQ_KEY || history.length < 10) return '';
  const cached = summaryCache.get(chatId);
  if (cached && history.length - cached.msgCount < 6) return cached.summary;
  try {
    const sample = history.slice(-16).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Summarize in 3-4 bullet points: topics covered, decisions, code written, problems solved. Output only bullets.' },
          { role: 'user', content: sample }
        ],
        max_tokens: 180, temperature: 0.2
      })
    });
    const d = await res.json();
    const summary = d.choices?.[0]?.message?.content || '';
    summaryCache.set(chatId, { summary, msgCount: history.length });
    return summary;
  } catch (e) { return ''; }
}

// ══════════════════════════════════════════════════════
//  MEMORY (Supabase)
// ══════════════════════════════════════════════════════
async function getMemories(userId = 'kartik', limit = 8) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return await res.json();
  } catch (e) { return []; }
}

async function saveMemory(userId = 'kartik', content, summary) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, content, summary, created_at: new Date().toISOString() })
    });
  } catch (e) {}
}

async function extractMemory(history) {
  if (!GROQ_KEY || history.length < 4) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Extract 1-2 specific facts worth remembering. Good: "User building dairy app", "Fixed node-fetch by downgrading". Bad: "User said hello". Start with "User". Only output facts. If nothing worth saving, output nothing.' },
          { role: 'user', content: history.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n') }
        ],
        max_tokens: 100, temperature: 0.1
      })
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { return null; }
}

app.get('/api/memory', async (req, res) => res.json({ memories: await getMemories() }));
app.delete('/api/memory/:id', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json({ success: false });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${req.params.id}`, {
      method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

// ══════════════════════════════════════════════════════
//  WEB SEARCH
// ══════════════════════════════════════════════════════
async function webSearch(query) {
  if (SERPER_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 8, gl: 'in', hl: 'en' })
      });
      const d = await res.json();
      const results = [];
      if (d.answerBox?.answer || d.answerBox?.snippet)
        results.push({ title: 'Direct Answer', snippet: d.answerBox.answer || d.answerBox.snippet, url: d.answerBox.link || '' });
      if (d.knowledgeGraph?.description)
        results.push({ title: d.knowledgeGraph.title, snippet: d.knowledgeGraph.description, url: d.knowledgeGraph.descriptionLink || '' });
      (d.organic || []).slice(0, 5).forEach(r => results.push({ title: r.title, snippet: r.snippet || '', url: r.link }));
      return results.slice(0, 7);
    } catch (e) {}
  }
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d = await res.json();
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading, snippet: d.AbstractText, url: d.AbstractURL });
    (d.RelatedTopics || []).slice(0, 4).forEach(t => { if (t.Text) results.push({ title: t.Text.slice(0, 60), snippet: t.Text, url: t.FirstURL || '' }); });
    return results;
  } catch (e) { return []; }
}

function extractSiteUrl(query) {
  const m = query.match(/([a-zA-Z0-9-]+\.(com|in|net|org|co\.in|io|pk|me|store|shop|xyz|dev|tech|online))/i);
  return m ? m[0] : null;
}

async function fetchSiteContent(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
      timeout: 10000
    });
    if (!res.ok) return null;
    return (await res.text())
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 8000);
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════
app.get('/',          (req, res) => res.json({ status: 'JARVIS Online ⚡', version: '4.3' }));
app.get('/api/health',(req, res) => res.json({
  status: 'ok', version: '4.3',
  groq: !!GROQ_KEY, serper: !!SERPER_KEY, memory: !!SUPABASE_URL, elevenlabs: !!ELEVENLABS_KEY
}));

// ══════════════════════════════════════════════════════
//  MAIN CHAT — SSE STREAMING
// ══════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { message, history = [], tone = 'jarvis', hinglish = false, searchEnabled = true, chatId = 'default' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is empty' });

  const detected = detectIntent(message, history);
  const { model, maxTokens } = pickModel(detected.complexity);
  const contextHistory = buildContextWindow(history, 30, 14000);

  // Session summary (cached, only if long convo)
  let sessCtx = '';
  if (history.length > 10) {
    const summary = await summarizeSession(history, chatId);
    if (summary) sessCtx = '\n\n━━━ THIS CONVERSATION SO FAR ━━━\n' + summary;
  }

  // Long-term memory
  const memories = await getMemories('kartik', 6);
  let memCtx = '';
  if (memories.length > 0) {
    memCtx = '\n\n━━━ LONG-TERM MEMORY ━━━\n' + memories.map(m => '• ' + (m.summary || m.content)).filter(Boolean).join('\n');
  }

  const hinglishCtx = hinglish ? '\n\nHinglish mode — Hindi+English mix freely jaise Bhopal developer baat karta hai.' : '';
  const intentCtx   = `\n\n━━━ CURRENT TASK ━━━\n${getIntentInjection(detected.intent)}`;

  // Web search / site fetch
  let searchCtx = '', searchUsed = false, sources = [], siteAnalyzed = null;
  if (searchEnabled && detected.needsSearch) {
    const siteUrl = extractSiteUrl(message);
    if (siteUrl) {
      const content = await fetchSiteContent(siteUrl);
      if (content) { searchCtx = `\n\n━━━ SITE: ${siteUrl} ━━━\n${content}`; siteAnalyzed = siteUrl; searchUsed = true; }
    }
    if (!searchCtx) {
      const results = await webSearch(message);
      if (results.length > 0) {
        searchCtx = '\n\n━━━ WEB SEARCH ━━━\n' + results.map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
        sources = results; searchUsed = true;
      }
    }
  }

  // ★ TIERED PROMPT — simple queries get short prompt (saves ~800 tokens) ★
  const extraCtx = detected.complexity === 'simple'
    ? (hinglishCtx + intentCtx)
    : (memCtx + sessCtx + hinglishCtx + searchCtx + intentCtx);
  const systemPrompt = buildSystemPrompt(detected.complexity, tone, extraCtx);
  const messages = [{ role: 'system', content: systemPrompt }, ...contextHistory, { role: 'user', content: message }];

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`data: ${JSON.stringify({ type: 'meta', intent: detected.intent, model, searchUsed, siteAnalyzed, sources })}\n\n`);

  try {
    // ★ Uses callGroqStream with auto-retry on 429 ★
    const gr = await callGroqStream(model, messages, maxTokens, detected.temp);
    let fullReply = '';
    let doneSent  = false; // prevents duplicate done events

    gr.body.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const d = line.slice(6);
        if (d === '[DONE]') {
          if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); }
          return;
        }
        try {
          const p = JSON.parse(d);
          const t = p.choices?.[0]?.delta?.content;
          if (t) { fullReply += t; res.write(`data: ${JSON.stringify({ type: 'token', token: t })}\n\n`); }
        } catch (e) {}
      }
    });

    gr.body.on('end', () => {
      if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); }
      res.end();
      // Background memory extraction
      const updHist = [...contextHistory, { role: 'user', content: message }, { role: 'assistant', content: fullReply }];
      extractMemory(updHist).then(fact => { if (fact) saveMemory('kartik', message, fact); });
    });

    gr.body.on('error', () => {
      if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); }
      res.end();
    });

  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
    res.end();
  }
});

// ══════════════════════════════════════════════════════
//  ELEVENLABS TTS
// ══════════════════════════════════════════════════════
const VOICE_ID = 'iP95p4xoKVk53GoZ742B'; // Liam — natural male

function cleanForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, 'Here is the code.')
    .replace(/`[^`]+`/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[-*+]\s/g, '')
    .replace(/━+/g, '')
    .trim()
    .slice(0, 1200);
}

app.post('/api/speak', async (req, res) => {
  if (!ELEVENLABS_KEY) return res.status(400).json({ error: 'No ElevenLabs key' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });

  const cleaned = cleanForTTS(text);
  console.log('[TTS]', cleaned.slice(0, 60));

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleaned,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.85,
          style: 0.45,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[ElevenLabs]', response.status, err);
      return res.status(500).json({ error: `ElevenLabs: ${err}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    response.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════════════
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { instruction = 'Analyze this file thoroughly', tone = 'jarvis' } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { originalname: filename, mimetype, buffer } = req.file;
    let fileContent = '';

    if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      try { const pdf = await pdfParse(buffer); fileContent = `[PDF — ${pdf.numpages} pages]\n\n${pdf.text}`; }
      catch (e) { fileContent = '[PDF extraction failed]'; }
    } else if (mimetype.startsWith('image/')) {
      const b64 = buffer.toString('base64');
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.2-11b-vision-preview',
          messages: [
            { role: 'system', content: buildSystemPrompt('standard', tone) },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } }, { type: 'text', text: instruction }] }
          ], max_tokens: 1500
        })
      });
      if (!vRes.ok) { const e = await vRes.json(); throw new Error(e.error?.message); }
      const vData = await vRes.json();
      return res.json({ reply: vData.choices[0].message.content, fileType: 'image' });
    } else {
      fileContent = buffer.toString('utf-8');
    }

    if (fileContent.length > 14000) fileContent = fileContent.slice(0, 14000) + '\n\n[truncated]';
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: buildSystemPrompt('deep', tone) },
          { role: 'user', content: `File: **${filename}**\n\`\`\`\n${fileContent}\n\`\`\`\n\nInstruction: ${instruction}` }
        ],
        max_tokens: 2500, temperature: 0.4
      })
    });
    if (!groqRes.ok) { const e = await groqRes.json(); throw new Error(e.error?.message); }
    const data = await groqRes.json();
    res.json({ reply: data.choices[0].message.content, fileType: 'file' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  CODE EXECUTE (JS sandbox)
// ══════════════════════════════════════════════════════
app.post('/api/execute', (req, res) => {
  const { code, language = 'javascript' } = req.body;
  if (language !== 'javascript') return res.json({ output: `// ${language} can't run here. Run locally.` });
  let output = '';
  const con = { log: (...a) => output += a.join(' ') + '\n', error: (...a) => output += 'ERROR: ' + a.join(' ') + '\n', warn: (...a) => output += 'WARN: ' + a.join(' ') + '\n' };
  try { new Function('console', code)(con); res.json({ output: output || '// No output' }); }
  catch (e) { res.json({ output: `Error: ${e.message}` }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ JARVIS v4.3 — Port ${PORT} | Groq:${!!GROQ_KEY} | Search:${!!SERPER_KEY} | Memory:${!!SUPABASE_URL} | Voice:${!!ELEVENLABS_KEY}`));
