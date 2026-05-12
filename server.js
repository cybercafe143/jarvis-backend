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
  jarvis:    `You are J.A.R.V.I.S — Just A Rather Very Intelligent System, Kartik Yadav's advanced AI. Speak with wit, precision, and dry humor. Address user as "Sir". Support Hinglish naturally.`,
  assistant: `You are JARVIS, helpful and friendly AI. Match user language including Hinglish. Be warm and clear.`,
  teacher:   `You are JARVIS in teaching mode. Break concepts into simple steps with examples. Patient, encouraging. Support Hinglish.`,
  coder:     `You are JARVIS Code Intelligence. Write clean efficient code. Always explain. Use proper code blocks with language tags.`,
  brutal:    `You are JARVIS brutal honesty mode. Direct, no sugarcoating, facts only. Address user as Sir.`,
  creative:  `You are JARVIS creative mode. Think outside the box. Be imaginative, poetic, and inspiring.`,
  mission:   `You are JARVIS mission control. Help plan and execute tasks systematically. Break goals into actionable steps.`,
  friday:    `You are F.R.I.D.A.Y — Kartik's witty female AI assistant. Playful, smart, occasionally sarcastic. Support Hinglish.`,
};

const BASE_CTX = `\n\nUser: Kartik Yadav — BCA 4th sem AI&DA LNCT Bhopal. Built JARVIS Chrome extension (WhatsApp automation), Telegram bot. Runs CyberCafe143 Bhopal. Skills: JS Node Python Java Express ML. GitHub: cybercafe143. kartikdev.best`;

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
// CHAT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/chat', async (req,res) => {
  try {
    const { message, history=[], tone='jarvis', model='llama-3.3-70b-versatile' } = req.body;
    // Load memories for context
    const memories = await getMemories();
    let memCtx = '';
    if(memories.length>0) {
      memCtx = '\n\nLong-term memory (past sessions):\n' + memories.map(m=>m.summary||m.content).filter(Boolean).slice(0,8).join('\n');
    }
    const sys = buildSystem(tone, memCtx);
    const messages = [{ role:'system', content:sys }, ...history.slice(-20), { role:'user', content:message }];
    const data = await callGroq(messages, model, 1024);
    const reply = data.choices[0].message.content;

    // Auto-save memory in background
    const updatedHistory = [...history, {role:'user',content:message}, {role:'assistant',content:reply}];
    generateMemorySummary(updatedHistory).then(summary=>{ if(summary) saveMemory('kartik', message, summary); });

    res.json({ reply, tokens:data.usage?.total_tokens, model:data.model });
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
// WEB SEARCH ENDPOINT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/search', async (req,res) => {
  try {
    const { query, tone='jarvis', model='llama-3.3-70b-versatile' } = req.body;
    const results = await webSearch(query);
    const searchCtx = results.length>0
      ? `\n\nReal-time web results for "${query}":\n`+results.map((r,i)=>`${i+1}. ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n')
      : '\n\nNo web results found.';
    const sys = buildSystem(tone, searchCtx);
    const data = await callGroq([{role:'system',content:sys},{role:'user',content:`Answer based on search results: ${query}`}], model, 1024);
    res.json({ reply:data.choices[0].message.content, sources:results, tokens:data.usage?.total_tokens });
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
