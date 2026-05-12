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
const GROQ_KEY    = process.env.GROQ_KEY    || '';
const SERPER_KEY  = process.env.SERPER_KEY  || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ── TONES ──
const TONES = {
  jarvis: `You are J.A.R.V.I.S (Just A Rather Very Intelligent System) — the personal AI of Kartik Yadav. Your personality:
- Intelligent, precise, occasionally witty — never sycophantic or over-the-top
- Address the user as "Sir" naturally (not every single sentence — only where it fits)
- Match the user's language: if they write Hindi/Hinglish, respond in Hinglish naturally
- For casual/conversational messages: respond briefly and naturally — like a smart friend
- For technical questions: be thorough, use proper code blocks with language tags
- For factual/current info requests: use the provided web search data if available
- NEVER repeat the question back or start with "Aapne poocha ki..."
- NEVER be robotic, over-formal, or give unnecessary search results for simple conversation
- Keep responses concise and focused unless detail is genuinely needed`,

  assistant: `You are JARVIS, a helpful and friendly AI. Be warm, clear, and match the user's language naturally including Hinglish. Responses should be focused and useful, not verbose.`,

  teacher: `You are JARVIS in teaching mode. Break every concept into simple steps with clear examples. Be patient and encouraging. Use analogies. Support Hinglish. End with "Samajh aaya?" when appropriate.`,

  coder: `You are JARVIS Code Intelligence. Write clean, efficient, production-ready code. Always explain what the code does and why. Use proper code blocks with language tags. Point out potential issues.`,

  brutal: `You are JARVIS in brutal honesty mode. Zero sugarcoating. Direct, fact-based, no fluff. If something is wrong or illogical, say it plainly. Address user as Sir sparingly.`,

  creative: `You are JARVIS in creative mode. Think unconventionally. Use vivid language, explore unusual angles, inspire. Don't be predictable.`,

  mission: `You are JARVIS mission control. Break goals into clear actionable steps. Be systematic and prioritize. Track what matters.`,

  friday: `You are F.R.I.D.A.Y — Kartik's sharp, witty AI assistant. Playful but intelligent, occasionally sarcastic (never mean). Support Hinglish naturally.`,
};

const BASE_CTX = `\n\nAbout the user — Kartik Yadav: BCA 4th sem, AI & Data Analytics at LNCT Bhopal. Built JARVIS Chrome extension (WhatsApp automation) and a Telegram bot. Runs CyberCafe143 in Bhopal. Tech skills: JavaScript, Node.js, Python, Java, Express.js, ML basics. GitHub: cybercafe143. Portfolio: kartikdev.best.`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HEALTH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req,res) => res.json({ status:'JARVIS Mark III ⚡', version:'3.1' }));
app.get('/api/health', (req,res) => res.json({
  status:'ok', groq:!!GROQ_KEY, serper:!!SERPER_KEY,
  memory:!!SUPABASE_URL, version:'3.1'
}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MEMORY (Supabase)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getMemories(userId='kartik') {
  if(!SUPABASE_URL||!SUPABASE_KEY) return [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&order=created_at.desc&limit=20`, {
      headers:{ 'apikey':SUPABASE_KEY, 'Authorization':`Bearer ${SUPABASE_KEY}` }
    });
    return await res.json();
  } catch(e) { return []; }
}

async function saveMemory(userId='kartik', content, summary) {
  if(!SUPABASE_URL||!SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method:'POST',
      headers:{ 'apikey':SUPABASE_KEY, 'Authorization':`Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', 'Prefer':'return=minimal' },
      body: JSON.stringify({ user_id:userId, content, summary, created_at:new Date().toISOString() })
    });
  } catch(e) {}
}

async function generateMemorySummary(conversation) {
  if(!GROQ_KEY||conversation.length<4) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model:'llama-3.1-8b-instant',
        messages:[
          { role:'system', content:'Extract 1-2 key facts worth remembering from this conversation. Be very concise. Format: "User [fact]". Only factual info, no fluff.' },
          { role:'user', content: conversation.slice(-6).map(m=>`${m.role}: ${m.content}`).join('\n') }
        ],
        max_tokens:100, temperature:0.3
      })
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content||null;
  } catch(e) { return null; }
}

// Memory API endpoints
app.get('/api/memory', async (req,res) => {
  const memories = await getMemories();
  res.json({ memories });
});

app.delete('/api/memory/:id', async (req,res) => {
  if(!SUPABASE_URL||!SUPABASE_KEY) return res.json({success:false});
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${req.params.id}`, {
      method:'DELETE',
      headers:{ 'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}` }
    });
    res.json({success:true});
  } catch(e){ res.json({success:false}); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEB SEARCH (Serper)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function webSearch(query) {
  // Serper API (best results)
  if(SERPER_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method:'POST',
        headers:{ 'X-API-KEY':SERPER_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify({ q:query, num:6, gl:'in', hl:'en' })
      });
      const d = await res.json();
      const results = [];
      // Answer box (best)
      if(d.answerBox) results.push({ title:'Direct Answer', snippet:d.answerBox.answer||d.answerBox.snippet||'', url:d.answerBox.link||'' });
      // Knowledge graph
      if(d.knowledgeGraph?.description) results.push({ title:d.knowledgeGraph.title||'', snippet:d.knowledgeGraph.description, url:d.knowledgeGraph.descriptionLink||'' });
      // Organic results
      (d.organic||[]).slice(0,5).forEach(r=> results.push({ title:r.title, snippet:r.snippet||'', url:r.link }));
      return results.slice(0,6);
    } catch(e) {}
  }
  // DuckDuckGo fallback (no key needed)
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d = await res.json();
    const results = [];
    if(d.AbstractText) results.push({ title:d.Heading, snippet:d.AbstractText, url:d.AbstractURL });
    (d.RelatedTopics||[]).slice(0,4).forEach(t=>{ if(t.Text) results.push({ title:t.Text.slice(0,60), snippet:t.Text, url:t.FirstURL||'' }); });
    return results;
  } catch(e) { return []; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROQ CALL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function callGroq(messages, model='llama-3.3-70b-versatile', maxTokens=1024) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens:maxTokens, temperature:0.75 })
  });
  if(!res.ok){ const e=await res.json(); throw new Error(e.error?.message||'Groq error'); }
  return res.json();
}

function buildSystem(tone, extraCtx='') {
  return (TONES[tone]||TONES.jarvis) + BASE_CTX + extraCtx;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SMART SEARCH DECISION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function needsWebSearch(message) {
  const m = message.toLowerCase().trim();
  
  // Never search for these — casual/conversational
  const casualPatterns = [
    /^(hi|hello|hey|hii|hlo|hlw|helo|hanji|haan|nahi|ok|okay|hmm|hm|thanks|thank you|shukriya|accha|theek|thik|nice|good|great|wow|yaar|bhai|yrr|bro|sir)[\s!?.]*$/,
    /^(kya haal|kaisa hai|kaise ho|how are you|what's up|whatsup|sup|namaste|namaskar)/,
    /^(tell me about yourself|tum kaun ho|aap kaun ho|introduce yourself|apna parichay)/,
    /^(yes|no|haan|nahi|nope|yep|yeah|sure|bilkul|zaroor|maybe|shayad)[\s!?.]*$/,
    /^.{1,8}$/, // Very short messages (under 8 chars)
  ];
  
  for(const p of casualPatterns) {
    if(p.test(m)) return false;
  }
  
  // Always search for these
  const searchPatterns = [
    /(latest|recent|new|today|abhi|current|2024|2025|aaj|kal)/,
    /(price|cost|kitna|rate|fee|charge|paisa|rupee|rs\.|₹)/,
    /(news|khabar|update|announcement|launch|release)/,
    /(weather|mausam|forecast)/,
    /(who is|kaun hai|kaun hain|what is.*company|kya hai.*website)/,
    /(vs|versus|compare|comparison)/,
    /\.(com|in|net|org|io|pk|co)/,  // domain names
    /(stock|share price|sensex|nifty|bitcoin|crypto)/,
    /(recipe|ingredients|kaise banate|how to make.*food)/,
    /(movie|film|web series|show|episode|release date)/,
    /(sports|score|match|cricket|football|ipl|team)/,
    /(government|scheme|yojana|policy|exam|result|admit card)/,
  ];
  
  for(const p of searchPatterns) {
    if(p.test(m)) return true;
  }
  
  // For longer factual-sounding questions, search
  if(m.length > 40 && (m.includes('?') || m.startsWith('what') || m.startsWith('how') || m.startsWith('why') || m.startsWith('when') || m.startsWith('where') || m.startsWith('kya') || m.startsWith('kaise') || m.startsWith('kyun') || m.startsWith('kab') || m.startsWith('kahan'))) {
    return true;
  }
  
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAT (smart — decides search internally)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/chat', async (req,res) => {
  try {
    const { message, history=[], tone='jarvis', model='llama-3.3-70b-versatile', hinglish=false, searchEnabled=true } = req.body;
    
    // Validate message
    if(!message || message.trim() === '') return res.status(400).json({ error:'Message is empty' });
    
    // Load memories
    const memories = await getMemories();
    let memCtx = '';
    if(memories.length > 0) {
      memCtx = '\n\nLong-term memory from past sessions:\n' + memories.map(m=>m.summary||m.content).filter(Boolean).slice(0,8).join('\n');
    }
    
    // Hinglish instruction
    const hinglishCtx = hinglish ? '\n\nIMPORTANT: User prefers Hinglish (Hindi+English mix). Respond naturally in Hinglish.' : '';
    
    let searchCtx = '';
    let searchUsed = false;
    let sources = [];
    
    // Smart search: only search when actually needed AND searchEnabled
    if(searchEnabled && needsWebSearch(message)) {
      const siteUrl = extractSiteFromQuery(message);
      
      if(siteUrl) {
        const siteContent = await fetchSiteContent(siteUrl);
        if(siteContent) {
          searchCtx = '\n\nDirect site content from ' + siteUrl + ':\n' + siteContent;
          searchUsed = true;
        }
      }
      
      if(!searchCtx) {
        const results = await webSearch(message);
        if(results.length > 0) {
          searchCtx = '\n\nWeb search results for context:\n' + results.map((r,i)=>`${i+1}. ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
          sources = results;
          searchUsed = true;
        }
      }
    }
    
    const sys = buildSystem(tone, memCtx + hinglishCtx + searchCtx);
    
    // Clean history — remove any empty content
    const cleanHistory = (Array.isArray(history) ? history : [])
      .filter(m => m && m.role && m.content && m.content.trim() !== '')
      .slice(-20);
    
    const messages = [{ role:'system', content:sys }, ...cleanHistory, { role:'user', content:message }];
    const data = await callGroq(messages, model, 1536);
    const reply = data.choices[0].message.content;

    // Save memory in background
    const updatedHistory = [...cleanHistory, {role:'user',content:message}, {role:'assistant',content:reply}];
    generateMemorySummary(updatedHistory).then(summary=>{ if(summary) saveMemory('kartik', message, summary); });

    res.json({ reply, tokens:data.usage?.total_tokens, model:data.model, searchUsed, sources });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAT STREAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/chat/stream', async (req,res) => {
  try {
    const { message, history=[], tone='jarvis', model='llama-3.3-70b-versatile' } = req.body;
    const memories = await getMemories();
    let memCtx = memories.length>0 ? '\n\nLong-term memory:\n'+memories.map(m=>m.summary).filter(Boolean).slice(0,6).join('\n') : '';
    const sys = buildSystem(tone, memCtx);

    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');

    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model, messages:[{role:'system',content:sys},...history.slice(-16),{role:'user',content:message}], max_tokens:1024, temperature:0.75, stream:true })
    });

    let fullReply = '';
    gr.body.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(l=>l.startsWith('data: '));
      for(const line of lines) {
        const d = line.slice(6);
        if(d==='[DONE]'){ res.write('data: [DONE]\n\n'); return; }
        try {
          const p = JSON.parse(d);
          const t = p.choices?.[0]?.delta?.content;
          if(t){ fullReply+=t; res.write(`data: ${JSON.stringify({token:t})}\n\n`); }
        } catch(e) {}
      }
    });
    gr.body.on('end', () => {
      res.write('data: [DONE]\n\n'); res.end();
      // Save memory after stream
      const hist = [...history, {role:'user',content:message},{role:'assistant',content:fullReply}];
      generateMemorySummary(hist).then(s=>{ if(s) saveMemory('kartik',message,s); });
    });
    gr.body.on('error', ()=>res.end());
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SITE FETCHER HELPER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchSiteContent(url) {
  try {
    // Ensure URL has protocol
    if(!url.startsWith('http')) url = 'https://' + url;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000
    });
    if(!res.ok) return null;
    const html = await res.text();
    // Strip HTML tags but keep structure
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
    // Limit to 8000 chars to stay within token limits
    return text.slice(0, 8000);
  } catch(e) {
    return null;
  }
}

// Detect if query is about a specific website
function extractSiteFromQuery(query) {
  const q = query.toLowerCase().trim();
  // Match patterns like "hammadtools.com", "about xyz.com", "xyz site info", "xyz website"
  const domainMatch = query.match(/([a-zA-Z0-9-]+\.(com|in|net|org|co|io|pk|me|store|shop|xyz|dev|tech|online)(\.[a-z]{2})?)/i);
  if(domainMatch) return domainMatch[0];
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEB SEARCH ENDPOINT (upgraded with site analyzer)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/search', async (req,res) => {
  try {
    const { query, tone='jarvis', model='llama-3.3-70b-versatile' } = req.body;

    // Check if user is asking about a specific site
    const siteUrl = extractSiteFromQuery(query);
    let siteContent = null;
    let siteAnalysisCtx = '';

    if(siteUrl) {
      // Try to fetch the actual site
      siteContent = await fetchSiteContent(siteUrl);
      if(siteContent) {
        siteAnalysisCtx = `\n\nDIRECT SITE CONTENT from ${siteUrl}:\n${siteContent}\n\n`;
      }
    }

    // Always also do web search for extra context
    const results = await webSearch(query);
    const searchSnippets = results.length > 0
      ? results.map((r,i)=>`${i+1}. ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n')
      : 'No additional results found.';

    const fullCtx = siteAnalysisCtx
      ? `${siteAnalysisCtx}\nAdditional web search results:\n${searchSnippets}`
      : `\n\nReal-time web results for "${query}":\n${searchSnippets}`;

    const sys = buildSystem(tone, fullCtx);

    // Special prompt for site analysis
    const userPrompt = siteContent
      ? `Analyze the website ${siteUrl} thoroughly. Extract and present ALL of the following IN DETAIL:
1. 💼 What does this site/business do? (full description)
2. 💰 PRICE LIST — List every product/service with exact prices found
3. 📞 Contact Info — Phone numbers, WhatsApp, email, address
4. 🌐 Social media links (Instagram, Facebook, etc.)
5. 📦 Services/Products offered (complete list)
6. ⭐ Any offers, discounts, or special deals
7. 🕐 Working hours (if mentioned)
8. 📍 Location/City
Format clearly with sections. If any info is missing from the site, mention "Not found on site".`
      : `Answer based on search results: ${query}`;

    const data = await callGroq(
      [{role:'system',content:sys},{role:'user',content:userPrompt}],
      model, 2048
    );

    res.json({
      reply: data.choices[0].message.content,
      sources: results,
      siteAnalyzed: siteUrl || null,
      tokens: data.usage?.total_tokens
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILE UPLOAD (PDF + text + code)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/upload', upload.single('file'), async (req,res) => {
  try {
    const { instruction='Analyze this file thoroughly', tone='jarvis', model='llama-3.3-70b-versatile' } = req.body;
    if(!req.file) return res.status(400).json({error:'No file uploaded'});

    const filename = req.file.originalname;
    const mimetype = req.file.mimetype;
    let fileContent = '';
    let fileType = 'text';

    // ── PDF EXTRACTION ──
    if(mimetype==='application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      fileType = 'pdf';
      try {
        const pdfData = await pdfParse(req.file.buffer);
        fileContent = pdfData.text;
        const info = `Pages: ${pdfData.numpages} | Words: ~${Math.round(fileContent.split(' ').length)}`;
        fileContent = `[PDF extracted — ${info}]\n\n${fileContent}`;
      } catch(e) {
        fileContent = '[PDF extraction failed — may be scanned/image-based PDF]';
      }
    }
    // ── IMAGE — redirect to vision ──
    else if(mimetype.startsWith('image/')) {
      const b64 = req.file.buffer.toString('base64');
      const sys = buildSystem(tone);
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
        body: JSON.stringify({ model:'llama-3.2-11b-vision-preview', messages:[{role:'system',content:sys},{role:'user',content:[{type:'image_url',image_url:{url:`data:${mimetype};base64,${b64}`}},{type:'text',text:instruction}]}], max_tokens:1024 })
      });
      if(!vRes.ok){ const e=await vRes.json(); throw new Error(e.error?.message); }
      const vData = await vRes.json();
      return res.json({ reply:vData.choices[0].message.content, fileType:'image' });
    }
    // ── TEXT / CODE / CSV / DOCX ──
    else {
      fileContent = req.file.buffer.toString('utf-8');
    }

    // Truncate if too large
    const maxChars = 12000;
    const truncated = fileContent.length > maxChars;
    if(truncated) fileContent = fileContent.slice(0, maxChars) + `\n\n[... truncated — showing first ${maxChars} chars of ${fileContent.length} total]`;

    const sys = buildSystem(tone);
    const data = await callGroq([
      {role:'system', content:sys},
      {role:'user', content:`File: **${filename}**\n\n\`\`\`\n${fileContent}\n\`\`\`\n\nInstruction: ${instruction}`}
    ], model, 2048);

    res.json({ reply:data.choices[0].message.content, fileType, tokens:data.usage?.total_tokens, truncated });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VISION (direct image)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/vision', upload.single('image'), async (req,res) => {
  try {
    const { question='Analyze this image in detail', tone='jarvis' } = req.body;
    if(!req.file) return res.status(400).json({error:'No image uploaded'});
    const b64 = req.file.buffer.toString('base64');
    const sys = buildSystem(tone);
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body: JSON.stringify({ model:'llama-3.2-11b-vision-preview', messages:[{role:'system',content:sys},{role:'user',content:[{type:'image_url',image_url:{url:`data:${req.file.mimetype};base64,${b64}`}},{type:'text',text:question}]}], max_tokens:1024 })
    });
    if(!r.ok){ const e=await r.json(); throw new Error(e.error?.message); }
    const data = await r.json();
    res.json({ reply:data.choices[0].message.content });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CODE EXECUTE (JS only safe)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/execute', async (req,res) => {
  const { code, language='javascript' } = req.body;
  if(language!=='javascript') return res.json({ output:`// ${language} execution: JARVIS will analyze your code instead.` });
  let output='';
  const con={log:(...a)=>output+=a.join(' ')+'\n',error:(...a)=>output+='ERROR: '+a.join(' ')+'\n',warn:(...a)=>output+='WARN: '+a.join(' ')+'\n'};
  try { new Function('console',code)(con); res.json({output:output||'// No output'}); }
  catch(e){ res.json({output:`Error: ${e.message}`}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`⚡ JARVIS Mark III v3.1 — Port ${PORT} | Groq:${!!GROQ_KEY} | Serper:${!!SERPER_KEY} | Memory:${!!SUPABASE_URL}`));
