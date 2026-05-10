const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GROQ_KEY = process.env.GROQ_KEY || '';
const SERPER_KEY = process.env.SERPER_KEY || '';

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
  res.json({ status: 'JARVIS Online ⚡', version: '2.0' });
});

/* ── WEB SEARCH ── */
async function webSearch(query) {
  try {
    if (!SERPER_KEY) {
      // Fallback: DuckDuckGo Instant Answer (no key needed)
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
    // Serper API (better results)
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 })
    });
    const data = await res.json();
    return (data.organic || []).slice(0, 5).map(r => ({
      title: r.title, snippet: r.snippet, url: r.link
    }));
  } catch (e) {
    return [];
  }
}

/* ── CHAT API ── */
app.post('/api/chat', upload.single('file'), async (req, res) => {
  try {
    let { message, history, searchEnabled, hinglish } = req.body;
    history = JSON.parse(history || '[]');

    // System prompt
    let sysPrompt = SYSTEM_PROMPT;
    if (hinglish === 'true') {
      sysPrompt += '\n\nIMPORTANT: Respond in Hinglish (Hindi + English mix). Use Hindi words naturally mixed with English.';
    }

    // Web search if enabled
    let searchContext = '';
    if (searchEnabled === 'true' && message) {
      const results = await webSearch(message);
      if (results.length > 0) {
        searchContext = '\n\nWeb Search Results:\n' + results.map((r, i) =>
          `${i + 1}. ${r.title}\n${r.snippet}\nSource: ${r.url}`
        ).join('\n\n');
        sysPrompt += searchContext;
      }
    }

    // Build messages
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-12),
    ];

    // Image support
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
    }

    // Call Groq
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: req.file ? 'llama-3.2-11b-vision-preview' : 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 1024,
        temperature: 0.75,
        stream: false
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      throw new Error(err.error?.message || 'Groq API error');
    }

    const data = await groqRes.json();
    const reply = data.choices[0].message.content;

    res.json({
      reply,
      searchUsed: searchEnabled === 'true' && searchContext !== '',
      model: data.model,
      tokens: data.usage?.total_tokens
    });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JARVIS Backend running on port ${PORT} ⚡`));
