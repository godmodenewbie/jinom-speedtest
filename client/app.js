// ===== CONFIG =====
//const DIRECTORY_URL = `${location.protocol}//${location.hostname}:9088`;
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
function readIntOrDefault(id, def){
  const el = $(id);
  const v = el ? parseInt(el.value || "", 10) : NaN;
  return Number.isFinite(v) ? v : def;
}

// ====== SPEEDOMETER (gauge) ======
const GAUGE = { start:-130, end:130 };
function polar(r, ang){ const a=(ang-90)*Math.PI/180; return {x:r*Math.cos(a), y:r*Math.sin(a)}; }
function arcPath(r, a0, a1){ const p0=polar(r,a0), p1=polar(r,a1); const large=(a1-a0)>180?1:0; return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`; }

function setupGauge(){
  const bg = $("arcBg"), val = $("arcVal");
  if (!bg || !val) return; // HTML belum ada gauge -> skip
  bg.setAttribute("d", arcPath(90, GAUGE.start, GAUGE.end));
  val.setAttribute("d", arcPath(90, GAUGE.start, GAUGE.start));
  drawTicks(); setGaugeMax(1000);
}
function drawTicks(){
  const g = $("ticks"); if (!g) return;
  g.innerHTML = "";
  const max = state.gaugeMax;
  const steps=[0,.1,.2,.3,.4,.5,.6,.7,.8,.9,1];
  steps.forEach(fr=>{
    const ang = GAUGE.start + (GAUGE.end-GAUGE.start)*fr;
    const p0 = polar(84, ang), p1 = polar(92, ang), t = polar(72, ang);
    const ln = document.createElementNS('http://www.w3.org/2000/svg','line');
    ln.setAttribute('x1', p0.x); ln.setAttribute('y1', p0.y); ln.setAttribute('x2', p1.x); ln.setAttribute('y2', p1.y);
    ln.setAttribute('stroke', fr%0.5===0? '#cfd6ff':'#3a4164'); ln.setAttribute('stroke-width', fr%0.5===0? 2:1);
    g.appendChild(ln);
    if(fr%0.5===0){
      const tx = document.createElementNS('http://www.w3.org/2000/svg','text');
      tx.setAttribute('x', t.x); tx.setAttribute('y', t.y+4);
      tx.setAttribute('text-anchor','middle'); tx.setAttribute('fill','#9aa3c7'); tx.setAttribute('font-size','8');
      tx.textContent = Math.round(max*fr);
      g.appendChild(tx);
    }
  });
  const sl = $("scaleLabel"); if (sl) sl.textContent = `Scale: 0–${max} Mbps (Auto)`;
}
function setGaugeMax(max){ state.gaugeMax = max; drawTicks(); }
function chooseScaleFor(v){
  const levels=[50,100,250,500,1000,2000,5000,10000,20000];
  for (const lv of levels){ if (v <= lv*0.85) return lv; }
  return levels.at(-1);
}
function updateGauge(currMbps){
  const arcVal = $("arcVal"), needle = $("needle"), speedNum = $("speedNum");
  if (!arcVal || !needle || !speedNum) return;
  const need = chooseScaleFor(currMbps||0);
  if (need !== state.gaugeMax) setGaugeMax(need);
  const frac = Math.max(0, Math.min(1, (currMbps||0) / state.gaugeMax));
  const ang = GAUGE.start + (GAUGE.end-GAUGE.start)*frac;
  needle.setAttribute("transform", `rotate(${ang})`);
  arcVal.setAttribute("d", arcPath(90, GAUGE.start, ang));
  speedNum.textContent = (currMbps||0).toFixed(2);
}

// ===== RANDOM BYTES: 64KB sekali, susun jadi 4MiB =====
const BASE64K = new Uint8Array(65536);
crypto.getRandomValues(BASE64K); // <= batas WebCrypto OK

function makeChunk(bytes){
  const out = new Uint8Array(bytes);
  for (let off=0; off<out.length; off += BASE64K.length) out.set(BASE64K, off);
  return out;
}
const UP_CHUNK = makeChunk(4 << 20); // 4 MiB

// ===== DIRECTORY & SERVER PICK =====
async function fetchServers(){
  const dirInput = $("dirUrl");
  const dir = (dirInput ? dirInput.value : DIRECTORY_URL).trim().replace(/\/+$/,"");
  const r = await fetch(dir + "/api/v1/servers", { cache:"no-store" });
  const servers = await r.json();
  state.servers = servers || [];

  const sel = $("serverSelect");
  if (sel){
    sel.innerHTML = "";
    state.servers.forEach((s,i)=>{
      const opt = document.createElement("option");
      opt.value = i; opt.textContent = `${s.city} (${s.region}) – ${s.url}`;
      sel.appendChild(opt);
    });
  }
  if (state.servers.length){
    if (sel) sel.value = "0";
    state.selected = state.servers[0];
    const si = $("serverInfo");
    if (si) si.textContent = `Selected: ${state.selected.city||''} • ${state.selected.url}`;
  }
}

function setSelectedFromSelect(){
  const sel = $("serverSelect"); if (!sel) return;
  const idx = parseInt(sel.value || "0", 10);
  state.selected = state.servers[idx];
  const si = $("serverInfo");
  if (si) si.textContent = `Selected: ${state.selected.city||''} • ${state.selected.url}`;
}

async function measureLatency(baseUrl, count=10){
  const samples = [];
  for(let i=0;i<count;i++){
    const t0 = performance.now();
    await fetch(baseUrl + "/api/v1/latency?t=" + Math.random(), { cache:"no-store" });
    samples.push(performance.now() - t0);
  }
  const avg = samples.reduce((a,b)=>a+b,0)/samples.length;
  const mean = avg;
  const jitter = Math.sqrt(samples.reduce((s,x)=>s+Math.pow(x-mean,2),0)/samples.length);
  return { avg, jitter, samples };
}

async function probeBest(){
  if (!state.servers.length) return;
  log("Probing latency...");
  const tests = await Promise.all(
    state.servers.map(s => measureLatency(s.URL || s.url, 6)
      .then(r => ({ s, r })).catch(()=>({s, r:null})))
  );
  tests.sort((a,b)=> (a.r? a.r.avg:1e9) - (b.r? b.r.avg:1e9));
  const best = tests[0];
  if (best && best.r){
    state.selected = best.s;
    const si = $("serverInfo");
    if (si) si.textContent = `Best: ${best.s.city} (${best.s.region}) • avg ${best.r.avg.toFixed(1)} ms`;
    const idx = state.servers.findIndex(x=>x.id===best.s.id);
    if (idx>=0 && $("serverSelect")) $("serverSelect").value = String(idx);
    if ($("latency")) $("latency").textContent = `${best.r.avg.toFixed(1)} ms`;
    if ($("jitter"))  $("jitter").textContent  = `${best.r.jitter.toFixed(1)} ms`;
  }
  log("Ready.");
}

// ===== DOWNLOAD (multi-stream, time-sliced) =====
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
        if (Date.now() >= tEnd || state.stopFlag){
          try{ reader.cancel(); }catch{}
          break;
        }
      }
    }
  };

  const tick = setInterval(()=> onProgress(total), 150);
  await Promise.all(Array.from({length: streams}, worker));
  clearInterval(tick);
  onProgress(total);
  return total;
}

// ===== UPLOAD (streaming + fallback) =====
function supportsStreamingUpload(){
  try{
    const rs = new ReadableStream({ start(c){ c.close(); } });
    new Request("about:blank", { method:"POST", body: rs, duplex:"half" }); // feature-detect
    return true;
  }catch{ return false; }
}
function makeUploadStream(durationMs, onEnqueue){
  const end = Date.now() + durationMs;
  return new ReadableStream({
    pull(controller){
      if (Date.now() >= end || state.stopFlag){ controller.close(); return; }
      controller.enqueue(UP_CHUNK); // 4 MiB per pull
      if (onEnqueue) onEnqueue(UP_CHUNK.length);
    }
  });
}
async function runUploadStreaming(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  state.upBytes = 0; const durationMs = seconds*1000;

  const worker = async () => {
    try{
      let localCount = 0;
      const stream = makeUploadStream(durationMs, n => { localCount += n; state.upBytes += n; onProgress(state.upBytes); });
      const r = await fetch(baseUrl + `/api/v1/upload?time=${seconds}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: stream,
        duplex: "half"
      });
      const j = await r.json().catch(()=>({receivedBytes:0}));
      if (j && typeof j.receivedBytes === "number"){
        const diff = j.receivedBytes - localCount;
        if (diff > 0){ state.upBytes += diff; onProgress(state.upBytes); }
        return j.receivedBytes;
      }
      return localCount;
    }catch(e){ log("stream worker failed:", e); return 0; }
  };

  const results = await Promise.all(Array.from({length: streams}, worker));
  return results.reduce((a,b)=>a+b,0);
}
async function runUploadFallback(baseUrl, seconds=DEFAULT_SECONDS, streams=Math.min(DEFAULT_STREAMS,8), onProgress=()=>{}){
  const tEnd = Date.now() + seconds*1000; let total = 0;
  const worker = async () => {
    let sent = 0;
    while(Date.now() < tEnd && !state.stopFlag){
      await fetch(baseUrl + "/api/v1/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: UP_CHUNK
      }).catch(()=>{});
      sent += UP_CHUNK.length; total += UP_CHUNK.length; onProgress(total);
    }
    return sent;
  };
  const tick = setInterval(()=> onProgress(total), 150);
  const results = await Promise.all(Array.from({length: streams}, worker));
  clearInterval(tick); onProgress(total);
  return results.reduce((a,b)=>a+b,0);
}
async function runUpload(baseUrl, seconds=DEFAULT_SECONDS, streams=DEFAULT_STREAMS, onProgress=()=>{}){
  if (supportsStreamingUpload()){
    const sum = await runUploadStreaming(baseUrl, seconds, streams, onProgress);
    if (sum > 0) return sum;
    log("Streaming returned 0 → fallback");
  }
  return await runUploadFallback(baseUrl, seconds, Math.max(1, Math.min(8, streams)), onProgress);
}

// ===== CONTROLS =====
function setRunning(r){
  if ($("btnStart")) $("btnStart").disabled = r;
  if ($("btnStop"))  $("btnStop").disabled  = !r;
}

async function startTest(){
  if (!state.selected){
    // auto-pick by directory & ping
    try{
      const r = await fetch(DIRECTORY_URL + "/api/v1/servers", { cache:"no-store" });
      const list = await r.json();
      state.servers = list||[];
      if (!state.servers.length) throw new Error("No servers");
      const tests = await Promise.all(state.servers.map(s =>
        measureLatency(s.URL||s.url, 6).then(r=>({s,r})).catch(()=>({s,r:null}))
      ));
      tests.sort((a,b)=> (a.r? a.r.avg:1e9) - (b.r? b.r.avg:1e9));
      const best = tests[0]; if (best && best.r) state.selected = best.s;
      if ($("latency")) $("latency").textContent = `${best.r.avg.toFixed(1)} ms`;
      if ($("jitter"))  $("jitter").textContent  = `${best.r.jitter.toFixed(1)} ms`;
      if ($("serverInfo")) $("serverInfo").textContent = `Selected: ${best.s.city||''} • ${best.s.url}`;
    }catch(e){ alert("Tidak ada server tersedia."); return; }
  }

  setRunning(true);
  state.stopFlag = false;
  if ($("downBar")) $("downBar").style.width = "0%";
  if ($("upBar"))   $("upBar").style.width   = "0%";
  if ($("downMbps")) $("downMbps").textContent = "-";
  if ($("upMbps"))   $("upMbps").textContent   = "-";
  if ($("latency"))  $("latency").textContent  = "-";
  if ($("jitter"))   $("jitter").textContent   = "-";
  updateGauge(0);

  const base = state.selected.URL || state.selected.url;
  const seconds = Math.max(3, Math.min(30, readIntOrDefault("duration", DEFAULT_SECONDS)));
  const streams = Math.max(1, Math.min(32, readIntOrDefault("streams", DEFAULT_STREAMS)));

  // latency (10x, lebih stabil)
  const lat = await measureLatency(base, 10);
  if ($("latency")) $("latency").textContent = `${lat.avg.toFixed(1)} ms`;
  if ($("jitter"))  $("jitter").textContent  = `${lat.jitter.toFixed(1)} ms`;

  // download
  const t0d = performance.now();
  await runDownload(base, seconds, streams, (bytes)=>{
    const elapsed = (performance.now() - t0d)/1000;
    const m = mbps(bytes, Math.max(elapsed, 0.001));
    if ($("downMbps")) $("downMbps").textContent = `${fmt(m,2)} Mbps`;
    if ($("downBar"))  $("downBar").style.width = Math.min(100, (elapsed/seconds)*100) + "%";
    updateGauge(m);
  });

  // upload
  const t0u = performance.now();
  await runUpload(base, seconds, streams, (bytes)=>{
    const elapsed = (performance.now() - t0u)/1000;
    const m = mbps(bytes, Math.max(elapsed, 0.001));
    if ($("upMbps")) $("upMbps").textContent = `${fmt(m,2)} Mbps`;
    if ($("upBar"))  $("upBar").style.width = Math.min(100, (elapsed/seconds)*100) + "%";
    updateGauge(m);
  });

  setRunning(false);
  updateGauge(0);
  log("All tests done");
}

function stopTest(){ state.stopFlag = true; setRunning(false); log("Stopped"); }

// ===== INIT =====
window.addEventListener("DOMContentLoaded", ()=>{
  // kalau HTML lama masih ada UI ini, tetap jalan:
  if ($("btnLoad"))    $("btnLoad").onclick = fetchServers;
  if ($("serverSelect")) $("serverSelect").onchange = setSelectedFromSelect;
  if ($("btnProbe"))   $("btnProbe").onclick = probeBest;

  if ($("btnStart")) $("btnStart").onclick = startTest;
  if ($("btnStop"))  $("btnStop").onclick  = stopTest;

  setupGauge(); // gambar gauge jika ada di HTML
  // auto-load server list (tidak wajib)
  try{ fetchServers(); }catch{}
});
