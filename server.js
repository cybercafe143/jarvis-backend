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

const GROQ_KEY     = process.env.GROQ_KEY     || '';
const SERPER_KEY   = process.env.SERPER_KEY   || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ══════════════════════════════════════════════════════
//  JARVIS CORE SYSTEM PROMPT — v4.2
//  Key fixes from v4.1:
//  - Explicit "sir" rules
//  - No forced questions every message
//  - Casual = short
//  - No unsolicited suggestions
// ══════════════════════════════════════════════════════
const JARVIS_CORE = `You are J.A.R.V.I.S — Kartik Yadav ka personal AI. Generic assistant nahi — tujhe ek distinct voice aur identity hai.

━━━ WHO YOU ARE ━━━
Tu sochta hai like:
• Tony Stark ka JARVIS — calm, precise, dry wit
• Senior engineer jo real products ship kar chuka hai
• Best friend jo sab jaanta hai

Kartik ke baare mein:
• BCA 4th sem, AI & Data Analytics, LNCT Bhopal
• Built JARVIS (you), Telegram bot, Chrome extension for WhatsApp automation
• Runs CyberCafe143 in Bhopal — business + tech dono samajhta hai
• Skills: JavaScript, Node.js, Express, Python, Java, ML basics
• GitHub: cybercafe143 | Portfolio: kartikdev.best
• Stock trading, gaming, AI mein interest hai
• Hinglish mein naturally baat karta hai

━━━ CRITICAL RESPONSE RULES — FOLLOW EXACTLY ━━━

1. "Sir" — MAXIMUM 1 baar per response. Agar natural nahi lagta toh use hi mat karo. "Sir sir sir" bilkul band.

2. Har message ke end mein question mat poocho. Only ask when tujhe specific info genuinely chahiye. User ne kuch bola → respond → bas. Question optional hai, mandatory nahi.

3. Casual greeting/acknowledgement → MAX 2 sentences. "HLW", "ok got it", "wow great" → 1-2 line reply. Essay mat likhna.

4. Unsolicited suggestions mat de. User ne WhatsApp ke baare mein nahi poochha → WhatsApp suggest mat karo. Jo poochha uska jawab do.

5. Padding bilkul nahi:
   ❌ "I'd be happy to help you with that"
   ❌ "That's a great question!"
   ❌ "Certainly! Of course!"
   ❌ "As your personal AI assistant, I..."
   ❌ "I'd like to note that..."

6. Seedha point pe aao. Pehla sentence = answer ya key insight. Warmup nahi.

7. Ek message mein ek topic. User ne Modi poochha → Modi ka jawab. WA automation suggest mat karo unprompted.

8. Short questions → short answers. Deep questions → deep answers. Calibrate karo.

━━━ HOW YOU THINK ━━━
Before answering internally ask:
• User ko actually kya chahiye (literally jo poochha + implicit intent)?
• Kya ek sharper way hai yeh kehne ka?
• Jo main bolne wala hoon — kya yeh genuinely useful hai ya filler?

━━━ QUALITY STANDARDS ━━━
• Har answer mein kuch aisa hona chahiye jo user already nahi jaanta tha
• Agar user ka approach better ho sakta hai, seedha bolo
• Fact vs opinion clearly distinguish karo
• Code tasks: working, clean, edge cases mention karo
• Career advice: Kartik ki actual situation specific raho

━━━ JARVIS vs GENERIC AI ━━━
Generic: "There are many frameworks you could use..."
JARVIS:  "Express use kar — already jaanta hai, aur jo build kar raha hai uske liye Nest overkill hai."

Generic: "Machine learning is a broad field..."
JARVIS:  "Sem 4 mein theory kar li — aur real cheez banana hai toh pandas + sklearn + ek Kaggle project. That's it."

Generic: "I hope that helps! Let me know if you need anything else."
JARVIS:  [just gives the answer and stops]`;

// ══════════════════════════════════════════════════════
//  TONE OVERRIDES
// ══════════════════════════════════════════════════════
const TONES = {
  jarvis:   '',
  coder:    '\n\n[CODER MODE] Code quality pe focus. Production-ready code. Non-obvious logic pe comments. Edge cases mention karo. Always proper language tags use karo.',
  teacher:  '\n\n[TEACHER MODE] Step by step. Ek strong analogy per concept. End mein ek samajh check karne wala question (sirf teacher mode mein allowed). Hinglish freely support karo.',
  brutal:   '\n\n[BRUTAL MODE] Zero sugarcoating. Approach galat hai toh seedha bolo. Code bad hai toh kyun bolo. Senior dev code review style.',
  creative: '\n\n[CREATIVE MODE] Surprising, original, expressive. Generic mat bano. Risk lo. Kuch aisa do jo user khud nahi sooch sakta tha.',
  friday:   '\n\n[FRIDAY MODE] F.R.I.D.A.Y — sharp, fast, occasionally sarcastic. Punchy one-liners. Hinglish natural.',
};

// ══════════════════════════════════════════════════════
//  INTENT DETECTION
// ══════════════════════════════════════════════════════
function detectIntent(message, history = []) {
  const m   = message.toLowerCase().trim();
  const ctx = history.slice(-6).map(h => h.content || '').join(' ').toLowerCase();

  if (/\b(sad|dukh|rone|ro rha|hurt|alone|akela|depressed|anxious|scared|dar|pareshan|stressed|tension|heartbreak|breakup|gussa|angry|frustrated|bura lag|nahi lag raha)\b/.test(m))
    return { intent:'emotional',    needsSearch:false, complexity:'simple',   temp:0.85 };

  if (/^(hi|hello|hey|hii|hlo|hlw|hanji|haan|nahi|ok|okay|hmm|hm|thanks|shukriya|accha|theek|thik|nice|good|great|wow|yaar|bhai|yrr|bro|sup|namaste|lol|haha|xd|got it|ahhh|ohh|nice one)[\s!?.,]*$/.test(m) || m.length < 14)
    return { intent:'casual',       needsSearch:false, complexity:'simple',   temp:0.85 };

  if (/^(aur|or |and then|phir|next|uske baad|matlab|means|explain more|aur batao|elaborate|example do|iska matlab|what about|what if|lekin|but |why not|how about|yeh wala|iske baad)/.test(m))
    return { intent:'followup',     needsSearch:false, complexity:'standard', temp:0.7 };

  if (/([a-zA-Z0-9-]+\.(com|in|net|org|co\.in|io|pk|me|store|shop|xyz|dev|tech|online))/.test(m))
    return { intent:'site_analysis',needsSearch:true,  complexity:'deep',    temp:0.5 };

  if (/\b(code|function|class|api|bug|error|fix|debug|script|program|implement|build|create.*app|write.*code|write.*function|python|javascript|java|node\.?js|react|sql|css|html|algorithm|logic|array|loop|async|promise|fetch|express|mongodb|mysql|leetcode|dsa|data structure)\b/.test(m) || /```/.test(m))
    return { intent:'code',         needsSearch:false, complexity:'deep',    temp:0.3 };

  if (/(\d[\+\-\*\/\^]\d|solve|calculate|equation|formula|integral|derivative|probability|statistics|percentage|standard deviation|mean|median|regression|matrix|\bpca\b|\bsvm\b)/.test(m))
    return { intent:'math',         needsSearch:false, complexity:'deep',    temp:0.1 };

  if (/(latest|recent|new|today|abhi|current|2024|2025|2026|aaj|kal|news|khabar|update|weather|mausam|price|kitna hai|rate|score|match|ipl|cricket|stock|bitcoin|crypto|movie|release|launch|exam result|government|networth|net worth|salary)/.test(m))
    return { intent:'realtime',     needsSearch:true,  complexity:'standard', temp:0.6 };

  if (/\b(explain|analyze|compare|difference|pros.?cons|why does|how does|architecture|design|step.?by.?step|in detail|research|comprehensive|elaborate|machine learning|neural|deep learning|system design|roadmap|strategy|difference between)\b/.test(m))
    return { intent:'analysis',     needsSearch:false, complexity:'deep',    temp:0.55 };

  if (/\b(write|draft|story|poem|script|email|letter|proposal|brainstorm|ideas|creative|imagine|generate|likho|likhna|banner|caption|post|tweet)\b/.test(m))
    return { intent:'creative',     needsSearch:false, complexity:'creative', temp:0.95 };

  if (/\b(job|career|internship|resume|interview|salary|company|placement|skill|learn|course|certificate|bca|mca|college|startup|freelance)\b/.test(m))
    return { intent:'career',       needsSearch:false, complexity:'standard', temp:0.65 };

  return   { intent:'general',      needsSearch:m.length > 40, complexity:'standard', temp:0.7 };
}

function getIntentInjection(intent) {
  const map = {
    emotional:     'User kuch emotional share kar raha hai. Pehle acknowledge karo, advice baad mein (sirf agar pooche). Warm aur human raho. Solutions pe mat daudo.',
    casual:        'CASUAL CHAT. 1-2 sentences MAX. Natural texting friend style. Koi essay nahi, koi suggestions nahi. Bas natural reply.',
    followup:      'FOLLOW-UP hai. Jo pehle cover ho chuka hai usse dobara explain mat karo. Directly build karo prior context pe.',
    code:          'CODE TASK. Pehle working code do. Correct language tags use karo. Code ke baad briefly explain karo key decisions (1-3 sentences). Edge cases/gotchas end mein.',
    math:          'MATH TASK. Full working step by step dikhao. Formula pehle, phir actual numbers se apply karo. Arithmetic double-check karo. Final answer bold karo.',
    analysis:      'DEEP ANALYSIS. Clear structure use karo — headers agar multiple topics hain. Comprehensive but filler cut karo. Koi non-obvious insight zaroori.',
    realtime:      'REAL-TIME INFO. Web search data neeche hai. Synthesize karo — facts list mat karo. Most important/recent info pehle. Sources naturally cite karo.',
    site_analysis: 'SITE ANALYSIS. Sab useful extract karo: name, kya karta hai, pricing, contact, social links, location, hours, tech stack if visible. Clear sections use karo.',
    creative:      'CREATIVE TASK. Surprising aur specific raho. Clichés avoid karo. Kartik ka actual context relate karo jahan relevant ho.',
    career:        'CAREER ADVICE. Kartik ki actual situation specific raho (BCA, Bhopal, uske projects). Generic advice nahi — specifically USE ko kya karna chahiye.',
    general:       'Focused, useful answer do. Ek insight include karo jo user probably already nahi jaanta tha.',
  };
  return map[intent] || map.general;
}

// ── SHORT PROMPT: simple/casual ke liye — saves ~800 tokens per request ──
const JARVIS_SHORT = `You are JARVIS — Kartik ka personal AI assistant. Sharp, direct, no filler.
Kartik: BCA student, LNCT Bhopal, runs CyberCafe143, builds AI projects.
Rules: casual/greeting → MAX 2 sentences. No "sir sir sir". No forced questions. No padding.`;

// ── Tiered system prompt (huge token saver) ──
function buildSystemPrompt(complexity, tone, extraCtx=''){
  const toneStr = TONES[tone]||'';
  if(complexity === 'simple'){
    // Short prompt for casual chat — saves ~800 tokens
    return JARVIS_SHORT + toneStr + extraCtx;
  }
  return JARVIS_CORE + toneStr + extraCtx;
}

function pickModel(complexity) {
  const map = {
    // FIX: Use 70b for simple too — same TPM limit but better quality
    // 8b instant was hitting 6000 TPM with large prompts anyway
    simple:   { model:'llama-3.3-70b-versatile', maxTokens:300  }, // short output
    standard: { model:'llama-3.3-70b-versatile', maxTokens:1500 },
    deep:     { model:'llama-3.3-70b-versatile', maxTokens:2800 },
    creative: { model:'llama-3.3-70b-versatile', maxTokens:2200 },
  };
  return map[complexity] || map.standard;
}

// ── Groq call with auto-retry on 429 ──
async function callGroqStream(model, messages, maxTokens, temperature){
  const maxRetries = 3;
  for(let attempt = 0; attempt < maxRetries; attempt++){
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({model, messages, max_tokens:maxTokens, temperature, stream:true})
    });
    if(gr.ok) return gr;
    const err = await gr.json();
    const errMsg = err.error?.message || '';
    // Rate limit — extract wait time and retry
    if(gr.status === 429){
      const waitMatch = errMsg.match(/try again in ([\d.]+)s/i);
      const waitSecs = waitMatch ? parseFloat(waitMatch[1]) : (attempt+1)*15;
      console.log(`[Groq] Rate limit hit, waiting ${waitSecs}s (attempt ${attempt+1}/${maxRetries})`);
      // Send a "waiting" token to frontend so user knows
      await new Promise(r => setTimeout(r, waitSecs * 1000));
      continue;
    }
    throw new Error(errMsg || `HTTP ${gr.status}`);
  }
  throw new Error('Rate limit — too many requests. Wait 1 minute and try again.');
}

// ══════════════════════════════════════════════════════
//  CONTEXT WINDOW MANAGER
// ══════════════════════════════════════════════════════
function buildContextWindow(history, maxMessages=30, maxChars=12000) {
  const valid=(history||[]).filter(m=>m?.role&&m?.content?.trim());
  if(!valid.length)return[];
  const anchor=valid.slice(0,2);
  const recent=valid.slice(-maxMessages);
  const merged=[...anchor,...recent.filter(m=>!anchor.includes(m))];
  let total=merged.reduce((s,m)=>s+m.content.length,0);
  let i=2;
  while(total>maxChars&&i<merged.length){total-=merged[i].content.length;merged.splice(i,1);}
  return merged;
}

// ══════════════════════════════════════════════════════
//  SESSION SUMMARIZER (cached — not every request)
// ══════════════════════════════════════════════════════
const summaryCache = new Map(); // chatId → {summary, msgCount}

async function summarizeSession(history, chatId='default') {
  if(!GROQ_KEY||history.length<10)return'';
  const cached=summaryCache.get(chatId);
  // Only regenerate every 6 new messages
  if(cached&&history.length-cached.msgCount<6)return cached.summary;
  try{
    const sample=history.slice(-16).map(m=>`${m.role}: ${m.content.slice(0,100)}`).join('\n');
    const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({
        model:'llama-3.1-8b-instant',
        messages:[
          {role:'system',content:'Summarize this conversation in 3-4 bullet points. Focus on: topics covered, decisions made, code written, problems solved. Be specific and concise. Output only bullets, no intro.'},
          {role:'user',content:sample}
        ],
        max_tokens:180,temperature:0.2
      })
    });
    const d=await res.json();
    const summary=d.choices?.[0]?.message?.content||'';
    summaryCache.set(chatId,{summary,msgCount:history.length});
    return summary;
  }catch(e){return'';}
}

// ══════════════════════════════════════════════════════
//  MEMORY (Supabase)
// ══════════════════════════════════════════════════════
async function getMemories(userId='kartik',limit=10){
  if(!SUPABASE_URL||!SUPABASE_KEY)return[];
  try{
    const res=await fetch(`${SUPABASE_URL}/rest/v1/memories?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`,{
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`}
    });
    return await res.json();
  }catch(e){return[];}
}

async function saveMemory(userId='kartik',content,summary){
  if(!SUPABASE_URL||!SUPABASE_KEY)return;
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/memories`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json',Prefer:'return=minimal'},
      body:JSON.stringify({user_id:userId,content,summary,created_at:new Date().toISOString()})
    });
  }catch(e){}
}

async function extractMemory(history){
  if(!GROQ_KEY||history.length<4)return null;
  try{
    const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({
        model:'llama-3.1-8b-instant',
        messages:[
          {role:'system',content:`Extract 1-2 specific facts worth remembering about the user from this conversation.
Good: "User is building a dairy app with Claude API", "User prefers dark theme", "User fixed node-fetch by downgrading to v2"
Bad: "User asked about coding", "User said hello"
Start each with "User". Only output facts, one per line. If nothing worth saving, output nothing.`},
          {role:'user',content:history.slice(-4).map(m=>`${m.role}: ${m.content.slice(0,150)}`).join('\n')}
        ],
        max_tokens:100,temperature:0.1
      })
    });
    const d=await res.json();
    return d.choices?.[0]?.message?.content?.trim()||null;
  }catch(e){return null;}
}

app.get('/api/memory',async(req,res)=>res.json({memories:await getMemories()}));

app.delete('/api/memory/:id',async(req,res)=>{
  if(!SUPABASE_URL||!SUPABASE_KEY)return res.json({success:false});
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${req.params.id}`,{
      method:'DELETE',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`}
    });
    res.json({success:true});
  }catch(e){res.json({success:false});}
});

// ══════════════════════════════════════════════════════
//  WEB SEARCH
// ══════════════════════════════════════════════════════
async function webSearch(query){
  if(SERPER_KEY){
    try{
      const res=await fetch('https://google.serper.dev/search',{
        method:'POST',
        headers:{'X-API-KEY':SERPER_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({q:query,num:8,gl:'in',hl:'en'})
      });
      const d=await res.json();
      const results=[];
      if(d.answerBox?.answer||d.answerBox?.snippet)
        results.push({title:'Direct Answer',snippet:d.answerBox.answer||d.answerBox.snippet,url:d.answerBox.link||''});
      if(d.knowledgeGraph?.description)
        results.push({title:d.knowledgeGraph.title,snippet:d.knowledgeGraph.description,url:d.knowledgeGraph.descriptionLink||''});
      (d.organic||[]).slice(0,5).forEach(r=>results.push({title:r.title,snippet:r.snippet||'',url:r.link}));
      return results.slice(0,7);
    }catch(e){}
  }
  try{
    const res=await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const d=await res.json();
    const results=[];
    if(d.AbstractText)results.push({title:d.Heading,snippet:d.AbstractText,url:d.AbstractURL});
    (d.RelatedTopics||[]).slice(0,4).forEach(t=>{if(t.Text)results.push({title:t.Text.slice(0,60),snippet:t.Text,url:t.FirstURL||''});});
    return results;
  }catch(e){return[];}
}

function extractSiteUrl(query){
  const m=query.match(/([a-zA-Z0-9-]+\.(com|in|net|org|co\.in|io|pk|me|store|shop|xyz|dev|tech|online))/i);
  return m?m[0]:null;
}

async function fetchSiteContent(url){
  try{
    if(!url.startsWith('http'))url='https://'+url;
    const res=await fetch(url,{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'},
      timeout:10000
    });
    if(!res.ok)return null;
    const html=await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/<style[\s\S]*?<\/style>/gi,'')
      .replace(/<nav[\s\S]*?<\/nav>/gi,'')
      .replace(/<footer[\s\S]*?<\/footer>/gi,'')
      .replace(/<[^>]+>/g,' ')
      .replace(/\s{3,}/g,'\n')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
      .trim().slice(0,8000);
  }catch(e){return null;}
}

// ══════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════
app.get('/',(req,res)=>res.json({status:'JARVIS Online ⚡',version:'4.2'}));
app.get('/api/health',(req,res)=>res.json({
  status:'ok',version:'4.2',
  groq:!!GROQ_KEY,serper:!!SERPER_KEY,memory:!!SUPABASE_URL
}));

// ══════════════════════════════════════════════════════
//  MAIN CHAT — SSE STREAMING
//  FIX: doneSent flag prevents duplicate 'done' events
// ══════════════════════════════════════════════════════
app.post('/api/chat',async(req,res)=>{
  const{message,history=[],tone='jarvis',hinglish=false,searchEnabled=true,chatId='default'}=req.body;
  if(!message?.trim())return res.status(400).json({error:'Message is empty'});

  const detected=detectIntent(message,history);
  const{model,maxTokens}=pickModel(detected.complexity);
  const contextHistory=buildContextWindow(history,30,14000);

  // Session summary — only if long convo (cached)
  let sessCtx='';
  if(history.length>10){
    const summary=await summarizeSession(history,chatId);
    if(summary)sessCtx='\n\n━━━ THIS CONVERSATION SO FAR ━━━\n'+summary;
  }

  // Long-term memory
  const memories=await getMemories('kartik',8);
  let memCtx='';
  if(memories.length>0){
    memCtx='\n\n━━━ LONG-TERM MEMORY ━━━\n'+
      memories.map(m=>'• '+(m.summary||m.content)).filter(Boolean).slice(0,6).join('\n');
  }

  const hinglishCtx=hinglish?'\n\n━━━ LANGUAGE ━━━\nHinglish mode. Respond naturally mixing Hindi+English jaise Bhopal/Delhi developer baat karta hai.':'';

  // Web search / site fetch
  let searchCtx='',searchUsed=false,sources=[],siteAnalyzed=null;
  if(searchEnabled&&detected.needsSearch){
    const siteUrl=extractSiteUrl(message);
    if(siteUrl){
      const content=await fetchSiteContent(siteUrl);
      if(content){searchCtx=`\n\n━━━ SITE CONTENT: ${siteUrl} ━━━\n${content}`;siteAnalyzed=siteUrl;searchUsed=true;}
    }
    if(!searchCtx){
      const results=await webSearch(message);
      if(results.length>0){
        searchCtx='\n\n━━━ WEB SEARCH RESULTS ━━━\n'+results.map((r,i)=>`[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
        sources=results;searchUsed=true;
      }
    }
  }

  const intentCtx=`\n\n━━━ CURRENT TASK ━━━\n${getIntentInjection(detected.intent)}`;
  const toneOverride=TONES[tone]||'';
  const systemPrompt=JARVIS_CORE+toneOverride+memCtx+sessCtx+hinglishCtx+searchCtx+intentCtx;
  const messages=[{role:'system',content:systemPrompt},...contextHistory,{role:'user',content:message}];

  // SSE headers
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');

  res.write(`data: ${JSON.stringify({type:'meta',intent:detected.intent,model,searchUsed,siteAnalyzed,sources})}\n\n`);

  try{
    const gr=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({model,messages,max_tokens:maxTokens,temperature:detected.temp,stream:true})
    });

    if(!gr.ok){
      const e=await gr.json();
      res.write(`data: ${JSON.stringify({type:'error',error:e.error?.message||'Groq error'})}\n\n`);
      return res.end();
    }

    let fullReply='';
    let doneSent=false; // ← FIX: prevents duplicate done events

    gr.body.on('data',chunk=>{
      const lines=chunk.toString().split('\n').filter(l=>l.startsWith('data: '));
      for(const line of lines){
        const d=line.slice(6);
        if(d==='[DONE]'){
          // ← FIX: only send done once
          if(!doneSent){doneSent=true;res.write('data: {"type":"done"}\n\n');}
          return;
        }
        try{
          const p=JSON.parse(d);
          const t=p.choices?.[0]?.delta?.content;
          if(t){fullReply+=t;res.write(`data: ${JSON.stringify({type:'token',token:t})}\n\n`);}
        }catch(e){}
      }
    });

    gr.body.on('end',()=>{
      // ← FIX: only send done if not already sent
      if(!doneSent){doneSent=true;res.write('data: {"type":"done"}\n\n');}
      res.end();
      // Background memory extraction
      const updatedHistory=[...contextHistory,{role:'user',content:message},{role:'assistant',content:fullReply}];
      extractMemory(updatedHistory).then(fact=>{if(fact)saveMemory('kartik',message,fact);});
    });

    gr.body.on('error',()=>{
      if(!doneSent){doneSent=true;res.write('data: {"type":"done"}\n\n');}
      res.end();
    });

  }catch(e){
    res.write(`data: ${JSON.stringify({type:'error',error:e.message})}\n\n`);
    res.end();
  }
});

// ══════════════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════════════
app.post('/api/upload',upload.single('file'),async(req,res)=>{
  try{
    const{instruction='Analyze this file thoroughly',tone='jarvis'}=req.body;
    if(!req.file)return res.status(400).json({error:'No file'});
    const{originalname:filename,mimetype,buffer}=req.file;
    let fileContent='';

    if(mimetype==='application/pdf'||filename.toLowerCase().endsWith('.pdf')){
      try{const pdf=await pdfParse(buffer);fileContent=`[PDF — ${pdf.numpages} pages]\n\n${pdf.text}`;}
      catch(e){fileContent='[PDF extraction failed]';}
    } else if(mimetype.startsWith('image/')){
      const b64=buffer.toString('base64');
      const sys=JARVIS_CORE+(TONES[tone]||'');
      const vRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${GROQ_KEY}`},
        body:JSON.stringify({
          model:'llama-3.2-11b-vision-preview',
          messages:[
            {role:'system',content:sys},
            {role:'user',content:[
              {type:'image_url',image_url:{url:`data:${mimetype};base64,${b64}`}},
              {type:'text',text:instruction}
            ]}
          ],max_tokens:1500
        })
      });
      if(!vRes.ok){const e=await vRes.json();throw new Error(e.error?.message);}
      const vData=await vRes.json();
      return res.json({reply:vData.choices[0].message.content,fileType:'image'});
    } else {
      fileContent=buffer.toString('utf-8');
    }

    if(fileContent.length>14000)fileContent=fileContent.slice(0,14000)+'\n\n[truncated]';
    const sys=JARVIS_CORE+(TONES[tone]||'');
    const groqRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({
        model:'llama-3.3-70b-versatile',
        messages:[{role:'system',content:sys},{role:'user',content:`File: **${filename}**\n\`\`\`\n${fileContent}\n\`\`\`\n\nInstruction: ${instruction}`}],
        max_tokens:2500,temperature:0.4
      })
    });
    if(!groqRes.ok){const e=await groqRes.json();throw new Error(e.error?.message);}
    const data=await groqRes.json();
    res.json({reply:data.choices[0].message.content,fileType:'file',tokens:data.usage?.total_tokens});
  }catch(e){res.status(500).json({error:e.message});}
});

// ══════════════════════════════════════════════════════
//  CODE EXECUTE (JS sandbox)
// ══════════════════════════════════════════════════════
app.post('/api/execute',(req,res)=>{
  const{code,language='javascript'}=req.body;
  if(language!=='javascript')return res.json({output:`// ${language} execution not available. Run locally.`});
  let output='';
  const con={
    log:(...a)=>output+=a.join(' ')+'\n',
    error:(...a)=>output+='ERROR: '+a.join(' ')+'\n',
    warn:(...a)=>output+='WARN: '+a.join(' ')+'\n',
    table:(...a)=>output+=JSON.stringify(a)+'\n',
  };
  try{new Function('console',code)(con);res.json({output:output||'// No output'});}
  catch(e){res.json({output:`Error: ${e.message}`});}
});

const PORT=process.env.PORT||3000;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';

const VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ'; // Daniel — JARVIS style

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
    .slice(0, 800);
}

const VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ'; // Liam

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
    .slice(0, 800);
}

app.post('/api/speak', async (req, res) => {
  if (!ELEVENLABS_KEY) {
    console.log('No ElevenLabs key!');
    return res.status(400).json({ error: 'No key' });
  }
  
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });

  const cleaned = cleanForTTS(text);
  console.log('TTS request:', cleaned.slice(0, 50));

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      {
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
      }
    );

    console.log('ElevenLabs status:', response.status);

    if (!response.ok) {
      const err = await response.text();
      console.log('ElevenLabs error:', err);
      return res.status(500).json({ error: 'ElevenLabs failed: ' + err });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    response.body.pipe(res);

  } catch (e) {
    console.log('Speak error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
