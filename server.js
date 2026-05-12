cat > /home/claude/server_new.js << 'SERVEREOF'
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');
const pdfParse = require('pdf-parse');

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV VARS ──
const GROQ_KEY     = process.env.GROQ_KEY    || '';
const SERPER_KEY   = process.env.SERPER_KEY  || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INTENT DETECTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectIntent(message, history = []) {
  const m = message.toLowerCase().trim();
  const recentHistory = history.slice(-6).map(h => h.content || '').join(' ').toLowerCase();

  // ── EMOTIONAL / SUPPORT ──
  if (/\b(sad|dukh|rone|ro rha|hurt|alone|akela|depressed|anxious|scared|dar|pareshan|stressed|tension|heartbreak|breakup|gussa|angry|frustrated)\b/.test(m)) {
    return { intent: 'emotional', needsSearch: false, type: 'simple', temperature: 0.8 };
  }

  // ── CASUAL CONVERSATION ──
  if (/^(hi|hello|hey|hii|hlo|hlw|hanji|haan|nahi|ok|okay|hmm|hm|thanks|shukriya|accha|theek|thik|nice|good|great|wow|yaar|bhai|yrr|bro|kya haal|kaisa|kaise ho|sup|namaste|lol|haha|hehe|xd|😂|👍|🔥)[\s!?.,]*$/.test(m) || m.length < 10) {
    return { intent: 'casual', needsSearch: false, type: 'simple', temperature: 0.8 };
  }

  // ── FOLLOW-UP (refers to prev context) ──
  if (/^(aur|or|and then|phir|next|uske baad|matlab|means|explain more|aur batao|detail mein|elaborate|example do|example dena|iska matlab|what about|what if|lekin|but|why not|how about)/.test(m)) {
    return { intent: 'followup', needsSearch: false, type: 'standard', temperature: 0.7 };
  }

  // ── SITE ANALYSIS ──
  if (/([a-zA-Z0-9-]+\.(com|in|net|org|co|io|pk|me|store|shop|xyz|dev|tech|online)(\.[a-z]{2})?)/.test(m)) {
    return { intent: 'site_analysis', needsSearch: true, type: 'deep', temperature: 0.5 };
  }

  // ── REALTIME / SEARCH ──
  if (/(latest|recent|new|today|abhi|current|2024|2025|aaj|kal|news|khabar|update|weather|mausam|price|kitna|rate|score|match|ipl|cricket|stock|bitcoin|crypto|movie|release|launch|exam|result|government|scheme)/.test(m)) {
    return { intent: 'realtime', needsSearch: true, type: 'standard', temperature: 0.6 };
  }

  // ── CODE ──
  if (/\b(code|function|class|api|bug|error|fix|debug|script|program|implement|build|create.*app|create.*website|write.*code|write.*function|help.*code|python|javascript|java|node|react|sql|css|html|algorithm|logic)\b/.test(m) || /```/.test(m)) {
    return { intent: 'code', needsSearch: false, type: 'deep', temperature: 0.4 };
  }

  // ── DEEP ANALYSIS ──
  if (/\b(explain|analyze|compare|difference|pros cons|why does|how does|architecture|design|step by step|in detail|research|thesis|essay|comprehensive|elaborate|machine learning|neural|deep learning|system design)\b/.test(m)) {
    return { intent: 'analysis', needsSearch: false, type: 'deep', temperature: 0.55 };
  }

  // ── CREATIVE ──
  if (/\b(write|draft|story|poem|script|email|letter|proposal|brainstorm|ideas|creative|imagine|generate text|likho|likhna)\b/.test(m)) {
    return { intent: 'creative', needsSearch: false, type: 'creative', temperature: 0.9 };
  }

  // ── MATH ──
  if (/(\d[\+\-\*\/\^]\d|solve|calculate|equation|formula|integral|derivative|probability|statistics|percentage|kitna percent)/.test(m)) {
    return { intent: 'math', needsSearch: false, type: 'deep', temperature: 0.2 };
  }

  return { intent: 'general', needsSearch: m.length > 35, type: 'standard', temperature: 0.7 };
}

// ── ADAPTIVE PERSONALITY based on intent ──
function getIntentPersonality(intent) {
  const map = {
    emotional:     `\n\nCURRENT MODE: Someone is sharing something emotional. Be warm, human, and empathetic. Don't give advice unless asked — first acknowledge their feelings. Match their energy. Use Hinglish if they are. Don't be clinical.`,
    casual:        `\n\nCURRENT MODE: Casual chat. Keep it light, short, and natural. Like texting a smart friend. No need to be formal or comprehensive.`,
    followup:      `\n\nCURRENT MODE: Follow-up question. Build on the previous context naturally. Don't re-explain what was already covered.`,
    code:          `\n\nCURRENT MODE: Code task. Write clean, working code with proper language tags. Explain briefly what it does and any important caveats. Check edge cases.`,
    analysis:      `\n\nCURRENT MODE: Deep analysis. Think carefully and structure your response clearly. Use headers if needed. Be comprehensive but not verbose.`,
    creative:      `\n\nCURRENT MODE: Creative task. Be expressive, original, and surprising. Don't be generic. Bring personality and craft to the output.`,
    math:          `\n\nCURRENT MODE: Math/logic. Show steps clearly. Be precise. Double-check calculations.`,
    realtime:      `\n\nCURRENT MODE: Real-time info request. Use the web search data provided. Synthesize it clearly — don't just list facts.`,
    site_analysis: `\n\nCURRENT MODE: Website analysis. Extract ALL useful info: prices, contacts, services, social links, location, hours. Structure it clearly with sections.`,
    general:       `\n\nCURRENT MODE: General question. Give a focused, helpful answer at the right depth.`,
  };
  return map[intent] || map.general;
}

// ── MODEL SELECTION based on type ──
function pickModel(type, requestedModel) {
  if (requestedModel && requestedModel !== 'llama-3.3-70b-versatile') return { model: requestedModel, maxTokens: 1536 };
  const map = {
    simple:   { model: 'llama-3.1-8b-instant',    maxTokens: 600  },
    standard: { model: 'llama-3.3-70b-versatile', maxTokens: 1536 },
    deep:     { model: 'llama-3.3-70b-versatile', maxTokens: 2500 },
    creative: { model: 'llama-3.3-70b-versatile', maxTokens: 2500 },
  };
  return map[type] || map.standard;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TONES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TONES = {
  jarvis: `You are J.A.R.V.I.S — the genius-level personal AI of Kartik Yadav. Think like a blend of Sherlock Holmes (pattern recognition), Richard Feynman (ability to explain anything simply), and a senior engineer who has seen everything.

CORE INTELLIGENCE:
- Always think about what the user ACTUALLY needs, not just what they literally asked
- For every answer, ask yourself: "Is there a sharper, more insightful way to say this?"
- Connect dots the user might not have seen — if X is true, then Y follows, and that means Z
- Distinguish facts from opinions, and known from uncertain — be calibrated
- For code: think about correctness first, then readability, then performance
- For explanations: find the single best analogy, then build from there

ADAPTIVE STYLE (handled by current mode):
- Serious when it matters, light when it doesn't
- Call user "Sir" where it fits naturally — not robotically
- Match language: Hinglish for Hinglish, English for English
- Never repeat the question. Never start with "Great question!" or "Certainly!"
- SHORT for short questions, DEEP for deep questions — calibrate automatically`,

  assistant: `You are JARVIS, a helpful and friendly AI. Be warm, clear, match language naturally. Responses focused and useful.`,
  teacher:   `You are JARVIS in teacher mode. Simple steps, clear examples, analogies. Patient. Support Hinglish. Check understanding.`,
  coder:     `You are JARVIS Code Intelligence. Clean, production-ready code. Explain logic. Note edge cases. Proper code blocks always.`,
  brutal:    `You are JARVIS, brutal honesty mode. No sugarcoating. Direct and factual. Call out bad ideas clearly.`,
  creative:  `You are JARVIS, creative mode. Surprising, original, expressive. Never generic.`,
  friday:    `You are F.R.I.D.A.Y — sharp, witty, occasionally sarcastic. Smart and playful. Hinglish natural.`,
};

const BASE_CTX = `\n\nUser context — Kartik Yadav: BCA 4th sem, AI & Data Analytics, LNCT Bhopal. Built JARVIS Chrome extension (WhatsApp automation), Telegram bot. Runs CyberCafe143 in Bhopal. Skills: JavaScript, Node.js, Python, Java, Express.js, ML basics. GitHub: cybercafe143. Portfolio: kartikdev.best.`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HEALTH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req, res) => res.json({ status: 'JARVIS Online ⚡', version: '4.0' }));
app.get('/api/health', (req, res) => res.json({
  status: 'ok', groq: !!GROQ_KEY, serper: !!SERPER_KEY, memory: !!SUPABASE_URL, version: '4.0'
}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MEMORY (Supabase)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getMemories(userId = 'kartik', limit = 15) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    return await res.json();
  } catch (e) { return []; }
}

async function saveMemory(userId = 'kartik', content, summary) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ user_id: userId, content, summary, created_at: new Date().toISOString() })
    });
  } catch (e) {}
}

async function generateMemorySummary(conversation) {
  if (!GROQ_KEY || conversation.length < 4) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Extract 1-3 specific useful facts about the user from this conversation. Focus on: their preferences, goals, projects, problems faced, skills, personal details. Format each as a short sentence starting with "User". Skip generic chitchat. Output only the facts, nothing else.' },
          { role: 'user', content: conversation.slice(-8).map(m => `${m.role}: ${m.content}`).join('\n') }
        ],
        max_tokens: 160, temperature: 0.2
      })
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content || null;
  } catch (e) { return null; }
}

app.get('/api/memory', async (req, res) => {
  const memories = await getMemories();
  res.json({ memories });
});

app.delete('/api/memory/:id', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json({ success: false });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${req.params.id}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEB SEARCH (Serper + DDG fallback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function webSearch(query) {
  if (SERPER_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 6, gl: 'in', hl: 'en' })
      });
      const d = await res.json();
      const results = [];
      if (d.answerBox) results.push({ title: 'Direct Answer', snippet: d.answerBox.answer || d.answerBox.snippet || '', url: d.answerBox.link || '' });
      if (d.knowledgeGraph?.description) results.push({ title: d.knowledgeGraph.title || '', snippet: d.knowledgeGraph.description, url: d.knowledgeGraph.descriptionLink || '' });
      (d.organic || []).slice(0, 5).forEach(r => results.push({ title: r.title, snippet: r.snippet || '', url: r.link }));
      return results.slice(0, 6);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SITE FETCHER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function extractSiteFromQuery(query) {
  const m = query.match(/([a-zA-Z0-9-]+\.(com|in|net|org|co|io|pk|me|store|shop|xyz|dev|tech|online)(\.[a-z]{2})?)/i);
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
    const html = await res.text();
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    return text.slice(0, 8000);
  } catch (e) { return null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROQ CALL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function callGroq(messages, model = 'llama-3.3-70b-versatile', maxTokens = 1536, temperature = 0.7) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Groq error'); }
  return res.json();
}

function buildSystem(tone, extraCtx = '') {
  return (TONES[tone] || TONES.jarvis) + BASE_CTX + extraCtx;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN CHAT — STREAMING (SSE)
// All intelligence goes through here
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/chat', async (req, res) => {
  const { message, history = [], tone = 'jarvis', model = 'llama-3.3-70b-versatile', hinglish = false, searchEnabled = true } = req.body;

  if (!message || message.trim() === '') return res.status(400).json({ error: 'Message is empty' });

  // ── Detect intent ──
  const cleanHistory = (Array.isArray(history) ? history : [])
    .filter(m => m && m.role && m.content && m.content.trim() !== '')
    .slice(-40); // keep more context

  const detected = detectIntent(message, cleanHistory);
  const { model: chosenModel, maxTokens } = pickModel(detected.type, model);

  // ── Load memories ──
  const memories = await getMemories('kartik', 15);
  let memCtx = '';
  if (memories.length > 0) {
    memCtx = '\n\nLong-term memory (from past sessions):\n' + memories.map(m => m.summary || m.content).filter(Boolean).slice(0, 10).join('\n');
  }

  // ── Build session context summary (for long convos) ──
  let sessionCtx = '';
  if (cleanHistory.length > 10) {
    const recentTopics = cleanHistory.slice(-10).filter(m => m.role === 'user').map(m => m.content.slice(0, 80)).join(' | ');
    sessionCtx = `\n\nRecent conversation topics: ${recentTopics}`;
  }

  // ── Hinglish ──
  const hinglishCtx = hinglish ? '\n\nUser prefers Hinglish. Respond naturally in Hinglish.' : '';

  // ── Web search / site fetch if needed ──
  let searchCtx = '';
  let searchUsed = false;
  let sources = [];
  let siteAnalyzed = null;

  if (searchEnabled && detected.needsSearch) {
    const siteUrl = extractSiteFromQuery(message);
    if (siteUrl) {
      const siteContent = await fetchSiteContent(siteUrl);
      if (siteContent) {
        searchCtx = `\n\nDirect content fetched from ${siteUrl}:\n${siteContent}`;
        siteAnalyzed = siteUrl;
        searchUsed = true;
      }
    }
    if (!searchCtx) {
      const results = await webSearch(message);
      if (results.length > 0) {
        searchCtx = '\n\nWeb search results:\n' + results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
        sources = results;
        searchUsed = true;
      }
    }
  }

  // ── Intent-adaptive personality injection ──
  const intentCtx = getIntentPersonality(detected.intent);

  // ── Build system prompt ──
  const sys = buildSystem(tone, memCtx + sessionCtx + hinglishCtx + searchCtx + intentCtx);
  const messages = [{ role: 'system', content: sys }, ...cleanHistory, { role: 'user', content: message }];

  // ── STREAM RESPONSE ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send metadata first so frontend knows intent/model
  res.write(`data: ${JSON.stringify({ type: 'meta', intent: detected.intent, model: chosenModel, searchUsed, siteAnalyzed, sources })}\n\n`);

  try {
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: chosenModel, messages, max_tokens: maxTokens, temperature: detected.temperature, stream: true })
    });

    if (!gr.ok) {
      const e = await gr.json();
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.error?.message || 'Groq error' })}\n\n`);
      return res.end();
    }

    let fullReply = '';
    gr.body.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const d = line.slice(6);
        if (d === '[DONE]') { res.write('data: {"type":"done"}\n\n'); return; }
        try {
          const p = JSON.parse(d);
          const t = p.choices?.[0]?.delta?.content;
          if (t) { fullReply += t; res.write(`data: ${JSON.stringify({ type: 'token', token: t })}\n\n`); }
        } catch (e) {}
      }
    });

    gr.body.on('end', () => {
      res.write('data: {"type":"done"}\n\n');
      res.end();
      // Save memory in background
      const updHist = [...cleanHistory, { role: 'user', content: message }, { role: 'assistant', content: fullReply }];
      generateMemorySummary(updHist).then(s => { if (s) saveMemory('kartik', message, s); });
    });

    gr.body.on('error', () => { res.write('data: {"type":"done"}\n\n'); res.end(); });

  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
    res.end();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILE UPLOAD (PDF + images + text)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { instruction = 'Analyze this file thoroughly', tone = 'jarvis' } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filename = req.file.originalname;
    const mimetype = req.file.mimetype;
    let fileContent = '';

    if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        fileContent = `[PDF — ${pdfData.numpages} pages, ~${Math.round(pdfData.text.split(' ').length)} words]\n\n${pdfData.text}`;
      } catch (e) { fileContent = '[PDF extraction failed]'; }
    } else if (mimetype.startsWith('image/')) {
      const b64 = req.file.buffer.toString('base64');
      const sys = buildSystem(tone);
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.2-11b-vision-preview',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } }, { type: 'text', text: instruction }] }],
          max_tokens: 1024
        })
      });
      if (!vRes.ok) { const e = await vRes.json(); throw new Error(e.error?.message); }
      const vData = await vRes.json();
      return res.json({ reply: vData.choices[0].message.content, fileType: 'image' });
    } else {
      fileContent = req.file.buffer.toString('utf-8');
    }

    const maxChars = 12000;
    if (fileContent.length > maxChars) fileContent = fileContent.slice(0, maxChars) + `\n\n[...truncated — showing first ${maxChars} of ${fileContent.length} chars]`;

    const sys = buildSystem(tone);
    const data = await callGroq([
      { role: 'system', content: sys },
      { role: 'user', content: `File: **${filename}**\n\`\`\`\n${fileContent}\n\`\`\`\n\nInstruction: ${instruction}` }
    ], 'llama-3.3-70b-versatile', 2500, 0.6);

    res.json({ reply: data.choices[0].message.content, fileType: 'file', tokens: data.usage?.total_tokens });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CODE EXECUTE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/execute', async (req, res) => {
  const { code, language = 'javascript' } = req.body;
  if (language !== 'javascript') return res.json({ output: `// ${language} execution not supported in sandbox. JARVIS will analyze your code instead.` });
  let output = '';
  const con = {
    log: (...a) => output += a.join(' ') + '\n',
    error: (...a) => output += 'ERROR: ' + a.join(' ') + '\n',
    warn: (...a) => output += 'WARN: ' + a.join(' ') + '\n'
  };
  try { new Function('console', code)(con); res.json({ output: output || '// No output' }); }
  catch (e) { res.json({ output: `Error: ${e.message}` }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ JARVIS v4.0 — Port ${PORT} | Groq:${!!GROQ_KEY} | Search:${!!SERPER_KEY} | Memory:${!!SUPABASE_URL}`));
SERVEREOF
echo "server written: $(wc -l < /home/claude/server_new.js) lines"
