const $ = (id) => document.getElementById(id);

const state = {
  servers: [],
  selected: null,
  stopFlag: false,
  downBytes: 0,
  upBytes: 0,
};

function log(msg){ $("log").textContent = msg; }

function mbps(bytes, seconds){ return (bytes * 8) / (seconds * 1e6); }

async function fetchServers(){
  const dir = $("dirUrl").value.trim().replace(/\/+$/,"");
  const r = await fetch(dir + "/api/v1/servers", { cache: "no-store" });
  const servers = await r.json();
  state.servers = servers;
  const sel = $("serverSelect");
  sel.innerHTML = "";
  servers.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `${s.city} (${s.region}) – ${s.url}`;
    sel.appendChild(opt);
  });
  if (servers.length) {
    sel.value = "0";
    state.selected = servers[0];
    $("serverInfo").textContent = `Selected: ${servers[0].city} • ${servers[0].url}`;
  }
}

function setSelectedFromSelect(){
  const idx = parseInt($("serverSelect").value || "0", 10);
  state.selected = state.servers[idx];
  $("serverInfo").textContent = `Selected: ${state.selected.city} • ${state.selected.url}`;
}

async function measureLatency(baseUrl, count=10){
  const samples = [];
  for(let i=0;i<count;i++){
    const t0 = performance.now();
    await fetch(baseUrl + "/api/v1/latency", { cache: "no-store" });
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
    state.servers.map(s => measureLatency(s.URL || s.url).then(r => ({ s, r })).catch(()=>({s, r:null})))
  );
  tests.sort((a,b)=> (a.r? a.r.avg: 1e9) - (b.r? b.r.avg: 1e9));
  const best = tests[0];
  if (best && best.r){
    state.selected = best.s;
    $("serverInfo").textContent = `Best: ${best.s.city} (${best.s.region}) • avg ${best.r.avg.toFixed(1)} ms`;
    // Update select to match best
    const idx = state.servers.findIndex(x=>x.id===best.s.id);
    if (idx>=0) $("serverSelect").value = String(idx);
  }
  $("latency").textContent = `${best.r.avg.toFixed(1)} ms`;
  $("jitter").textContent = `${best.r.jitter.toFixed(1)} ms`;
  log("Ready.");
}

async function runDownload(baseUrl, seconds=10, streams=8, onProgress=()=>{}){
  const tEnd = Date.now() + seconds*1000;
  let total = 0;
  state.downBytes = 0;

  const worker = async () => {
    while(Date.now() < tEnd && !state.stopFlag){
      const resp = await fetch(baseUrl + "/api/v1/download?time=2", { cache: "no-store" });
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

  const tick = setInterval(()=>{
    onProgress(total);
  }, 200);

  await Promise.all(Array.from({length: streams}, worker));
  clearInterval(tick);
  onProgress(total);
  return total;
}

function supportsStreamingUpload() {
  try {
    const rs = new ReadableStream({ start(c){ c.close(); } });
    // bikin Request dengan body stream + duplex: 'half' (wajib agar browser kirim stream)
    // ini hanya feature-detect, tidak kirim jaringan
    new Request("about:blank", { method: "POST", body: rs, duplex: "half" });
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
          duplex: "half"            // <<<<<< kunci utamanya
        });
        const j = await r.json().catch(()=>({receivedBytes:0}));
        return j.receivedBytes || 0;
      }catch{ return 0; }
    };

    const results = await Promise.all(Array.from({length: streams}, worker));
    onProgress(state.upBytes);
    const sum = results.reduce((a,b)=>a+b,0);
    if (sum > 0) return sum; // sukses streaming → selesai
    // kalau semua gagal, lanjut fallback
  }

  // Fallback (tanpa streaming)
  const fb = await runUploadFallback(baseUrl, seconds, Math.max(1, Math.min(8, streams)), n=>{
    state.upBytes = n; onProgress(n);
  });
  return fb;
}

/* async function runUpload(baseUrl, seconds=10, streams=8, onProgress=()=>{}){
  state.upBytes = 0;
  const durationMs = seconds*1000;

  const worker = async () => {
    try{
      const r = await fetch(baseUrl + `/api/v1/upload?time=${seconds}`, {
        method: "POST",
        body: makeUploadStream(durationMs),
        headers: { "Content-Type": "application/octet-stream" },
        duplex: "half"
      });
      const j = await r.json();
      state.upBytes += j.receivedBytes || 0;
      return j.receivedBytes || 0;
    }catch(e){ return 0; }
  }; 

  const tick = setInterval(()=>{ onProgress(state.upBytes); }, 200);
  const results = await Promise.all(Array.from({length: streams}, worker));
  clearInterval(tick);
  onProgress(state.upBytes);
  return results.reduce((a,b)=>a+b,0);
} */

function setRunning(running){
  $("btnStart").disabled = running;
  $("btnStop").disabled = !running;
}

async function startTest(){
  if (!state.selected){ alert("Load & pilih server dulu."); return; }
  setRunning(true);
  state.stopFlag = false;
  $("downBar").style.width = "0%";
  $("upBar").style.width = "0%";
  $("downMbps").textContent = "-";
  $("upMbps").textContent = "-";
  $("latency").textContent = "-";
  $("jitter").textContent = "-";
  log("Measuring latency...");

  const base = state.selected.URL || state.selected.url;
  const seconds = Math.max(3, Math.min(30, parseInt($("duration").value||"10",10)));
  const streams = Math.max(1, Math.min(32, parseInt($("streams").value||"8",10)));

  const lat = await measureLatency(base, 10);
  $("latency").textContent = `${lat.avg.toFixed(1)} ms`;
  $("jitter").textContent = `${lat.jitter.toFixed(1)} ms`;

  log("Running download...");
  const t0d = performance.now();
  await runDownload(base, seconds, streams, (bytes)=>{
    const elapsed = (performance.now() - t0d)/1000;
    const m = mbps(bytes, Math.max(elapsed, 0.001));
    $("downMbps").textContent = `${m.toFixed(2)} Mbps`;
    $("downBar").style.width = Math.min(100, (elapsed/seconds)*100) + "%";
  });

  log("Running upload...");
  const t0u = performance.now();
  await runUpload(base, seconds, streams, (bytes)=>{
    const elapsed = (performance.now() - t0u)/1000;
    const m = mbps(bytes, Math.max(elapsed, 0.001));
    $("upMbps").textContent = `${m.toFixed(2)} Mbps`;
    $("upBar").style.width = Math.min(100, (elapsed/seconds)*100) + "%";
  });

  setRunning(false);
  log("Done.");
}

function stopTest(){
  state.stopFlag = true;
  setRunning(false);
  log("Stopped.");
}

window.addEventListener("DOMContentLoaded", ()=>{
  $("btnLoad").onclick = fetchServers;
  $("serverSelect").onchange = setSelectedFromSelect;
  $("btnProbe").onclick = probeBest;
  $("btnStart").onclick = startTest;
  $("btnStop").onclick = stopTest;
  fetchServers().catch(()=>{});
});
