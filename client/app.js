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

state.lastResult = null;

// util: angka ke 2 desimal
function fmt2(n){ return Number.isFinite(n) ? n.toFixed(2) : "-"; }

// buat payload hasil yang akan dishare
function buildResultPayload(){
  const nowIso = new Date().toISOString();
  const sel = state.selected || {};
  // Baca angka yang tampil di UI (supaya konsisten)
  const latencyMs = parseFloat(document.getElementById("latency").textContent) || 0;
  const jitterMs  = parseFloat(document.getElementById("jitter").textContent) || 0;
  const downMbps  = parseFloat(document.getElementById("downMbps").textContent) || 0;
  const upMbps    = parseFloat(document.getElementById("upMbps").textContent) || 0;
  const ipText    = (document.getElementById("clientIpText")?.textContent || "IP: -").replace(/^IP:\s*/i,"");
  const ispText   = (document.getElementById("clientIspText")?.textContent || "ISP: -").replace(/^—?\s*ISP:\s*/i,"");

  return {
    ts: nowIso,
    latencyMs, jitterMs, downMbps, upMbps,
    client: { ip: ipText, isp: ispText },
    server: { id: sel.id || "-", city: sel.city || "-", region: sel.region || "-", url: (sel.URL || sel.url || "-") }
  };
}

// encode → permalink dengan hash (tidak butuh backend)
function makeShareLink(result){
  const json = JSON.stringify(result);
  const b64  = btoa(unescape(encodeURIComponent(json)));
  const base = location.origin + location.pathname;
  return `${base}#r=${b64}`;
}

// coba parse shared result saat halaman dibuka via link
function tryLoadSharedFromHash(){
  const m = location.hash.match(/[#&]r=([^&]+)/);
  if(!m) return null;
  try{
    const json = decodeURIComponent(escape(atob(m[1])));
    return JSON.parse(json);
  }catch{ return null; }
}

async function renderResultCardPNG(res){
  const W = 1200, H = 630;           // ukuran sosial-card
  const pad = 40;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // background
  const grad = ctx.createLinearGradient(0,0,W,H);
  grad.addColorStop(0,"#151A33");
  grad.addColorStop(1,"#0F1320");
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,W,H);

  // header
  ctx.fillStyle = "#cfd6ff";
  ctx.font = "bold 36px system-ui,Segoe UI,Inter,Roboto";
  ctx.fillText("Jinom Speedtest – Result", pad, pad+36);

  // garis
  ctx.strokeStyle = "#222842";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pad, pad+56); ctx.lineTo(W-pad, pad+56); ctx.stroke();

  // nilai besar
  const big = [
    ["Download", `${fmt2(res.downMbps)} Mbps`],
    ["Upload",   `${fmt2(res.upMbps)} Mbps`],
    ["Ping",     `${fmt2(res.latencyMs)} ms`],
    ["Jitter",   `${fmt2(res.jitterMs)} ms`],
  ];
  const colW = (W - pad*2) / 4;
  big.forEach((row, i)=>{
    const x = pad + i*colW;
    ctx.fillStyle = "#9aa3c7";
    ctx.font = "bold 18px system-ui,Segoe UI,Inter,Roboto";
    ctx.fillText(row[0], x, pad+120);
    ctx.fillStyle = "#e8ebff";
    ctx.font = "900 44px system-ui,Segoe UI,Inter,Roboto";
    ctx.fillText(row[1], x, pad+120+52);
  });

  // footer info
  ctx.fillStyle = "#9aa3c7";
  ctx.font = "16px system-ui,Segoe UI,Inter,Roboto";
  const s = res.server || {};
  const c = res.client || {};
  const line1 = `Server: ${s.city||"-"} (${s.region||"-"}) • ${s.url||"-"}`;
  const line2 = `Client: ${c.isp||"-"} • ${c.ip||"-"}`;
  const line3 = `Time: ${new Date(res.ts).toLocaleString()}`;
  ctx.fillText(line1, pad, H - pad - 60);
  ctx.fillText(line2, pad, H - pad - 34);
  ctx.fillText(line3, pad, H - pad - 8);

  // logo titik
  ctx.beginPath();
  ctx.arc(W-pad-10, pad+28, 6, 0, Math.PI*2);
  ctx.fillStyle = "#5b8cff";
  ctx.fill();

  return canvas;
}

async function downloadResultImage(){
  if(!state.lastResult) return;
  const canvas = await renderResultCardPNG(state.lastResult);
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date(state.lastResult.ts).toISOString().replace(/[:.]/g,"-");
  a.download = `speedtest-${ts}.png`;
  a.click();
}

async function doShare(){
  if(!state.lastResult) return;
  const link = makeShareLink(state.lastResult);
  const text = [
    `Jinom Speedtest Result`,
    `Download: ${fmt2(state.lastResult.downMbps)} Mbps`,
    `Upload  : ${fmt2(state.lastResult.upMbps)} Mbps`,
    `Ping    : ${fmt2(state.lastResult.latencyMs)} ms  •  Jitter: ${fmt2(state.lastResult.jitterMs)} ms`,
    `Server  : ${state.lastResult.server.city} (${state.lastResult.server.region})`,
    `Link    : ${link}`
  ].join("\n");

  try{
    if (navigator.canShare && navigator.canShare({ url: link })) {
      await navigator.share({ title: "Speedtest Result", text, url: link });
      return;
    }
  }catch(e){ /* user cancel or not supported */ }

  // fallback: tampilkan link & enable copy
  const input = document.getElementById("shareLink");
  const btnCopy = document.getElementById("btnCopyShare");
  if (input){
    input.value = link;
    input.disabled = false;
  }
  if (btnCopy){
    btnCopy.disabled = false;
  }
}

async function copyShareLink(){
  const input = document.getElementById("shareLink");
  if (!input || !input.value) return;
  try{
    await navigator.clipboard.writeText(input.value);
    input.classList.add("copied");
    setTimeout(()=>input.classList.remove("copied"), 800);
  }catch{
    input.select(); document.execCommand("copy");
  }
}

// Fungsi untuk menampilkan hasil (baik dari tes baru atau dari link)
function displayResult(res) {
  if (!res) return;

  // Isi KPI
  if ($("latency")) $("latency").textContent = fmt2(res.latencyMs);
  if ($("jitter")) $("jitter").textContent = fmt2(res.jitterMs);
  if ($("downMbps")) $("downMbps").textContent = fmt2(res.downMbps);
  if ($("upMbps")) $("upMbps").textContent = fmt2(res.upMbps);

  // Isi info client & server
  if ($("clientIpText")) $("clientIpText").textContent = `IP: ${res.client?.ip || "-"}`;
  if ($("clientIspText")) $("clientIspText").textContent = `— ISP: ${res.client?.isp || "-"}`;
  if ($("serverText")) {
    const s = res.server || {};
    $("serverText").textContent = `Server: ${s.city || "Unknown"}${s.region ? " ("+s.region+")" : ""} • ${s.url || "-"}`;
  }

  updateGauge(0); // Reset gauge
}

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
function supportsStreamingUpload(){ try{ const rs=new ReadableStream({start(c){c.close()}}); new Request("about:blank",{method:"POST",body:rs,duplex:"half"}); return true; }catch{ return false } }
function makeUploadStream(durationMs, onEnqueue){ const end=Date.now()+durationMs; return new ReadableStream({ pull(c){ if(Date.now()>=end||state.stopFlag){ c.close(); return } c.enqueue(UP_CHUNK); if(onEnqueue) onEnqueue(UP_CHUNK.length); } }); }
async function runUploadStreaming(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  state.upBytes=0; const durationMs=seconds*1000;
  const worker=async()=>{ try{ let local=0; const stream=makeUploadStream(durationMs, n=>{ local+=n; state.upBytes+=n; onProgress(state.upBytes); }); const r=await fetch(baseUrl+`/api/v1/upload?time=${seconds}`,{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:stream}); const j=await r.json().catch(()=>({receivedBytes:0})); if(typeof j.receivedBytes==="number"){ const diff=j.receivedBytes-local; if(diff>0){ state.upBytes+=diff; onProgress(state.upBytes);} return j.receivedBytes; } return local; }catch(e){ log("stream worker failed:",e); return 0; } };
  const results=await Promise.all(Array.from({length:streams}, worker)); return results.reduce((a,b)=>a+b,0);
}
async function runUploadFallback(baseUrl, seconds=DEFAULT_SECONDS, streams=Math.min(DEFAULT_STREAMS,8), onProgress=()=>{}){
  const tEnd=Date.now()+seconds*1000; let total=0;
  const worker=async()=>{ let sent=0; while(Date.now()<tEnd && !state.stopFlag){ await fetch(baseUrl+"/api/v1/upload",{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:UP_CHUNK}).catch(()=>{}); sent+=UP_CHUNK.length; total+=UP_CHUNK.length; onProgress(total); } return sent; };
  const tick=setInterval(()=>onProgress(total),120); const results=await Promise.all(Array.from({length:streams}, worker)); clearInterval(tick); onProgress(total); return results.reduce((a,b)=>a+b,0);
}
async function runUpload(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  if (supportsStreamingUpload()){ const sum=await runUploadStreaming(baseUrl,seconds,streams,onProgress); if(sum>0) return sum; log("Streaming returned 0 → fallback"); }
  return await runUploadFallback(baseUrl, seconds, Math.max(1, Math.min(8, streams)), onProgress);
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
  await runUpload(base, seconds, streams, (bytes)=>{
    const elapsed=(performance.now()-t0u)/1000;
    const m=mbps(bytes, Math.max(elapsed, .001));
    if($("upMbps")) $("upMbps").textContent=`${fmt(m,2)} Mbps`;
    if($("upBar"))  $("upBar").style.width=Math.min(100,(elapsed/seconds)*100)+"%";
    updateGauge(m);
  });

  setRunning(false); updateGauge(0); log("All tests done");

  // simpan hasil terakhir → enable tombol share
  const result = buildResultPayload();
  state.lastResult = result;
  displayResult(result); // Tampilkan hasil yang baru saja didapat
  // siapkan link di input (opsional, biar langsung muncul)
  document.getElementById("shareLink").value = makeShareLink(state.lastResult);
  document.getElementById("btnCopyShare").disabled = false;
}
function stopTest(){ state.stopFlag=true; setRunning(false); log("Stopped"); }

document.getElementById("btnShare").onclick = doShare;
document.getElementById("btnDownloadImg").onclick = downloadResultImage;
document.getElementById("btnCopyShare").onclick = copyShareLink;

// Jika halaman dibuka via link share, bisa kamu pakai untuk pre-fill / banner
const shared = tryLoadSharedFromHash();
if (shared) {
  console.log("Shared result loaded:", shared);
  state.lastResult = shared; // Simpan untuk fitur download/share
  // Tampilkan hasil dari link di UI saat halaman siap
  window.addEventListener("DOMContentLoaded", () => displayResult(shared));
}


// ===== INIT =====
window.addEventListener("DOMContentLoaded", ()=>{
  // Wire tombol kalau ada di HTML
  if($("btnLoad")) $("btnLoad").onclick = ()=>{}; // tidak dipakai, biar aman
  if($("serverSelect")) $("serverSelect").onchange = ()=>{};
  if($("btnProbe")) $("btnProbe").onclick = ()=>{};

  if($("btnStart")) $("btnStart").onclick = startTest;
  if($("btnStop"))  $("btnStop").onclick  = stopTest;

  setupGauge();            // gambar gauge jika ada
  if (!shared) {
    // Hanya jalankan auto-discovery jika tidak memuat dari link
    ensureBadges();          // buat badge server & IP/ISP kalau belum ada
    getClientNetworkInfo();  // isi IP & ISP
    autoSelectServer();      // pilih server otomatis + isi badge server
  } else {
    // Jika memuat dari link, aktifkan tombol share/download
    document.getElementById("btnShare").disabled = false;
    document.getElementById("btnDownloadImg").disabled = false;
  }
});
