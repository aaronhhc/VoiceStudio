// Chatterbox TTS in a module worker. Inference logic follows the official reference
// (resemble-ai/transformersjs-chatterbox-demo, src/workers/tts.worker.js) without React/Vite.
// Everything runs locally: Transformers.js (pinned CDN URL) + ONNX Runtime Web. Model weights come either from
// the Hugging Face Hub (default) or from this static server (?local=1, see fetch_models.sh); both are cached by the browser.
// Every stage posts a 'diag' event so a stuck run shows exactly where it stopped.
// Local-first dependency URL: the vendored jsDelivr mirror (playground/vendor, see docs/demo_assets.md) when it exists, else the CDN. Sync HEAD probe (allowed in workers).
const depUrl = (cdnUrl) => {
  const rel = cdnUrl.replace('https://cdn.jsdelivr.net/', ''), local = new URL('../vendor/jsdelivr/' + (rel.endsWith('+esm') ? rel + '.js' : rel), self.location.href).href;
  try { const x = new XMLHttpRequest(); x.open('HEAD', local, false); x.send(); if (x.status === 200) return local; } catch {}
  return cdnUrl;
};
const post = (type, data, tr) => self.postMessage({type, data}, tr || []);
const T0 = performance.now();
const diag = (stage, extra) => post('diag', {stage, t: Math.round(performance.now() - T0), ...extra});
self.addEventListener('error', (e) => post('fatal', {where: 'worker error event', message: e.message, file: e.filename, line: e.lineno}));
self.addEventListener('unhandledrejection', (e) => post('fatal', {where: 'unhandledrejection', message: String(e.reason?.stack || e.reason)}));
// Issue #14: in a deployed release (playground/hosting.json) every model file is sha256-checked before Transformers.js / ONNX Runtime can use it (./verify.js).
import './verify.js';
{ let h = null; try { const x = new XMLHttpRequest(); x.open('GET', new URL('../hosting.json', self.location.href), false); x.send(); if (x.status === 200) h = JSON.parse(x.responseText); } catch {}
  if (h) self.vsVerify.installFetch(h.integrity, new URL('../../', self.location.href)); }
const TJS_URL = depUrl('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0-next.2/+esm');
let ChatterboxModel, AutoProcessor, Tensor, env;
const MODEL_ID = 'onnx-community/chatterbox-ONNX';
// Only language_model has quantized variants in the repo; other sessions are fp32.
const DTYPES = {
  wasm:   {embed_tokens: 'fp32', speech_encoder: 'fp32', language_model: 'q4',    conditional_decoder: 'fp32'},
  webgpu: {embed_tokens: 'fp32', speech_encoder: 'fp32', language_model: 'q4f16', conditional_decoder: 'fp32'},
};
let model = null, processor = null, speaker = null, device = null;

async function hasWebGPU() {
  if (!self.navigator.gpu) return false;
  try { return !!(await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

const STALL_MS = 90e3; // abort a model load that receives no bytes for this long

async function load({device: want, local, base, hub, profile, runtime}) {
  const t0 = performance.now();
  diag('load:start', {local: !!local});
  try {
    ({ChatterboxModel, AutoProcessor, Tensor, env} = await withTimeout(import(TJS_URL), 60e3, 'import transformers.js from CDN'));
  } catch (e) { post('fatal', {where: 'import', message: String(e.message || e), url: TJS_URL}); throw e; }
  diag('import:ok', {ms: Math.round(performance.now() - t0), versions: env?.version ?? null});
  // Files served by this site are not copied into Transformers.js' own Cache Storage: in development they are already local, and a deployed release keeps
  // one copy through its service worker (deploy/sw.js). Two copies would cost another 1.5 GB of the visitor's disk.
  if (local) { env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = base; env.useBrowserCache = false; env.useWasmCache = false; }
  // Deployed release: the weights come from the revision-pinned upstream repository (hub = {host, revision, cached}, from playground/hosting.json).
  // When the site's service worker controls this worker it keeps (and sha256-checks) the one stored copy, so Transformers.js' own cache stays off.
  else if (hub) { env.allowLocalModels = false; env.allowRemoteModels = true; env.remoteHost = hub.host; env.remotePathTemplate = '{model}/resolve/{revision}/';
    env.useBrowserCache = !hub.cached; env.useWasmCache = false; }
  const revision = hub?.revision || 'main';
  const rt = await configureRuntime(runtime || {});   // must run before the first InferenceSession is created (the WASM is loaded lazily at that point)
  if (profile) await installProfiler();
  const gpu = await hasWebGPU();
  device = want || (gpu ? 'webgpu' : 'wasm');
  diag('device', {device, webgpuAvailable: gpu});
  const files = {}; let lastBytes = 0, lastAdvance = performance.now(), phase = 'processor';
  const watchdog = setInterval(() => {
    if (performance.now() - lastAdvance > STALL_MS) { post('stall', {phase, secondsWithoutBytes: Math.round((performance.now() - lastAdvance) / 1e3), files}); lastAdvance = performance.now(); }
  }, 10e3);
  const progress = (p) => {
    if (p.file) {
      const f = files[p.file] = {loaded: p.loaded ?? files[p.file]?.loaded ?? 0, total: p.total ?? files[p.file]?.total ?? 0, status: p.status};
      if (p.status === 'initiate' || p.status === 'done') diag('file:' + p.status, {file: p.file, total: f.total});
    }
    const got = Object.values(files).reduce((x, f) => x + (f.loaded || 0), 0);
    if (got !== lastBytes) { lastBytes = got; lastAdvance = performance.now(); }
    post('progress', {files});
  };
  try {
    processor = await withTimeout(AutoProcessor.from_pretrained(MODEL_ID, {revision, progress_callback: progress}), 120e3, 'AutoProcessor.from_pretrained');
    diag('processor:ok', {ms: Math.round(performance.now() - t0)});
    phase = 'model files';
    model = await ChatterboxModel.from_pretrained(MODEL_ID, {revision, device, dtype: DTYPES[device], progress_callback: progress});
    diag('model:ok', {ms: Math.round(performance.now() - t0)});
  } finally { clearInterval(watchdog); }
  const bytes = Object.values(files).reduce((s, f) => s + (f.total || 0), 0);
  post('loaded', {runtime: rt, profile: profileReport(), device, dtype: DTYPES[device], webgpuAvailable: gpu, local: !!local, revision, loadMs: performance.now() - t0, downloadedBytes: bytes});
}

// ---- ONNX Runtime selection: Chatterbox fast-load (see docs/chatterbox_fastload.md) --------------------------------------------------------------------
// 'stock'   = the onnxruntime-web WASM Transformers.js resolves (vendored jsDelivr copy).
// 'patched' = playground/ort-patched/, built from the SAME ONNX Runtime commit by experiments/chatterbox-ort/build_ort_web.sh with one change: the session
//             config key session.disable_mem_reuse. Only the WASM and its Emscripten glue differ; the JS API (shared by all four sessions) is the stock one.
// The key is added to the conditional_decoder session only; embed_tokens, speech_encoder and the language model keep ORT defaults. Nothing else changes.
// 'patched' is strict: missing or mismatching artefacts throw (the adapter reports it). The adapter resolves 'auto' and retries with 'stock' in a fresh
// worker if the patched runtime cannot be used, so no half-initialised runtime is ever reused.
const PATCHED_BASE = new URL('../ort-patched/', self.location.href).href, ONLY_SESSION = /(^|\/)conditional_decoder\.onnx_data$/;
async function patchedArtifacts(ver) {   // presence + build commit must match the ORT version Transformers.js imports (…-<commit prefix>)
  const info = await fetch(PATCHED_BASE + 'BUILD-INFO.txt').then((r) => (r.ok ? r.text() : null), () => null);
  if (!info) return {ok: false, reason: 'patched runtime not built (playground/ort-patched/BUILD-INFO.txt missing)'};
  const commit = (info.match(/onnxruntime ([0-9a-f]{40})/) || [])[1], want = (ver || '').split('-').pop();
  if (!commit || !want || !commit.startsWith(want)) return {ok: false, reason: `patched runtime built from ${commit ? commit.slice(0, 10) : 'an unknown commit'}, but Transformers.js imports onnxruntime-web ${ver}`};
  for (const f of ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs']) {
    const r = await fetch(PATCHED_BASE + f, {method: 'HEAD'}).catch(() => null);
    if (!r || !r.ok) return {ok: false, reason: `patched runtime incomplete (${f} missing)`};
  }
  return {ok: true, commit};
}
async function configureRuntime({ort = 'stock'}) {
  const ver = env.backends?.onnx?.versions?.web, mod = await import(depUrl(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/webgpu/+esm`));
  const info = {requested: ort, ort: 'stock', version: ver, sessionsWithReuseOff: []};
  if (ort === 'patched') {
    const a = await patchedArtifacts(ver);
    if (!a.ok) { const e = new Error(a.reason); e.code = 'PATCHED_RUNTIME_UNAVAILABLE'; throw e; }
    env.backends.onnx.wasm.wasmPaths = {mjs: PATCHED_BASE + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: PATCHED_BASE + 'ort-wasm-simd-threaded.asyncify.wasm'};
    info.ort = 'patched'; info.buildCommit = a.commit;
    const IS = mod.InferenceSession, create = IS.create.bind(IS);
    IS.create = (buf, opts = {}) => {
      const names = (opts.externalData || []).map((e) => e.path || '');
      if (!names.some((n) => ONLY_SESSION.test(n))) return create(buf, opts);
      info.sessionsWithReuseOff.push(names.join(' '));
      return create(buf, {...opts, extra: {...(opts.extra || {}), session: {...(opts.extra?.session || {}), disable_mem_reuse: '1'}}});
    };
  }
  info.wasm = String(env.backends.onnx.wasm.wasmPaths?.wasm || 'stock default (resolved by Transformers.js)');
  diag('runtime', info); return info;
}

// ---- cold-start profiler (diagnostic, ?cbdiag=1): times every InferenceSession.create (ported from diag/chatterbox-coldstart) -------------------------
const prof = {t0: 0, sessions: [], on: false};
async function installProfiler() {
  const ver = env.backends?.onnx?.versions?.web, mod = await import(depUrl(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/webgpu/+esm`));
  const IS = mod.InferenceSession, create = IS.create.bind(IS); prof.t0 = performance.now(); prof.on = true;
  IS.create = async (buf, opts = {}) => {
    const rec = {model: ((opts.externalData || [])[0]?.path || '').replace(/_data$/, '') || `model ${buf?.byteLength} B`, start: performance.now() - prof.t0};
    const s = await create(buf, opts); rec.ms = performance.now() - prof.t0 - rec.start; prof.sessions.push(rec); diag('session:created', rec); return s;
  };
}
const profileReport = () => (prof.on ? {sessions: prof.sessions} : null);

function withTimeout(p, ms, what) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms / 1000}s: ${what}`)), ms); })]).finally(() => clearTimeout(t));
}

async function encode({samples}) {
  const t = performance.now();
  const audio = new Tensor('float32', samples, [1, samples.length]);
  speaker = await model.encode_speech(audio);
  post('encoded', {ms: performance.now() - t, samples: samples.length});
}

async function generate({text, exaggeration, maxNewTokens}) {
  if (!speaker) throw new Error('No reference voice encoded');
  const t = performance.now();
  const inputs = await processor._call(text);
  const tTok = performance.now();
  const wav = await model.generate({...inputs, ...speaker, exaggeration, max_new_tokens: maxNewTokens});
  const ms = performance.now() - t;
  const out = new Float32Array(wav.data); // copy
  post('generated', {samples: out, sampleRate: 24000, genMs: ms, tokenizeMs: tTok - t, device}, [out.buffer]);
}

self.onmessage = async (e) => {
  const {type, data} = e.data;
  try {
    if (type === 'load') await load(data);
    else if (type === 'encode') await encode(data);
    else if (type === 'generate') await generate(data);
  } catch (err) {
    post('error', {message: String(err.message || err), stack: err.stack});
  }
};
diag('worker:ready');
post('worker-ready', {});
