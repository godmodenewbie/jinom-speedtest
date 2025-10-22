// ===== CONFIG =====
const DIRECTORY_URL = `https://directory-speedtest.noobhomelab.icu`; // ganti kalau perlu
const DEFAULT_SECONDS = 10;
const DEFAULT_STREAMS = 8;

// ===== DOM & STATE =====
const $ = (id) => document.getElementById(id);
const state = {
  servers: [],
  selected: null,
  stopFlag: false,
  downBytes: 0,
  upBytes: 0,
  gaugeMax: 1000
};

// ===== UTIL =====
function log(...a){ console.log("[speedtest]", ...a); }
function mbps(bytes, seconds){ return (bytes * 8) / (seconds * 1e6); }
function fmt(n, d=2){ return Number(n).toFixed(d); }
function readIntOrDefault(id, def){ const el=$(id); const v=el?parseInt(el.value||"",10):NaN; return Number.isFinite(v)?v:def; }

// ===== SPEEDOMETER =====
const GAUGE = { start:-130, end:130 };
function polar(r, ang){ const a=(ang-90)*Math.PI/180; return {x:r*Math.cos(a), y:r*Math.sin(a)}; }
function arcPath(r, a0, a1){ const p0=polar(r,a0), p1=polar(r,a1); const large=(a1-a0)>180?1:0; return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`; }
function setupGauge(){ const bg=$("arcBg"), val=$("arcVal"); if(!bg||!val) return; bg.setAttribute("d", arcPath(90, GAUGE.start, GAUGE.end)); val.setAttribute("d", arcPath(90, GAUGE.start, GAUGE.start)); drawTicks(); setGaugeMax(1000); }
function drawTicks(){ const g=$("ticks"); if(!g) return; g.innerHTML=""; const max=state.gaugeMax; const steps=[0,.1,.2,.3,.4,.5,.6,.7,.8,.9,1]; steps.forEach(fr=>{ const ang=GAUGE.start+(GAUGE.end-GAUGE.start)*fr; const p0=polar(84,ang),p1=polar(92,ang),t=polar(72,ang); const ln=document.createElementNS('http://www.w3.org/2000/svg','line'); ln.setAttribute('x1',p0.x); ln.setAttribute('y1',p0.y); ln.setAttribute('x2',p1.x); ln.setAttribute('y2',p1.y); ln.setAttribute('stroke', fr%0.5===0?'#cfd6ff':'#3a4164'); ln.setAttribute('stroke-width', fr%0.5===0?2:1); g.appendChild(ln); if(fr%0.5===0){ const tx=document.createElementNS('http://www.w3.org/2000/svg','text'); tx.setAttribute('x',t.x); tx.setAttribute('y',t.y+4); tx.setAttribute('text-anchor','middle'); tx.setAttribute('fill','#9aa3c7'); tx.setAttribute('font-size','8'); tx.textContent=Math.round(max*fr); g.appendChild(tx); } }); const sl=$("scaleLabel"); if(sl) sl.textContent=`Scale: 0–${max} Mbps (Auto)`; }
function setGaugeMax(max){ state.gaugeMax=max; drawTicks(); }
function chooseScaleFor(v){ const levels=[50,100,250,500,1000,2000,5000,10000,20000]; for(const lv of levels){ if(v<=lv*0.85) return lv; } return levels.at(-1); }
function updateGauge(currMbps){ const arcVal=$("arcVal"), needle=$("needle"), speedNum=$("speedNum"); if(!arcVal||!needle||!speedNum) return; const need=chooseScaleFor(currMbps||0); if(need!==state.gaugeMax) setGaugeMax(need); const frac=Math.max(0,Math.min(1,(currMbps||0)/state.gaugeMax)); const ang=GAUGE.start+(GAUGE.end-GAUGE.start)*frac; needle.setAttribute("transform",`rotate(${ang})`); arcVal.setAttribute("d", arcPath(90, GAUGE.start, ang)); speedNum.textContent=(currMbps||0).toFixed(2); }

// ===== BADGES (Server + IP/ISP) =====
function ensureBadges(){
  // cari elemen gauge untuk menaruh badge di bawahnya
  const host = document.querySelector(".gauge") || $("gaugeSvg")?.parentElement || document.body;
  if (!host) return;

  let badges = document.getElementById("netBadges");
  if (!badges){
    badges = document.createElement("div");
    badges.id = "netBadges";
    badges.style.display = "flex";
    badges.style.flexWrap = "wrap";
    badges.style.gap = "8px";
    badges.style.justifyContent = "center";
    badges.style.margin = "8px 0 2px";
    host.after(badges);
  }

  if (!document.getElementById("serverText")){
    const pill = document.createElement("div");
    pill.style.cssText = "display:inline-flex;align-items:center;gap:6px;background:#0e1220;border:1px solid #222842;border-radius:999px;padding:6px 10px;color:#9aa3c7;font-size:12px";
    pill.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="opacity:.9">
        <rect x="3" y="4" width="18" height="6" rx="2" stroke="#9aa3c7"/>
        <rect x="3" y="14" width="18" height="6" rx="2" stroke="#9aa3c7"/>
        <circle cx="8" cy="7" r="1" fill="#9aa3c7"/>
        <circle cx="8" cy="17" r="1" fill="#9aa3c7"/>
      </svg>
      <span id="serverText">Server: -</span>`;
    badges.appendChild(pill);
  }

  if (!document.getElementById("clientIpText")){
    const pill = document.createElement("div");
    pill.style.cssText = "display:inline-flex;align-items:center;gap:6px;background:#0e1220;border:1px solid #222842;border-radius:999px;padding:6px 10px;color:#9aa3c7;font-size:12px";
    pill.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="opacity:.9">
        <path d="M12 3a9 9 0 1 0 9 9" stroke="#9aa3c7"/>
        <circle cx="12" cy="12" r="3" stroke="#9aa3c7"/>
      </svg>
      <span id="clientIpText">IP: -</span>
      <span id="clientIspText">— ISP: -</span>`;
    badges.appendChild(pill);
  }
}

async function getClientNetworkInfo(){
  try{
    const r = await fetch("https://ipapi.co/json/");
    const j = await r.json();
    if (j?.ip) $("clientIpText").textContent = `IP: ${j.ip}`;
    const isp = j.org || j.isp || (j.asn ? (j.asn + (j.asn_org ? " " + j.asn_org : "")) : null);
    if (isp) $("clientIspText").textContent = `— ISP: ${isp}`;
  }catch(e){
    try{
      const r2 = await fetch("https://api.ipify.org?format=json");
      const j2 = await r2.json();
      if (j2?.ip) $("clientIpText").textContent = `IP: ${j2.ip}`;
    }catch(_){}
  }
}
function updateServerDisplay(s){
  const txt = $("serverText");
  if (!txt || !s) return;
  txt.textContent = `Server: ${s.city || "Unknown"}${s.region ? " ("+s.region+")" : ""} • ${s.url || s.URL}`;
}

// ===== RANDOM BYTES (64KB → 4MiB) =====
const BASE64K = new Uint8Array(65536); crypto.getRandomValues(BASE64K);
function makeChunk(bytes){ const out=new Uint8Array(bytes); for(let off=0; off<out.length; off+=BASE64K.length) out.set(BASE64K, off); return out; }
const UP_CHUNK = makeChunk(4 << 20); // 4 MiB

// ===== DIRECTORY & SERVER PICK =====
function normalizeNodeUrl(entry){
  const u = entry?.url || entry?.URL || entry?.baseUrl || entry?.baseURL || "";
  if (typeof u !== "string" || !u) return "";
  return u.replace(/\/+$/,"");
}
async function measureLatency(baseUrl, count=4, timeoutMs=1500){
  const samples=[];
  for(let i=0;i<count;i++){
    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try{
      await fetch(baseUrl + "/api/v1/latency?t=" + Math.random(), { cache:"no-store", signal: ctrl.signal });
      samples.push(performance.now() - t0);
    }catch{} finally{ clearTimeout(to); }
  }
  if (!samples.length) throw new Error("latency failed");
  const avg=samples.reduce((a,b)=>a+b,0)/samples.length;
  const mean=avg;
  const jitter=Math.sqrt(samples.reduce((s,x)=>s+Math.pow(x-mean,2),0)/samples.length);
  return { avg, jitter };
}
async function autoSelectServer(){
  let list=[];
  try{
    const r = await fetch(DIRECTORY_URL + "/api/v1/servers", { cache:"no-store" });
    list = await r.json();
  }catch(e){ log("Directory error:", e); return; }

  const candidates = (Array.isArray(list)?list:[]).map(s=>({ ...s, url: normalizeNodeUrl(s) })).filter(s=>s.url);
  if (!candidates.length){ log("No valid server urls"); return; }

  // fallback pertama
  let bestServer = candidates[0], bestPing = null;

  // coba ukur ping
  const results = await Promise.all(candidates.map(async s=>{
    try{ const r = await measureLatency(s.url, 4, 1500); return { s, r }; }
    catch{ return { s, r:null }; }
  }));
  const ok = results.filter(x=>x.r);
  if (ok.length){
    ok.sort((a,b)=> a.r.avg - b.r.avg);
    bestServer = ok[0].s; bestPing = ok[0].r;
  } else {
    console.warn("Semua ping gagal (CORS/mixed-content kemungkinan). Pakai server pertama:", bestServer.url);
  }

  state.selected = bestServer;
  updateServerDisplay(bestServer);
  if (bestPing){
    if ($("latency")) $("latency").textContent = `${bestPing.avg.toFixed(1)} ms`;
    if ($("jitter"))  $("jitter").textContent  = `${bestPing.jitter.toFixed(1)} ms`;
  }
}

// ===== DOWNLOAD =====
async function runDownload(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  const tEnd = Date.now() + seconds*1000;
  let total = 0; state.downBytes = 0;

  const worker = async () => {
    while(Date.now() < tEnd && !state.stopFlag){
      const resp = await fetch(baseUrl + "/api/v1/download?time=2", { cache:"no-store" });
      const reader = resp.body.getReader();
      for(;;){
        const {value, done} = await reader.read();
        if (done) break;
        total += value.byteLength;
        state.downBytes += value.byteLength;
        if (Date.now() >= tEnd || state.stopFlag){ try{ reader.cancel(); }catch{} break; }
      }
    }
  };
  const tick = setInterval(()=> onProgress(total), 120);
  await Promise.all(Array.from({length: streams}, worker));
  clearInterval(tick); onProgress(total); return total;
}

// ===== UPLOAD =====
/* function supportsStreamingUpload(){ try{ const rs=new ReadableStream({start(c){c.close()}}); new Request("about:blank",{method:"POST",body:rs,duplex:"half"}); return true; }catch{ return false } }
function makeUploadStream(durationMs, onEnqueue){ const end=Date.now()+durationMs; return new ReadableStream({ pull(c){ if(Date.now()>=end||state.stopFlag){ c.close(); return } c.enqueue(UP_CHUNK); if(onEnqueue) onEnqueue(UP_CHUNK.length); } }); }
async function runUploadStreaming(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  state.upBytes = 0;
  const durationMs = seconds*1000;
  const t0 = performance.now();

  const worker = async () => {
    try{
      let localCount = 0, serverMs = 0, serverBytes = 0;
      const stream = makeUploadStream(durationMs, n => {
        localCount += n; state.upBytes += n; onProgress(state.upBytes);
      });
      const r = await fetch(baseUrl + `/api/v1/upload?time=${seconds}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: stream,
        duplex: "half"
      });
      const j = await r.json().catch(()=>({receivedBytes:0, durationMs:0}));
      if (typeof j.receivedBytes === "number") serverBytes = j.receivedBytes;
      if (typeof j.durationMs === "number")   serverMs = j.durationMs;
      // kembalikan apa yang server catat; kalau kosong, pakai hitungan lokal
      return { bytes: serverBytes || localCount, serverMs };
    }catch(e){
      console.warn("stream worker failed:", e);
      return { bytes: 0, serverMs: 0 };
    }
  };

  const results = await Promise.all(Array.from({length: streams}, worker));
  const totalBytes = results.reduce((a,x)=>a + x.bytes, 0);
  const serverMsMax = Math.max(0, ...results.map(x=>x.serverMs||0)); // biasanya sama utk semua stream
  const elapsedLocal = (performance.now() - t0)/1000;
  const secondsUsed = serverMsMax ? (serverMsMax/1000) : elapsedLocal;

  return { bytes: totalBytes, seconds: Math.max(secondsUsed, 0.001) };
}

async function runUploadFallback(baseUrl, seconds=DEFAULT_SECONDS, streams=Math.min(DEFAULT_STREAMS,8), onProgress=()=>{}){
  const tEnd = Date.now() + seconds*1000;
  const t0 = performance.now();
  let total = 0;

  const worker = async () => {
    let sent = 0;
    while(Date.now() < tEnd && !state.stopFlag){
      await fetch(baseUrl + "/api/v1/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: UP_CHUNK
      }).catch(()=>{});
      sent += UP_CHUNK.length;
      total += UP_CHUNK.length;
      onProgress(total);
    }
    return sent;
  };

  await Promise.all(Array.from({length: streams}, worker));
  const elapsed = (performance.now() - t0)/1000;
  return { bytes: total, seconds: Math.max(elapsed, 0.001) };
}

async function runUpload(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  if (supportsStreamingUpload()){
    const res = await runUploadStreaming(baseUrl, seconds, streams, onProgress);
    if (res.bytes > 0) return res;
    console.warn("Streaming returned 0 → fallback");
  }
  return await runUploadFallback(baseUrl, seconds, Math.max(1, Math.min(8, streams)), onProgress);
}
*/

function supportsStreamingUpload() {
  try {
    const rs = new ReadableStream({ start(c){ c.close(); } });
    // bikin Request dengan body stream + duplex: 'half' (wajib agar browser kirim stream)
    // ini hanya feature-detect, tidak kirim jaringan
    //new Request("about:blank", { method: "POST", body: rs, duplex: "half" });
    new Request("about:blank", { method: "POST", body: rs });
    return true;
  } catch { return false; }
}

/* function makeUploadStream(durationMs){
  const end = Date.now() + durationMs;
  const chunk = new Uint8Array(1<<20);
  (self.crypto || window.crypto).getRandomValues(chunk);
  return new ReadableStream({
    pull(controller){
      if (Date.now() >= end || state.stopFlag){
        controller.close(); return;
      }
      controller.enqueue(chunk);
    }
  });
} */

function fillRandomBytes(buf) {
  const chunk = 65536;
  const view = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  for (let i = 0; i < view.length; i += chunk) {
    const len = Math.min(chunk, view.length - i);
    (self.crypto || window.crypto).getRandomValues(view.subarray(i, i + len));
  }
}

function makeUploadStream(durationMs, onEnqueue){
  const end = Date.now() + durationMs;
  const chunk = new Uint8Array(1<<20);
//  (self.crypto || window.crypto).getRandomValues(chunk);
  fillRandomBytes(chunk);
  return new ReadableStream({
    pull(controller){
      if (Date.now() >= end || state.stopFlag){ controller.close(); return; }
      controller.enqueue(chunk);
      if (onEnqueue) onEnqueue(chunk.length);
    }
  });
}

// Fallback non-streaming: POST kecil berulang-ulang
async function runUploadFallback(baseUrl, seconds=10, streams=4, onProgress=()=>{}){
  const tEnd = Date.now() + seconds*1000;
  const body = new Uint8Array(1<<20);
//  (self.crypto || window.crypto).getRandomValues(body);
  fillRandomBytes(body);
  let total = 0;

  const worker = async () => {
    while (Date.now() < tEnd && !state.stopFlag){
      await fetch(baseUrl + "/api/v1/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body
      }).catch(()=>{});
      total += body.byteLength;
      onProgress(total);
    }
    return total;
  };

  const results = await Promise.all(Array.from({length: streams}, worker));
  return results.reduce((a,b)=>a+b,0);
}

async function runUpload(baseUrl, seconds=10, streams=8, onProgress=()=>{}){
  state.upBytes = 0;
  const durationMs = seconds*1000;

  if (supportsStreamingUpload()){
    const worker = async () => {
      try{
        const stream = makeUploadStream(durationMs, n => { state.upBytes += n; onProgress(state.upBytes); });
        const r = await fetch(baseUrl + `/api/v1/upload?time=${seconds}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: stream,
          //duplex: "half"            // <<<<<< kunci utamanya
        });
        const j = await r.json().catch(()=>({receivedBytes:0}));
        return j.receivedBytes || 0;
      }catch{ return 0; }
    };

    const results = await Promise.all(Array.from({length: streams}, worker));
    onProgress(state.upBytes);
    const sum = results.reduce((a,b)=>a+b,0);
    if (sum > 0) return sum; // sukses streaming â†’ selesai
    // kalau semua gagal, lanjut fallback
  }

  // Fallback (tanpa streaming)
  const fb = await runUploadFallback(baseUrl, seconds, Math.max(1, Math.min(8, streams)), n=>{
    state.upBytes = n; onProgress(n);
  });
  return fb;
}


// ===== CONTROLS =====
function setRunning(r){ if($("btnStart")) $("btnStart").disabled=r; if($("btnStop")) $("btnStop").disabled=!r; }

async function startTest(){
  if (!state.selected){ await autoSelectServer(); if (!state.selected){ alert("Tidak ada server tersedia."); return; } }
  setRunning(true); state.stopFlag=false;
  if($("downBar")) $("downBar").style.width="0%";
  if($("upBar")) $("upBar").style.width="0%";
  if($("downMbps")) $("downMbps").textContent="-";
  if($("upMbps")) $("upMbps").textContent="-";
  if($("latency")) $("latency").textContent="-";
  if($("jitter")) $("jitter").textContent="-";
  updateGauge(0);

  const base = state.selected.URL || state.selected.url;
  const seconds = Math.max(3, Math.min(30, readIntOrDefault("duration", DEFAULT_SECONDS)));
  const streams = Math.max(1, Math.min(32, readIntOrDefault("streams", DEFAULT_STREAMS)));

  // latency
  try{
    const lat = await measureLatency(base, 10);
    if($("latency")) $("latency").textContent = `${lat.avg.toFixed(1)} ms`;
    if($("jitter"))  $("jitter").textContent  = `${lat.jitter.toFixed(1)} ms`;
  }catch{}

  // download
  const t0d = performance.now();
  await runDownload(base, seconds, streams, (bytes)=>{
    const elapsed=(performance.now()-t0d)/1000;
    const m=mbps(bytes, Math.max(elapsed, .001));
    if($("downMbps")) $("downMbps").textContent=`${fmt(m,2)} Mbps`;
    if($("downBar"))  $("downBar").style.width=Math.min(100,(elapsed/seconds)*100)+"%";
    updateGauge(m);
  });

  // upload
  const t0u = performance.now();
  const upRes = await runUpload(base, seconds, streams, (bytes)=>{
    const elapsed = (performance.now() - t0u)/1000;
    const cur = mbps(bytes, Math.max(elapsed, .001));   // live (sementara)
    if ($("upMbps")) $("upMbps").textContent = `${fmt(cur,2)} Mbps`;
    if ($("upBar"))  $("upBar").style.width = Math.min(100, (elapsed/seconds)*100) + "%";
  updateGauge(cur);
});

// --- angka final yang akurat (pakai bytes/durasi dari server bila ada) ---
const upFinal = mbps(upRes.bytes, upRes.seconds);
if ($("upMbps")) $("upMbps").textContent = `${fmt(upFinal,2)} Mbps`;


  
  setRunning(false); updateGauge(0); log("All tests done");
}
function stopTest(){ state.stopFlag=true; setRunning(false); log("Stopped"); }

// ===== INIT =====
window.addEventListener("DOMContentLoaded", ()=>{
  // Wire tombol kalau ada di HTML
  if($("btnLoad")) $("btnLoad").onclick = ()=>{}; // tidak dipakai, biar aman
  if($("serverSelect")) $("serverSelect").onchange = ()=>{};
  if($("btnProbe")) $("btnProbe").onclick = ()=>{};

  if($("btnStart")) $("btnStart").onclick = startTest;
  if($("btnStop"))  $("btnStop").onclick  = stopTest;

  setupGauge();            // gambar gauge jika ada
  ensureBadges();          // buat badge server & IP/ISP kalau belum ada
  getClientNetworkInfo();  // isi IP & ISP
  autoSelectServer();      // pilih server otomatis + isi badge server
});
