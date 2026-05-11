const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_KEY = process.env.GROQ_KEY || '';
const SERPER_KEY = process.env.SERPER_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASS || 'jarvis@kartik143';

const TONES = {
  jarvis: `You are J.A.R.V.I.S — Just A Rather Very Intelligent System, Kartik Yadav's highly advanced AI. Speak with wit, technical precision, and dry humor. Address user as "Sir". Support Hinglish.`,
  assistant: `You are JARVIS, helpful and friendly. Match user's language style including Hinglish.`,
  teacher: `You are JARVIS teaching mode. Break complex concepts into simple steps with examples. Support Hinglish.`,
  coder: `You are JARVIS Code Intelligence. Focus on clean efficient code. Always explain code. Use proper code blocks.`,
  brutal: `You are JARVIS brutal honesty mode. Direct, no sugarcoating, just facts. Address user as Sir.`
};

const BASE_CTX = `\n\nUser context — Kartik Yadav: BCA 4th sem AI&DA LNCT Bhopal. Built JARVIS Chrome extension (WhatsApp automation), Telegram bot. Runs CyberCafe143 Bhopal. Skills: JS Node Python Java Express ML. GitHub: cybercafe143. kartikdev.best`;

app.get('/', (req,res) => res.json({ status:'JARVIS Mark III Online ⚡', version:'3.0' }));
app.get('/api/health', (req,res) => res.json({ status:'ok', groq: !!GROQ_KEY, version:'3.0' }));

async function webSearch(query) {
  try {
    if (SERPER_KEY) {
      const r = await fetch('https://google.serper.dev/search', { method:'POST', headers:{'X-API-KEY':SERPER_KEY,'Content-Type':'application/json'}, body:JSON.stringify({q:query,num:6}) });
      const d = await r.json();
      return (d.organic||[]).slice(0,5).map(r=>({title:r.title,snippet:r.snippet,url:r.link}));
    }
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d = await r.json();
    const results = [];
    if(d.AbstractText) results.push({title:d.Heading,snippet:d.AbstractText,url:d.AbstractURL});
    (d.RelatedTopics||[]).slice(0,4).forEach(t=>{ if(t.Text) results.push({title:t.Text.slice(0,60),snippet:t.Text,url:t.FirstURL}); });
    return results;
  } catch(e) { return []; }
}

async function callGroq(messages, model='llama-3.3-70b-versatile', maxTokens=1024) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`}, body:JSON.stringify({model,messages,max_tokens:maxTokens,temperature:0.75}) });
  if(!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'Groq error'); }
  return r.json();
}

app.post('/api/chat', async (req,res) => {
  try {
    const {message,history=[],tone='jarvis',model='llama-3.3-70b-versatile'} = req.body;
    const sys = (TONES[tone]||TONES.jarvis) + BASE_CTX;
    const data = await callGroq([{role:'system',content:sys},...history.slice(-20),{role:'user',content:message}], model, 1024);
    res.json({reply:data.choices[0].message.content, tokens:data.usage?.total_tokens});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/chat/stream', async (req,res) => {
  try {
    const {message,history=[],tone='jarvis',model='llama-3.3-70b-versatile'} = req.body;
    const sys = (TONES[tone]||TONES.jarvis) + BASE_CTX;
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`}, body:JSON.stringify({model,messages:[{role:'system',content:sys},...history.slice(-16),{role:'user',content:message}],max_tokens:1024,temperature:0.75,stream:true}) });
    gr.body.on('data',chunk=>{ const lines=chunk.toString().split('\n').filter(l=>l.startsWith('data: ')); for(const line of lines){ const d=line.slice(6); if(d==='[DONE]'){res.write('data: [DONE]\n\n');return;} try{const p=JSON.parse(d);const t=p.choices?.[0]?.delta?.content;if(t)res.write(`data: ${JSON.stringify({token:t})}\n\n`);}catch(e){} } });
    gr.body.on('end',()=>{res.write('data: [DONE]\n\n');res.end();});
    gr.body.on('error',()=>res.end());
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/search', async (req,res) => {
  try {
    const {query,tone='jarvis',model='llama-3.3-70b-versatile'} = req.body;
    const results = await webSearch(query);
    const sys = (TONES[tone]||TONES.jarvis) + BASE_CTX + (results.length ? '\n\nWeb results for "'+query+'":\n'+results.map((r,i)=>`${i+1}. ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n') : '');
    const data = await callGroq([{role:'system',content:sys},{role:'user',content:`Answer based on search results: ${query}`}], model, 1024);
    res.json({reply:data.choices[0].message.content, sources:results, tokens:data.usage?.total_tokens});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/upload', upload.single('file'), async (req,res) => {
  try {
    const {instruction='Analyze this file',tone='jarvis',model='llama-3.3-70b-versatile'} = req.body;
    if(!req.file) return res.status(400).json({error:'No file uploaded'});
    const content = req.file.buffer.toString('utf-8').slice(0,8000);
    const sys = (TONES[tone]||TONES.jarvis) + BASE_CTX;
    const data = await callGroq([{role:'system',content:sys},{role:'user',content:`File: ${req.file.originalname}\n\nContent:\n${content}\n\nInstruction: ${instruction}`}], model, 2048);
    res.json({reply:data.choices[0].message.content, tokens:data.usage?.total_tokens});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/vision', upload.single('image'), async (req,res) => {
  try {
    const {question='Analyze this image in detail',tone='jarvis'} = req.body;
    if(!req.file) return res.status(400).json({error:'No image'});
    const b64 = req.file.buffer.toString('base64');
    const sys = (TONES[tone]||TONES.jarvis) + BASE_CTX;
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`}, body:JSON.stringify({model:'llama-3.2-11b-vision-preview',messages:[{role:'system',content:sys},{role:'user',content:[{type:'image_url',image_url:{url:`data:${req.file.mimetype};base64,${b64}`}},{type:'text',text:question}]}],max_tokens:1024}) });
    if(!r.ok){const e=await r.json();throw new Error(e.error?.message);}
    const data = await r.json();
    res.json({reply:data.choices[0].message.content});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/execute', async (req,res) => {
  const {code,language='javascript'} = req.body;
  if(language!=='javascript') return res.json({output:`// ${language} execution not supported in browser mode.\n// JARVIS can analyze your code instead.`});
  let output='';
  const con={log:(...a)=>output+=a.join(' ')+'\n',error:(...a)=>output+='ERROR: '+a.join(' ')+'\n',warn:(...a)=>output+='WARN: '+a.join(' ')+'\n'};
  try { new Function('console',code)(con); res.json({output:output||'// No output'}); } catch(e){ res.json({output:`Error: ${e.message}`}); }
});

app.post('/api/auth', (req,res) => {
  const {password} = req.body;
  password===ADMIN_PASS ? res.json({success:true}) : res.status(401).json({success:false,error:'Invalid credentials'});
});

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`⚡ JARVIS Mark III Backend — Port ${PORT}`));
