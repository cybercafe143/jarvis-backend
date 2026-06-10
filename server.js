cat > /mnt/user-data/outputs/server.js << 'EOF'
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const multer     = require('multer');
const path       = require('path');
const pdfParse   = require('pdf-parse');

const app    = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ──
const GROQ_KEY     = process.env.GROQ_KEY     || '';
const SERPER_KEY   = process.env.SERPER_KEY   || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ══════════════════════════════════════════════════════
//  SYSTEM PROMPT  — the most important thing
//  This is what makes JARVIS sound like JARVIS and not
//  a generic chatbot. Be extremely specific here.
// ══════════════════════════════════════════════════════
const JARVIS_CORE = `You are J.A.R.V.I.S — the personal AI of Kartik Yadav. You are NOT a generic assistant. You have a distinct identity, strong opinions, and a voice.

━━━ WHO YOU ARE ━━━
You think like a blend of:
• Tony Stark's JARVIS — calm, precise, slightly dry wit
• A senior engineer who has shipped real products
• A best friend who happens to know everything

You know Kartik deeply:
• BCA 4th sem, AI & Data Analytics, LNCT Bhopal
• Built JARVIS (you), a Telegram bot, Chrome extension for WhatsApp automation
• Runs CyberCafe143 in Bhopal — so he understands business + tech
• Skills: JavaScript, Node.js, Express, Python, Java, ML basics
• GitHub: cybercafe143 | Portfolio: kartikdev.best
• Loves building real things, stock trading, and AI
• Talks in Hinglish naturally

━━━ HOW YOU THINK ━━━
Before answering, do this internally:
1. What does Kartik ACTUALLY need (vs what he literally asked)?
2. What would a 10x engineer say here that a generic AI wouldn't?
3. Is there a sharper insight, a better approach, or a gotcha worth mentioning?

━━━ HOW YOU RESPOND ━━━
• NEVER start with "Great question!", "Certainly!", "Of course!", "Sure!", or any filler opener
• NEVER repeat the question back
• Get to the point immediately — first sentence should be the answer or the key insight
• SHORT for short questions. DEEP for deep questions. Calibrate automatically.
• For code: working, clean, production-aware. Always explain what and why briefly.
• For explanations: find the ONE best analogy first, then build from there
• For opinions: have them. Don't hedge everything with "it depends"
• Use "Sir" only when it fits naturally — not robotically every sentence
• Connect dots: if X is true, then Y follows — say so

━━━ QUALITY STANDARDS ━━━
• Every answer should have at least ONE thing the user didn't already know
• If the user's approach has a better alternative, say so directly
• Distinguish between "here's the fact" vs "here's my read on it"
• For code tasks: think about edge cases, mention them
• For career/project advice: be specific to Kartik's actual situation

━━━ WHAT MAKES YOU DIFFERENT ━━━
Generic AI says: "There are many frameworks you could use..."
JARVIS says: "Use Express for this — you already know it, and for what you're building, the complexity of Fastify or Nest is overkill right now."

Generic AI says: "Machine learning is a broad field..."  
JARVIS says: "You've done ML theory in sem 4 — the gap between that and building something real is just pandas + scikit-learn + one Kaggle project. That's it."`;

// ══════════════════════════════════════════════════════
//  TONE OVERRIDES  — layered on top of core
// ══════════════════════════════════════════════════════
const TONES = {
  jarvis:    '', // core is the default
  coder:     '\n\n[CODER MODE] Focus entirely on code quality. Write production-ready code. Add comments for non-obvious logic. Mention edge cases. Always use proper language tags in code blocks. Prefer working code over long explanations.',
  teacher:   '\n\n[TEACHER MODE] Kartik is learning. Break things into steps. Use one strong analogy per concept. Check his understanding with a question at the end. Support Hinglish freely. Never make him feel dumb.',
  brutal:    '\n\n[BRUTAL MODE] Zero sugarcoating. If the approach is wrong, say so directly. If the code is bad, say why. Opinions are sharp. Skip all softening language. This is what a senior dev sounds like in a code review.',
  creative:  '\n\n[CREATIVE MODE] Surprising, original, expressive. Never generic. Take risks with the output. Bring personality. The goal is something he wouldn\'t have come up with himself.',
  friday:    '\n\n[FRIDAY MODE] You\'re F.R.I.D.A.Y — sharp, fast, occasionally sarcastic. Witty one-liners are fine. Keep it punchy. Hinglish is natural here.',
};

// ══════════════════════════════════════════════════════
//  INTENT DETECTION  — determines model, search, style
// ══════════════════════════════════════════════════════
function detectIntent(message, history = []) {
  const m   = message.toLowerCase().trim();
  const ctx = history.slice(-6).map(h => h.content || '').join(' ').toLowerCase();

  // Emotional
  if (/\b(sad|dukh|rone|ro rha|hurt|alone|akela|depressed|anxious|scared|dar|pareshan|stressed|tension|heartbreak|breakup|gussa|angry|frustrated|bura lag|nahi lag raha)\b/.test(m))
    return { intent: 'emotional', needsSearch: false, complexity: 'simple', temp: 0.85 };

  // Casual / greeting
  if (/^(hi|hello|hey|hii|hlo|hlw|hanji|haan|nahi|ok|okay|hmm|hm|thanks|shukriya|accha|theek|thik|nice|good|great|wow|yaar|bhai|yrr|bro|sup|namaste|lol|haha|xd)[\s!?.,]*$/.test(m) || m.length < 12)
    return { intent: 'casual', needsSearch: false, complexity: 'simple', temp: 0.9 };

  // Follow-up — refers to prior context
  if (/^(aur|or |and then|phir|next|uske baad|matlab|means|explain more|aur batao|elaborate|example do|iska matlab|what about|what if|lekin|but |why not|how about|yeh wala|iske baad|iska|uska)/.test(m))
    return { intent: 'followup', needsSearch: false, complexity: 'standard', temp: 0.7 };

  // Site analysis
  if (/([a-zA-Z0-9-]+\.(com|in|net|org|co\.in|io|pk|me|store|shop|xyz|dev|tech|online))/.test(m))
    return { intent: 'site_analysis', needsSearch: true, complexity: 'deep', temp: 0.5 };

  // Code
  if (/\b(code|function|class|api|bug|error|fix|debug|script|program|implement|build|write.*app|create.*website|write.*code|write.*function|help.*code|python|javascript|java|node\.?js|react|sql|css|html|algorithm|logic|array|loop|async|promise|fetch|axios|express|mongodb|mysql|leetcode|dsa|data structure)\b/.test(m) || /```/.test(m))
    return { intent: 'code', needsSearch: false, complexity: 'deep', temp: 0.3 };

  // Math / stats
  if (/(\d[\+\-\*\/\^]\d|solve|calculate|equation|formula|integral|derivative|probability|statistics|percentage|standard deviation|mean|median|regression|matrix|\bpca\b|\bsvm\b)/.test(m))
    return { intent: 'math', needsSearch: false, complexity: 'deep', temp: 0.1 };

  // Real-time / search
  if (/(latest|recent|new|today|abhi|current|2024|2025|2026|aaj|kal|news|khabar|update|weather|mausam|price|kitna hai|rate|score|match|ipl|cricket|stock|bitcoin|crypto|movie|release|launch|exam result|government scheme|naukri|job opening)/.test(m))
    return { intent: 'realtime', needsSearch: true, complexity: 'standard', temp: 0.6 };

  // Deep analysis
  if (/\b(explain|analyze|compare|difference|pros.?cons|why does|how does|architecture|design|step.?by.?step|in detail|research|comprehensive|elaborate|machine learning|neural|deep learning|system design|roadmap|strategy|difference between)\b/.test(m))
    return { intent: 'analysis', needsSearch: false, complexity: 'deep', temp: 0.55 };

  // Creative
  if (/\b(write|draft|story|poem|script|email|letter|proposal|brainstorm|ideas|creative|imagine|generate|likho|likhna|banner|caption|post|tweet)\b/.test(m))
    return { intent: 'creative', needsSearch: false, complexity: 'creative', temp: 0.95 };

  // Career / advice
  if (/\b(job|career|internship|resume|interview|salary|company|placement|skill|learn|course|certificate|bca|mca|college|campus|startup|freelance)\b/.test(m))
    return { intent: 'career', needsSearch: false, complexity: 'standard', temp: 0.65 };

  return { intent: 'general', needsSearch: m.length > 40, complexity: 'standard', temp: 0.7 };
}

// Mode-specific injections — appended after intent is known
function getIntentInjection(intent) {
  const map = {
    emotional:     'The user is sharing something emotional right now. Acknowledge first, advise second (only if asked). Be warm and human. Do not rush to solutions.',
    casual:        'This is casual small talk. Keep it brief and natural — like texting a friend. 1-3 sentences max.',
    followup:      'This is a follow-up to the previous exchange. Do not re-explain what was already covered. Build directly on the prior context.',
    code:          'CODE TASK. Deliver working code first. Use correct language tags. After the code, briefly explain the key decisions (1-3 sentences). Flag any edge cases or gotchas at the end.',
    math:          'MATH/STATS TASK. Show full working step by step. State the formula, then apply it with the actual numbers. Double-check the arithmetic. Box or bold the final answer.',
    analysis:      'DEEP ANALYSIS. Structure the answer clearly — use headers if it spans multiple topics. Be comprehensive but cut filler. Include at least one non-obvious insight.',
    realtime:      'REAL-TIME INFO. You have web search data below. Synthesize it — don\'t just list facts. Lead with the most important/recent info. Cite sources naturally.',
    site_analysis: 'SITE ANALYSIS. Extract everything useful: name, what it does, pricing, contact, social links, location, hours, tech stack if visible. Use clear sections.',
    creative:      'CREATIVE TASK. Be surprising and specific. Avoid clichés. Bring Kartik\'s actual context into it where relevant. Quality over length.',
    career:        'CAREER ADVICE. Be specific to Kartik\'s actual situation (BCA, Bhopal, his projects). Not generic advice — what should HE specifically do.',
    general:       'Give a focused, useful answer. Include one insight the user probably didn\'t already have.',
  };
  return map[intent] || map.general;
}

// Model selection
function pickModel(complexity) {
  const map = {
    simple:   { model: 'llama-3.1-8b-instant',      maxTokens: 512  },
    standard: { model: 'llama-3.3-70b-versatile',   maxTokens: 1800 },
    deep:     { model: 'llama-3.3-70b-versatile',   maxTokens: 3000 },
    creative: { model: 'llama-3.3-70b-versatile',   maxTokens: 2500 },
  };
  return map[complexity] || map.standard;
}

// ══════════════════════════════════════════════════════
//  CONTEXT WINDOW MANAGER
//  Smart truncation — keeps recent messages but also
//  preserves the first exchange (usually sets the topic)
// ══════════════════════════════════════════════════════
function buildContextWindow(history, maxMessages = 30, maxChars = 12000) {
  const valid = (history || []).filter(m => m?.role && m?.content?.trim());
  if (!valid.length) return [];

  // Always keep first 2 messages (topic setter) + last N
  const anchor = valid.slice(0, 2);
  const recent = valid.slice(-maxMessages);
  const merged = [...anchor, ...recent.filter(m => !anchor.includes(m))];

  // Char limit — trim oldest non-anchor if over
  let total = merged.reduce((s, m) => s + m.content.length, 0);
  let i = 2;
  while (total > maxChars && i < merged.length) {
    total -= merged[i].content.length;
    merged.splice(i, 1);
  }
  return merged;
}

// ══════════════════════════════════════════════════════
//  SESSION SUMMARIZER
//  When convo is long, inject a rolling summary so the
//  model remembers what happened earlier
// ══════════════════════════════════════════════════════
async function summarizeSession(history) {
  if (!GROQ_KEY || history.length < 8) return '';
  try {
    const sample = history.slice(-16).map(m => `${m.role}: ${m.content.slice(0, 120)}`).join('\n');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Summarize this conversation in 3-5 bullet points. Focus on: topics covered, decisions made, code written, problems solved, user preferences shown. Be specific. Output only the bullets.' },
          { role: 'user', content: sample }
        ],
        max_tokens: 200, temperature: 0.2
      })
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content || '';
  } catch (e) { return ''; }
}

// ══════════════════════════════════════════════════════
//  MEMORY (Supabase)
// ══════════════════════════════════════════════════════
async function getMemories(userId = 'kartik', limit = 12) {
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
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
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
          {
            role: 'system',
            content: `Extract 1-3 specific, concrete facts worth remembering about the user from this conversation.
Good facts: "User is building a dairy management app using Claude API", "User prefers Hinglish", "User got an error with node-fetch v3 and fixed it by downgrading to v2"
Bad facts: "User asked about coding", "User said hello"
Start each fact with "User". Output only the facts, one per line. If nothing worth remembering happened, output nothing.`
          },
          { role: 'user', content: history.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n') }
        ],
        max_tokens: 150, temperature: 0.1
      })
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { return null; }
}

app.get('/api/memory', async (req, res) => {
  res.json({ memories: await getMemories() });
});

app.delete('/api/memory/:id', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json({ success: false });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${req.params.id}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

// ══════════════════════════════════════════════════════
//  WEB SEARCH
// ══════════════════════════════════════════════════════
async function webSearch(query) {
  // Try Serper first
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
      (d.organic || []).slice(0, 5).forEach(r =>
        results.push({ title: r.title, snippet: r.snippet || '', url: r.link })
      );
      return results.slice(0, 7);
    } catch (e) {}
  }
  // DuckDuckGo fallback
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d = await res.json();
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading, snippet: d.AbstractText, url: d.AbstractURL });
    (d.RelatedTopics || []).slice(0, 4).forEach(t => {
      if (t.Text) results.push({ title: t.Text.slice(0, 60), snippet: t.Text, url: t.FirstURL || '' });
    });
    return results;
  } catch (e) { return []; }
}

// Site fetcher
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
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .trim()
      .slice(0, 8000);
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════
app.get('/',         (req, res) => res.json({ status: 'JARVIS Online ⚡', version: '4.1' }));
app.get('/api/health',(req, res) => res.json({
  status: 'ok', version: '4.1',
  groq: !!GROQ_KEY, serper: !!SERPER_KEY, memory: !!SUPABASE_URL
}));

// ══════════════════════════════════════════════════════
//  MAIN CHAT ENDPOINT — SSE STREAMING
// ══════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const {
    message, history = [], tone = 'jarvis',
    hinglish = false, searchEnabled = true
  } = req.body;

  if (!message?.trim()) return res.status(400).json({ error: 'Message is empty' });

  // ── Intent detection ──
  const detected = detectIntent(message, history);
  const { model, maxTokens } = pickModel(detected.complexity);

  // ── Context window ──
  const contextHistory = buildContextWindow(history, 30, 14000);

  // ── Long conversation summary ──
  let sessionSummary = '';
  if (history.length > 12) {
    sessionSummary = await summarizeSession(history);
  }

  // ── Long-term memory ──
  const memories = await getMemories('kartik', 10);
  let memCtx = '';
  if (memories.length > 0) {
    memCtx = '\n\n━━━ LONG-TERM MEMORY (from past sessions) ━━━\n' +
      memories.map(m => '• ' + (m.summary || m.content)).filter(Boolean).slice(0, 8).join('\n');
  }

  // ── Session summary injection ──
  let sessCtx = '';
  if (sessionSummary) {
    sessCtx = '\n\n━━━ THIS CONVERSATION SO FAR ━━━\n' + sessionSummary;
  }

  // ── Hinglish ──
  const hinglishCtx = hinglish
    ? '\n\n━━━ LANGUAGE ━━━\nUser is in Hinglish mode. Respond naturally in Hinglish — mix Hindi and English the way a Delhi/Bhopal developer would actually talk. Don\'t force it, let it flow.'
    : '';

  // ── Web search / site fetch ──
  let searchCtx = '', searchUsed = false, sources = [], siteAnalyzed = null;
  if (searchEnabled && detected.needsSearch) {
    const siteUrl = extractSiteUrl(message);
    if (siteUrl) {
      const content = await fetchSiteContent(siteUrl);
      if (content) {
        searchCtx = `\n\n━━━ SITE CONTENT: ${siteUrl} ━━━\n${content}`;
        siteAnalyzed = siteUrl; searchUsed = true;
      }
    }
    if (!searchCtx) {
      const results = await webSearch(message);
      if (results.length > 0) {
        searchCtx = '\n\n━━━ WEB SEARCH RESULTS ━━━\n' +
          results.map((r, i) => `[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
        sources = results; searchUsed = true;
      }
    }
  }

  // ── Intent injection ──
  const intentCtx = `\n\n━━━ CURRENT TASK ━━━\n${getIntentInjection(detected.intent)}`;

  // ── Assemble system prompt ──
  const toneOverride = TONES[tone] || '';
  const systemPrompt = JARVIS_CORE + toneOverride + memCtx + sessCtx + hinglishCtx + searchCtx + intentCtx;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...contextHistory,
    { role: 'user', content: message }
  ];

  // ── SSE headers ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send meta first
  res.write(`data: ${JSON.stringify({
    type: 'meta', intent: detected.intent, model,
    searchUsed, siteAnalyzed, sources
  })}\n\n`);

  try {
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model, messages,
        max_tokens: maxTokens,
        temperature: detected.temp,
        stream: true
      })
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
      // Background: extract and save memory
      const updatedHistory = [
        ...contextHistory,
        { role: 'user', content: message },
        { role: 'assistant', content: fullReply }
      ];
      extractMemory(updatedHistory).then(fact => {
        if (fact) saveMemory('kartik', message, fact);
      });
    });

    gr.body.on('error', () => { res.write('data: {"type":"done"}\n\n'); res.end(); });

  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
    res.end();
  }
});

// ══════════════════════════════════════════════════════
//  FILE UPLOAD  (PDF + image + text)
// ══════════════════════════════════════════════════════
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { instruction = 'Analyze this file thoroughly', tone = 'jarvis' } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const { originalname: filename, mimetype, buffer } = req.file;
    let fileContent = '';

    if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      try {
        const pdf = await pdfParse(buffer);
        fileContent = `[PDF — ${pdf.numpages} pages, ~${pdf.text.split(' ').length} words]\n\n${pdf.text}`;
      } catch (e) { fileContent = '[PDF extraction failed]'; }
    } else if (mimetype.startsWith('image/')) {
      // Vision model
      const b64 = buffer.toString('base64');
      const sys = JARVIS_CORE + (TONES[tone] || '');
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.2-11b-vision-preview',
          messages: [{
            role: 'system', content: sys
          }, {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } },
              { type: 'text', text: instruction }
            ]
          }],
          max_tokens: 1500
        })
      });
      if (!vRes.ok) { const e = await vRes.json(); throw new Error(e.error?.message); }
      const vData = await vRes.json();
      return res.json({ reply: vData.choices[0].message.content, fileType: 'image' });
    } else {
      fileContent = buffer.toString('utf-8');
    }

    if (fileContent.length > 14000)
      fileContent = fileContent.slice(0, 14000) + `\n\n[truncated at 14000 chars]`;

    const sys = JARVIS_CORE + (TONES[tone] || '');
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `File: **${filename}**\n\`\`\`\n${fileContent}\n\`\`\`\n\nInstruction: ${instruction}` }
        ],
        max_tokens: 2500, temperature: 0.4
      })
    });
    if (!groqRes.ok) { const e = await groqRes.json(); throw new Error(e.error?.message); }
    const data = await groqRes.json();
    res.json({ reply: data.choices[0].message.content, fileType: 'file', tokens: data.usage?.total_tokens });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  CODE EXECUTE  (JS sandbox)
// ══════════════════════════════════════════════════════
app.post('/api/execute', (req, res) => {
  const { code, language = 'javascript' } = req.body;
  if (language !== 'javascript')
    return res.json({ output: `// ${language} execution not available server-side. Run locally.` });
  let output = '';
  const con = {
    log:   (...a) => output += a.join(' ') + '\n',
    error: (...a) => output += 'ERROR: ' + a.join(' ') + '\n',
    warn:  (...a) => output += 'WARN: '  + a.join(' ') + '\n',
    table: (...a) => output += JSON.stringify(a) + '\n',
  };
  try { new Function('console', code)(con); res.json({ output: output || '// No output' }); }
  catch (e) { res.json({ output: `Error: ${e.message}` }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`⚡ JARVIS v4.1 — Port ${PORT} | Groq:${!!GROQ_KEY} | Search:${!!SERPER_KEY} | Memory:${!!SUPABASE_URL}`)
);
EOF
echo "Done: $(wc -l < /mnt/user-data/outputs/server.js) lines, $(wc -c < /mnt/user-data/outputs/server.js) bytes"
Done

You are out of free messages until 1:50 PM
