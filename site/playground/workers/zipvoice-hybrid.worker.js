// [playground copy of experiments/webgpu/hybrid/worker.js @ experiment/webgpu-feasibility 2e89ca5 - see docs/playground_hybrid.md for the changes]
// Hybrid ZipVoice worker. Loads the PATCHED sherpa-onnx WASM (hybrid-runtime/, built from
// experiments/webgpu/sherpa-onnx-zipvoice-split.patch) and onnxruntime-web.
//   mode "wasm":   original path, SherpaOnnxOfflineTtsGenerateWithConfig (INT8 decoder inside WASM)
//   mode "webgpu": ZipvoicePrepare (frontend + encoder + noise, WASM) -> Euler loop with the dequantized
//                  FP32 decoder on WebGPU (onnxruntime-web) -> ZipvoiceVocode (Vocos, WASM) -> ScaleSilence
let tts = null, decoder = null;
const t0 = performance.now();
// Local-first dependency URL: the vendored jsDelivr mirror (playground/vendor, see docs/demo_assets.md) when it exists, else the CDN. Sync HEAD probe (allowed in workers).
const depUrl = (cdnUrl) => {
  const rel = cdnUrl.replace('https://cdn.jsdelivr.net/', ''), local = new URL('../vendor/jsdelivr/' + (rel.endsWith('+esm') ? rel + '.js' : rel), self.location.href).href;
  try { const x = new XMLHttpRequest(); x.open('HEAD', local, false); x.send(); if (x.status === 200) return local; } catch {}
  return cdnUrl;
};
const ORT_VER = '1.30.0', ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const ORT_SCRIPT = depUrl(ORT_CDN + 'ort.webgpu.min.js'), ORT_BASE = ORT_SCRIPT.slice(0, ORT_SCRIPT.lastIndexOf('/') + 1);   // local mirror or CDN, decided once
// Release asset map (playground/hosting.json, written by deploy/ghpages/build.mjs): large model files come from their revision-pinned upstream
// Hugging Face repositories. Absent in development, where everything is served from this checkout.
const HOSTING = (() => { try { const x = new XMLHttpRequest(); x.open('GET', new URL('../hosting.json', self.location.href), false); x.send(); return x.status === 200 ? JSON.parse(x.responseText) : null; } catch { return null; } })();
importScripts('./verify.js');
if (HOSTING) self.vsVerify.installFetch(HOSTING.integrity, new URL('../../', self.location.href));   // issue #14: model files are sha256-checked before use
const DECODER_URL = '../../models/webgpu/decoder.dq.fp32.onnx';   // development fallback only: the full 478 MB file
// The decoder is normally rebuilt from the INT8 decoder inside the bundle (./zipvoice-decoder.js): only the graph and the recipe are downloaded.
const DECODER_GRAPH = '../../models/webgpu/decoder.dq.graph.onnx', DECODER_RECIPE = '../../models/webgpu/decoder.dq.recipe.json';
const SHARED_DATA = HOSTING?.files['web/runtime/sherpa-onnx-wasm-main-tts.data'] || '../../web/runtime/sherpa-onnx-wasm-main-tts.data'; // byte-identical to the hybrid bundle (sha256 0e2f08ed...), so one download serves both backends
const status = (s) => self.postMessage({type: 'status', status: s});
const fail = (where, e) => self.postMessage({type: 'error', message: `${where}: ${e && (e.stack || e.message) || e}`});

async function fetchWithProgress(url, label) { // streams the decoder so the UI can show progress; aborts if no bytes arrive for 60 s
  const resp = await fetch(url); if (!resp.ok) throw new Error(`${resp.status} ${url}`);
  const total = +resp.headers.get('content-length') || 0, reader = resp.body.getReader(), chunks = []; let got = 0, last = 0;
  for (;;) {
    const {done, value} = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('download stalled: no bytes for 60 s: ' + url)), 60e3))]);
    if (done) break; chunks.push(value); got += value.length;
    if (performance.now() - last > 200) { last = performance.now(); status(`${label} ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`); }
  }
  const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

// The Emscripten loader downloads the bundle with fetch(); a dropped connection rejects a promise nobody awaits, which a worker never reports to the page.
// Report it, and treat 60 s without download progress as a failure too (the page then falls back or shows the error instead of waiting forever).
let started = false, lastProgress = performance.now();
self.addEventListener('unhandledrejection', (e) => { if (!started) { started = true; fail('Model download failed', e.reason); } });
const stall = setInterval(() => { if (started) clearInterval(stall); else if (performance.now() - lastProgress > 60e3) { started = true; fail('Model download stalled', 'no data for 60 s'); } }, 5e3);

self.Module = {
  locateFile: (path, dir = '') => path.endsWith('.data') ? SHARED_DATA : dir + '../hybrid-runtime/' + path,
  setStatus: (s) => { lastProgress = performance.now(); status(s); },
  onRuntimeInitialized: async () => {
    started = true; const tFetched = performance.now();
    try {
      // Fail fast (before the 478 MB download) when WebGPU is unavailable, so the page can fall back to the WASM baseline.
      const adapter = self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null;
      if (!adapter) throw new Error('WebGPU unavailable (no adapter)');
      tts = createOfflineTts(self.Module);
      const tSherpa = performance.now();
      const opts = {executionProviders: ['webgpu'], graphOptimizationLevel: 'all'};
      let model, rebuild = null;
      const [graph, recipe] = await Promise.all([fetch(DECODER_GRAPH).then((r) => r.ok ? r.arrayBuffer() : null, () => null),
                                                 fetch(DECODER_RECIPE).then((r) => r.ok ? r.json() : null, () => null)]);
      if (graph && recipe) {
        status('Preparing WebGPU decoder…');
        const int8 = self.FS.readFile('/' + recipe.source.file);   // from the bundle already in memory: no download
        const {weights, times} = await self.vsDecoder.build(int8, recipe);
        model = new Uint8Array(graph); opts.externalData = [{path: recipe.weights.file, data: weights}]; rebuild = times;
      } else model = await fetchWithProgress(DECODER_URL, 'Downloading WebGPU decoder');
      const tDecFetched = performance.now();
      status('Compiling WebGPU decoder…');
      decoder = await ort.InferenceSession.create(model, opts);
      const tReady = performance.now();
      self.postMessage({type: 'ready', sampleRate: tts.sampleRate, decoderSource: rebuild ? 'rebuilt from the INT8 decoder in the bundle' : 'decoder.dq.fp32.onnx', loadMs: {
        sherpa_download_instantiate: tFetched - t0, sherpa_init: tSherpa - tFetched,
        decoder_fetch: tDecFetched - tSherpa, ...(rebuild && {decoder_rebuild: rebuild}), decoder_session: tReady - tDecFetched, total: tReady - t0}});
    } catch (e) { fail('Hybrid initialization failed', e); }
  },
};
try {
  importScripts('../hybrid-runtime/sherpa-onnx-wasm-main-tts.js', '../hybrid-runtime/sherpa-onnx-tts.js', ORT_SCRIPT, './zipvoice-decoder.js');
  ort.env.wasm.wasmPaths = ORT_BASE;
} catch (e) { fail('importScripts failed', e); }

const M = () => self.Module;
const heapBytes = () => M().HEAPF32.byteLength;

function readAudio(ptr) { // SherpaOnnxGeneratedAudio {const float *samples; int32 n; int32 sample_rate}
  const base = ptr / 4, sp = M().HEAPU32[base], n = M().HEAP32[base + 1];
  return new Float32Array(M().HEAPF32.subarray(sp / 4, sp / 4 + n));
}

function generateWasm(text, cfg) {
  const t = performance.now();
  const audio = tts.generateWithConfig(text, cfg);
  return {samples: audio.samples, stages: {generate_ms: performance.now() - t}};
}

// Euler integration over t-shifted timesteps, identical to OfflineTtsZipvoiceModel::Run (sherpa-onnx).
// x is updated in place. onStep(stepIndex, ms, x) is optional.
async function decodeLoop(tc, sc, x, nFrames, dim, tShift, gs, numSteps, onStep) {
  const shape = [1, nFrames, dim], n = nFrames * dim;
  const feeds = {
    text_condition: new ort.Tensor('float32', tc, shape),
    speech_condition: new ort.Tensor('float32', sc, shape),
    guidance_scale: new ort.Tensor('float32', new Float32Array([gs]), []),
  };
  const ts = (i) => { const u = i / numSteps; return tShift * u / (1 + (tShift - 1) * u); };
  for (let s = 0; s < numSteps; s++) {
    const ts0 = performance.now();
    const t0s = ts(s), dt = ts(s + 1) - t0s;
    const out = await decoder.run({...feeds, t: new ort.Tensor('float32', new Float32Array([t0s]), []),
                                   x: new ort.Tensor('float32', x, shape)});
    const v = out.v.data;
    for (let i = 0; i < n; i++) x[i] += v[i] * dt;
    if (onStep) onStep(s, performance.now() - ts0, x);
  }
}

async function generateWebGPU(text, cfg, numSteps) {
  const m = M();
  const cfgWasm = initSherpaOnnxGenerationConfig(cfg, m);
  const len = m.lengthBytesUTF8(text) + 1, textPtr = m._malloc(len);
  m.stringToUTF8(text, textPtr, len);
  const st = {prepare_ms: 0, decoder_ms: 0, decoder_first_step_ms: [], vocode_ms: 0, silence_ms: 0, chunks: 0, frames: []};
  const pieces = [];
  try {
    for (let c = 0, numChunks = 1; c < numChunks; c++) {
      let t = performance.now();
      const p = m._SherpaOnnxOfflineTtsZipvoicePrepare(tts.handle, textPtr, cfgWasm.ptr, c);
      if (!p) throw new Error('ZipvoicePrepare failed (see console)');
      const b = p / 4, F = m.HEAPF32;
      const nFrames = m.HEAP32[b + 3], promptLen = m.HEAP32[b + 4], dim = m.HEAP32[b + 5];
      numChunks = m.HEAP32[b + 6];
      const tShift = F[b + 7], gs = F[b + 8], n = nFrames * dim;
      const copy = (ptr) => new Float32Array(F.subarray(ptr / 4, ptr / 4 + n));
      const tc = copy(m.HEAPU32[b]), sc = copy(m.HEAPU32[b + 1]), x = copy(m.HEAPU32[b + 2]);
      m._SherpaOnnxOfflineTtsZipvoiceDestroyPrepared(p);
      st.prepare_ms += performance.now() - t;
      if (nFrames === 0) continue;
      st.chunks++; st.frames.push(nFrames);

      t = performance.now();
      await decodeLoop(tc, sc, x, nFrames, dim, tShift, gs, numSteps, (sIdx, ms) => { if (sIdx === 0) st.decoder_first_step_ms.push(ms); });
      st.decoder_ms += performance.now() - t;

      t = performance.now();
      const xPtr = m._malloc(n * 4);
      m.HEAPF32.set(x, xPtr / 4);
      const a = m._SherpaOnnxOfflineTtsZipvoiceVocode(tts.handle, xPtr, nFrames, promptLen, cfgWasm.ptr);
      m._free(xPtr);
      if (!a) throw new Error('ZipvoiceVocode failed');
      pieces.push(readAudio(a));
      m._SherpaOnnxDestroyOfflineTtsGeneratedAudio(a);
      st.vocode_ms += performance.now() - t;
    }
    let t = performance.now();
    const total = pieces.reduce((s, p) => s + p.length, 0), all = new Float32Array(total);
    let o = 0; for (const p of pieces) { all.set(p, o); o += p.length; }
    const sPtr = m._malloc(total * 4);
    m.HEAPF32.set(all, sPtr / 4);
    const a = m._SherpaOnnxOfflineTtsScaleSilence(tts.handle, sPtr, total, cfg.silenceScale || 0.2);
    m._free(sPtr);
    const samples = readAudio(a);
    m._SherpaOnnxDestroyOfflineTtsGeneratedAudio(a);
    st.silence_ms = performance.now() - t;
    return {samples, stages: st};
  } finally {
    m._free(textPtr);
    freeSherpaOnnxGenerationConfig(cfgWasm, m);
  }
}

self.onmessage = async (e) => {
  const {type, mode, text, genConfig, seed} = e.data;
  if (type !== 'generate' || !tts) return;
  try {
    if (seed !== null && seed !== undefined && seed >= 0) M()._SherpaOnnxOfflineTtsZipvoiceSetSeed(tts.handle, seed);
    const start = performance.now();
    const r = mode === 'webgpu' ? await generateWebGPU(text, genConfig, genConfig.numSteps) : generateWasm(text, genConfig);
    const genMs = performance.now() - start;
    self.postMessage({type: 'result', mode, samples: r.samples, sampleRate: tts.sampleRate, genMs, stages: r.stages,
                      wasmHeapBytes: heapBytes()}, [r.samples.buffer]);
  } catch (err) {
    self.postMessage({type: 'error', message: 'Generation failed: ' + (err.stack || err.message || err)});
  }
};
