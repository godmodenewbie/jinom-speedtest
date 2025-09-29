// ====== CONFIG ======
const DIRECTORY_URL = `${location.protocol}//${location.hostname}:9088`; // ganti kalau perlu
const DEFAULT_SECONDS = 10;
const DEFAULT_STREAMS = 8;

// ====== DOM & STATE ======
const $ = (id) => document.getElementById(id);
const state = { servers: [], selected: null, stopFlag: false, upBytes: 0 };

// ====== UTIL ======
function mbps(bytes, seconds){ return (bytes * 8) / (seconds * 1e6); }
function fmt(n, d=2){ return Number(n).toFixed(d); }
function log(...a){ console.log("[speedtest]", ...a); }

// ====== RANDOM BYTES (hindari limit 64KB getRandomValues) ======
function fillRandom(u8){
  const MAX = 65536; // 64 KiB per call
  for (let off = 0; off < u8.length; off += MAX){
    crypto.getRandomValues(u8.subarray(off, Math.min(off+MAX, u8.length)));
  }
}
// buat pola 64KB sekali, lalu rangkai jadi chunk besar 4 MiB
const BASE64K = new Uint8Array(65536); fillRandom(BASE64K);
function makeChunk(bytes){
  const out = new Uint8Array(bytes);
  for (let off = 0; off < out.length; off += BASE64K.length) out.set(BASE64K, off);
  return out;
}
const UP_CHUNK = makeChunk(4 << 20); // 4 MiB

// ====== DIRECTORY & AUTO PICK ======
async function measureLatency(baseUrl, count=6){
  const samples = [];
  for(let i=0;i<count;i++){
    const t0 = performance.now();
    await fetch(baseUrl + "/api/v1/latency?t=" + Math.random(), { cache: "no-store" });
    samples.push(performance.now() - t0);
  }
  const avg = samples.reduce((a,b)=>a+b,0)/samples.length;
  const mean = avg;
  const jitter = Math.sqrt(samples.reduce((s,x)=>s+Math.pow(x-mean,2),0)/samples.length);
  return { avg, jitter };
}

async function autoSelectServer(){
  let list = [];
  try{
    const r = await fetch(DIRECTORY_URL + "/api/v1/servers", { cache: "no-store" });
    list = await r.json();
  }catch(e){
    log("Directory error:", e);
    return;
  }
  if(!Array.isArray(list) || !list.length){ log("No servers from directory"); return; }
  state.servers = list;

  // pilih server dengan ping terendah
  const tests = await Promise.all(list.map(s =>
    measureLatency(s.URL || s.url, 6).then(r => ({ s, r })).catch(()=>({s, r:null}))
  ));
  tests.sort((a,b)=> (a.r? a.r.avg:1e9) - (b.r? b.r.avg:1e9));
  const best = tests[0];
  if(best && best.r){
    state.selected = best.s;
    // tampilkan info ping kalau elemen ada
    if ($("latency")) $("latency").textContent = `${best.r.avg.toFixed(1)} ms`;
    if ($("jitter"))  $("jitter").textContent  = `${best.r.jitter.toFixed(1)} ms`;
    if ($("serverInfo")) $("serverInfo").textContent = `Selected: ${best.s.city||''} • ${best.s.url}`;
    log("Selected server:", best.s);
  }
}

// ====== UPLOAD (streaming + fallback) ======
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
      controller.enqueue(UP_CHUNK);
      if (onEnqueue) onEnqueue(UP_CHUNK.length);
    }
  });
}

async function runUploadStreaming(baseUrl, seconds, streams, onProgress){
  state.upBytes = 0;
  const durationMs = seconds*1000;

  const worker = async () => {
    try{
      let localCount = 0;
      const stream = makeUploadStream(durationMs, n => {
        localCount += n; state.upBytes += n; onProgress(state.upBytes);
      });
      const r = await fetch(baseUrl + `/api/v1/upload?time=${seconds}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: stream,
        duplex: "half"
      });
      const j = await r.json().catch(()=>({receivedBytes:0}));
      if (j && typeof j.receivedBytes === "number"){
        const diff = j.receivedBytes - localCount; // koreksi agar sesuai angka server
        if (diff > 0){ state.upBytes += diff; onProgress(state.upBytes); }
        return j.receivedBytes;
      }
      return localCount;
    }catch(e){
      log("stream worker failed:", e);
      return 0;
    }
  };

  const results = await Promise.all(Array.from({length: streams}, worker));
  return results.reduce((a,b)=>a+b,0);
}

// fallback: POST 4MiB berulang-ulang sampai durasi habis
async function runUploadFallback(baseUrl, seconds, streams, onProgress){
  const tEnd = Date.now() + seconds*1000;
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
  const results = await Promise.all(Array.from({length: Math.max(1, Math.min(8, streams))}, worker));
  return results.reduce((a,b)=>a+b,0);
}

async function runUpload(baseUrl, seconds, streams, onProgress){
  if (supportsStreamingUpload()){
    const sum = await runUploadStreaming(baseUrl, seconds, streams, onProgress);
    if (sum > 0) return sum;
    log("Streaming returned 0, fallback…");
  }
  return await runUploadFallback(baseUrl, seconds, streams, onProgress);
}

// ====== CONTROL ======
function readIntOrDefault(id, def){ const el=$(id); const v = el? parseInt(el.value||"",10) : NaN; return Number.isFinite(v)? v : def; }

function setRunning(r){
  if ($("btnStart")) $("btnStart").disabled = r;
  if ($("btnStop"))  $("btnStop").disabled  = !r;
}

async function startTest(){
  if (!state.selected){ await autoSelectServer(); if (!state.selected){ alert("Tidak ada server tersedia."); return; } }
  setRunning(true);
  state.stopFlag = false;

  // reset UI upload
  if ($("upBar"))   $("upBar").style.width = "0%";
  if ($("upMbps"))  $("upMbps").textContent = "-";
  if ($("downMbps")) $("downMbps").textContent = "-"; // kalau elemen ada, set '-'

  const base = state.selected.URL || state.selected.url;
  const seconds = Math.max(3, Math.min(30, readIntOrDefault("duration", DEFAULT_SECONDS)));
  const streams = Math.max(1, Math.min(32, readIntOrDefault("streams", DEFAULT_STREAMS)));

  const t0u = performance.now();
  await runUpload(base, seconds, streams, (bytes)=>{
    const elapsed = (performance.now() - t0u)/1000;
    const m = mbps(bytes, Math.max(elapsed, 0.001));
    if ($("upMbps")) $("upMbps").textContent = `${fmt(m,2)} Mbps`;
    if ($("upBar"))  $("upBar").style.width = Math.min(100, (elapsed/seconds)*100) + "%";
  });

  setRunning(false);
  log("Upload test done");
}

function stopTest(){ state.stopFlag = true; setRunning(false); log("Stopped"); }

// ====== INIT ======
window.addEventListener("DOMContentLoaded", ()=>{
  // auto-pick server saat load
  autoSelectServer().catch(()=>{});
  // wire tombol start/stop
  if ($("btnStart")) $("btnStart").onclick = startTest;
  if ($("btnStop"))  $("btnStop").onclick  = stopTest;
});
