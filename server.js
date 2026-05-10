const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GROQ_KEY   = process.env.GROQ_KEY   || '';
const SERPER_KEY = process.env.SERPER_KEY || '';

if (!GROQ_KEY) console.warn('⚠️  GROQ_KEY not set!');
else           console.log('✅ GROQ_KEY loaded:', GROQ_KEY.slice(0,8)+'...');

const SYSTEM_PROMPT = `You are JARVIS — Kartik Yadav's personal AI assistant. You are witty, intelligent, and futuristic like Iron Man's JARVIS.

You can speak in Hinglish (Hindi + English mix) when the user does. Match the user's language style.

About Kartik Yadav:
- BCA student, 4th semester, AI & Data Analytics, LNCT University Bhopal
- Built JARVIS Chrome extension with WhatsApp Web automation
- Built Telegram bot with /ask /code /search /remind commands
- Runs CyberCafe143 in Bhopal — PC rental, SIM cards, printing, form filling
- Skills: JavaScript, Node.js, Python, Java, Express.js, Chrome APIs, ML
- GitHub: cybercafe143 | Email: kartik@kartikdev.best | Website: kartikdev.best
- Open for internships, freelance, collaborations

When responding:
- Use markdown formatting (bold, code blocks, lists etc)
- For code, always use proper code blocks with language
- Be concise but thorough
- Match user's language (Hinglish/English)
- If web search results are provided, use them to give current info`;

/* ── HEALTH CHECK ── */
app.get('/', (req, res) => {
  res.json({
    status: 'JARVIS Online ⚡',
    version: '2.0',
    groq: GROQ_KEY ? 'connected' : 'MISSING - set GROQ_KEY on Render',
    search: SERPER_KEY ? 'serper' : 'duckduckgo-fallback'
  });
});

/* ── DEBUG (safe - no full key exposed) ── */
app.get('/api/debug', (req, res) => {
  res.json({
    groq_key_set: !!GROQ_KEY,
    groq_key_prefix: GROQ_KEY ? GROQ_KEY.slice(0,8)+'...' : 'NOT SET',
    serper_key_set: !!SERPER_KEY
  });
});

/* ── WEB SEARCH ── */
async function webSearch(query) {
  try {
    if (!SERPER_KEY) {
      const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
      const data = await res.json();
      const results = [];
      if (data.AbstractText) results.push({ title: data.Heading, snippet: data.AbstractText, url: data.AbstractURL });
      if (data.RelatedTopics) {
        data.RelatedTopics.slice(0, 4).forEach(t => {
          if (t.Text) results.push({ title: t.Text.split(' - ')[0], snippet: t.Text, url: t.FirstURL });
        });
      }
      return results;
    }
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 })
    });
    const data = await res.json();
    return (data.organic || []).slice(0, 5).map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
  } catch (e) {
    console.warn('Search failed (non-fatal):', e.message);
    return []; // Search fail = silently skip, Groq still responds
  }
}

/* ── CHAT API ── */
app.post('/api/chat', upload.single('file'), async (req, res) => {
  try {

    // ── Key check FIRST — clear error ──
    if (!GROQ_KEY) {
      return res.status(500).json({
        error: 'GROQ_KEY not configured on server.\n\nFix: Render Dashboard → jarvis-backend-cf70 → Environment → Add GROQ_KEY = gsk_xxxx'
      });
    }

    let { message, history, searchEnabled, hinglish } = req.body;
    history = JSON.parse(history || '[]');

    let sysPrompt = SYSTEM_PROMPT;
    if (hinglish === 'true') {
      sysPrompt += '\n\nIMPORTANT: Respond in Hinglish (Hindi + English mix). Use Hindi words naturally mixed with English.';
    }

    // Web search — optional, never blocks Groq if it fails
    let searchContext = '';
    let searchUsed = false;
    if (searchEnabled === 'true' && message) {
      const results = await webSearch(message);
      if (results.length > 0) {
        searchContext = '\n\nWeb Search Results:\n' + results.map((r, i) =>
          `${i+1}. ${r.title}\n${r.snippet}\nSource: ${r.url}`
        ).join('\n\n');
        sysPrompt += searchContext;
        searchUsed = true;
      }
    }

    const messages = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-12),
    ];

    if (req.file) {
      const base64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype;
      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: message || 'Describe this image in detail.' }
        ]
      });
    } else if (message) {
      messages.push({ role: 'user', content: message });
    } else {
      return res.status(400).json({ error: 'No message or file provided' });
    }

    const model = req.file ? 'llama-3.2-11b-vision-preview' : 'llama-3.3-70b-versatile';

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.75, stream: false })
    });

    if (!groqRes.ok) {
      let errMsg = 'Groq API error';
      try {
        const errBody = await groqRes.json();
        errMsg = errBody.error?.message || errMsg;
        if (groqRes.status === 401) errMsg = 'Invalid API Key — GROQ_KEY galat hai ya expire ho gayi. Render pe nayi key set karo.';
        if (groqRes.status === 429) errMsg = 'Rate limit — thoda wait karo aur dobara try karo.';
      } catch (_) {}
      return res.status(groqRes.status).json({ error: errMsg });
    }

    const data  = await groqRes.json();
    const reply = data.choices[0].message.content;

    res.json({ reply, searchUsed, model: data.model, tokens: data.usage?.total_tokens });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 JARVIS Backend v2.0 — Port ${PORT} ⚡`);
  console.log(`🔑 GROQ_KEY: ${GROQ_KEY ? '✅ (' + GROQ_KEY.slice(0,8) + '...)' : '❌ MISSING!'}`);
  console.log(`🔍 Search:   ${SERPER_KEY ? '✅ Serper' : '⚡ DuckDuckGo fallback'}\n`);
});
