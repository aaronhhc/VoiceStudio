// [playground copy of f5/worker.js: base experiment/f5-browser b292ac0 + sampling-schedule fix from 199e358 (applied as a patch; eulerPlan lives in ./f5-schedule.js,
//  a byte-identical copy of f5/schedule.js @ 199e358) + vocab.txt goes through fetchCached. See docs/playground_f5_fix.md]
// F5-TTS (nsarang/F5-TTS-ONNX) in a module worker. Pipeline follows nsarang/voice-cloning-f5-tts src/core/f5-tts.js
// (encoder -> transformer x (NFE-1) -> decoder), re-implemented without React/Vite/torch-tensor shim.
// Everything runs locally with ONNX Runtime Web; weights are downloaded from the Hugging Face Hub.
// Local-first dependency URL: the vendored jsDelivr mirror (playground/vendor, see docs/demo_assets.md) when it exists, else the CDN. Sync HEAD probe (allowed in workers).
const depUrl = (cdnUrl) => {
  const rel = cdnUrl.replace('https://cdn.jsdelivr.net/', ''), local = new URL('../vendor/jsdelivr/' + (rel.endsWith('+esm') ? rel + '.js' : rel), self.location.href).href;
  try { const x = new XMLHttpRequest(); x.open('HEAD', local, false); x.send(); if (x.status === 200) return local; } catch {}
  return cdnUrl;
};
import {eulerPlan} from './f5-schedule.js';
import './verify.js';
let ort; // loaded in load() so an import failure is reported instead of silently killing the worker
const ORT_MJS = depUrl('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.mjs'), ORT_BASE = ORT_MJS.slice(0, ORT_MJS.lastIndexOf('/') + 1);
// Release asset map (playground/hosting.json, written by deploy/ghpages/build.mjs): large model files come from their revision-pinned upstream
// Hugging Face repositories. Absent in development, where everything is served from this checkout.
const HOSTING = (() => { try { const x = new XMLHttpRequest(); x.open('GET', new URL('../hosting.json', self.location.href), false); x.send(); return x.status === 200 ? JSON.parse(x.responseText) : null; } catch { return null; } })();
if (HOSTING) self.vsVerify.installFetch(HOSTING.integrity, new URL('../../', self.location.href));   // issue #14: model files are sha256-checked before use
const LOCAL_REPO = new URL('../../models/f5/', self.location.href).href, HF_REPO = 'https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/2e7e47e103a565c85dcd32141b6b11eeeb57eee6/';
// weights: a deployed release's pinned repository; else local models/f5/ when provisioned (offline-safe, works on any origin/port), else the Hugging Face Hub
// (same pinned revision, then cached in Cache Storage per origin)
const REPO = HOSTING?.repos?.f5?.base || (() => { try { const x = new XMLHttpRequest(); x.open('HEAD', LOCAL_REPO + 'vocab.txt', false); x.send(); if (x.status === 200) return LOCAL_REPO; } catch {} return HF_REPO; })();
let swCached = false;   // set by load(): the site's service worker keeps (and sha256-checks) the one stored copy, so this worker does not cache
const HOP = 256, SR = 24000, TARGET_RMS = 0.1;
const post = (type, data, tr) => self.postMessage({type, data}, tr || []);
const T0 = performance.now();
const diag = (stage, extra) => post('diag', {stage, t: Math.round(performance.now() - T0), ...extra});
self.addEventListener('error', (e) => post('fatal', {where: 'worker error event', message: e.message, file: e.filename, line: e.lineno}));
self.addEventListener('unhandledrejection', (e) => post('fatal', {where: 'unhandledrejection', message: String(e.reason?.stack || e.reason)}));
let S = null; // {encoder, transformer, decoder, vocab, fp16, provider}

async function fetchCached(url, onProgress) { // Cache Storage so re-visits skip the Hugging Face download
  // Files served by this site (models/f5/) are not copied into Cache Storage: they are already local, and on a fresh browser profile Chrome's
  // cache.put of these 60–660 MB responses failed with "Unexpected internal error", which aborted the background preload (found by test_wait.mjs).
  // A failed cache write is never fatal: the bytes are already in memory, only the next visit loses the cached copy.
  const cache = url.startsWith(LOCAL_REPO) || swCached ? null : await caches.open('f5-onnx-v1').catch(() => null);
  let r = cache ? await cache.match(url).catch(() => undefined) : undefined, fromCache = !!r;
  if (!r) {
    const resp = await fetch(url); if (!resp.ok) throw new Error(`${resp.status} ${url}`);
    const total = +resp.headers.get('content-length') || 0, reader = resp.body.getReader(), chunks = []; let got = 0;
    for (;;) { const {done, value} = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('download stalled: no bytes for 60s: ' + url)), 60e3))]); if (done) break; chunks.push(value); got += value.length; onProgress(got, total); }
    // Join the chunks in memory. (A Blob of this size is paged to disk by Chrome, and reading it back failed on fresh profiles with
    // "The requested file could not be read" — the second symptom of the same preload failure.)
    const bytes = new Uint8Array(got); let off = 0; for (const c of chunks) { bytes.set(c, off); off += c.length; }
    if (cache) try { await cache.put(url, new Response(bytes, {headers: {'content-length': String(got)}})); } catch (e) { diag('cache:put-failed', {url, message: String(e.message || e)}); }
    return {buf: bytes.buffer, bytes: got, fromCache: false};
  }
  const buf = await r.arrayBuffer(); onProgress(buf.byteLength, buf.byteLength);
  return {buf, bytes: buf.byteLength, fromCache};
}

async function fp16Supported() {
  try { const a = await navigator.gpu.requestAdapter(); return !!a && a.features.has('shader-f16'); } catch { return false; }
}

async function load({device, fp16, noRemote, cached}) {
  const t0 = performance.now(), prog = {}; swCached = !!cached;
  diag('load:start');
  if (noRemote && REPO !== LOCAL_REPO) throw new Error('F5-TTS model files could not be reached on this website (offline, or missing from the site).');
  try { ort = await import(ORT_MJS); } catch (e) { post('fatal', {where: 'import onnxruntime-web', message: String(e.message || e), url: ORT_MJS}); throw e; }
  ort.env.wasm.wasmPaths = ORT_BASE;
  diag('ort:ok', {version: ort.env.versions?.web});
  const gpu = !!self.navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  device = device || (gpu ? 'webgpu' : 'wasm');
  const useFp16 = device === 'webgpu' && fp16 !== false && await fp16Supported();
  const files = {encoder: 'onnx/encoder_fp32.onnx', transformer: useFp16 ? 'onnx/transformer_fp16.onnx' : 'onnx/transformer_fp32.onnx', decoder: 'onnx/decoder_fp32.onnx'};
  const info = {};
  const got = {};
  for (const [k, f] of Object.entries(files)) {
    diag('fetch:start', {file: f});
    got[k] = await fetchCached(REPO + f, (l, t) => { prog[k] = {loaded: l, total: t}; post('progress', {files: prog}); });
    info[k] = {file: f, bytes: got[k].bytes, fromCache: got[k].fromCache};
    diag('fetch:done', {file: f, bytes: got[k].bytes, fromCache: got[k].fromCache});
  }
  const tFetched = performance.now();
  const opts = {executionProviders: [device], graphOptimizationLevel: 'all'};
  const sessions = {};
  for (const k of Object.keys(files)) { const t = performance.now(); diag('session:start', {k}); sessions[k] = await ort.InferenceSession.create(got[k].buf, opts); diag('session:ok', {k, ms: Math.round(performance.now() - t)}); info[k].sessionMs = performance.now() - t; got[k] = null; }
  const vocabText = new TextDecoder().decode((await fetchCached(REPO + 'vocab.txt', () => {})).buf); // cached like the weights (offline-safe after first load)
  const vocab = {}; vocabText.split('\n').forEach((c, i) => { if (c.trim()) vocab[c.trim()] = i; });
  S = {...sessions, vocab, fp16: useFp16, device};
  // The Mandarin front end is part of the model: load it now (470 kB) rather than at the first Mandarin sentence, so a model that is ready offline is ready
  // for both languages. Not fatal here; a Mandarin generation reports it if it is still missing.
  if (!pinyinFn) try { pinyinFn = (await import(PINYIN_URL)).pinyin; } catch (e) { diag('pinyin:deferred', {message: String(e.message || e)}); }
  post('loaded', {device, fp16: useFp16, loadMs: performance.now() - t0, fetchMs: tFetched - t0, files: info, vocabSize: Object.keys(vocab).length,
                  io: {encoder: [S.encoder.inputNames, S.encoder.outputNames], transformer: [S.transformer.inputNames, S.transformer.outputNames], decoder: [S.decoder.inputNames, S.decoder.outputNames]}});
}


// ---- Text frontend -------------------------------------------------------------------------------------------
// F5-TTS (Emilia ZH+EN checkpoint) tokenizes Chinese as whole pinyin syllables with a tone digit ("jin1"), each preceded
// by a space token; other characters are single tokens. The upstream browser port does a per-UTF-16-char lookup, which
// cannot produce these tokens (raw hanzi -> id 0). This re-implements SWivid/F5-TTS convert_char_to_pinyin with pinyin-pro.
// Verified against the pypinyin+jieba reference (f5_tokens.py) - see docs/f5_browser.md for the measured token diff.
const PINYIN_URL = depUrl('https://cdn.jsdelivr.net/npm/pinyin-pro@3.29.5/+esm');
const isZh = (c) => c >= '\u3100' && c <= '\u9fff';
let pinyinFn = null;
async function tokenize(text) {
  const chars = [...text];
  if (!chars.some(isZh)) return text.split(''); // English/ASCII: unchanged upstream behaviour
  if (!pinyinFn) { try { pinyinFn = (await import(PINYIN_URL)).pinyin; } catch (e) { post('fatal', {where: 'import pinyin-pro', message: String(e.message || e), url: PINYIN_URL}); throw e; } }
  text = text.replace(/;/g, ',').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const out = []; let i = 0;
  const syll = (run) => pinyinFn(run, {toneType: 'num', type: 'array', v: true, nonZh: 'removed'}).map((p) => p.replace(/0$/, '')); // neutral tone: "men0" -> "men"
  while (i < text.length) {
    const c = text[i];
    if (isZh(c)) { // run of hanzi -> pinyin with context-aware polyphone/tone-sandhi handling
      let j = i; while (j < text.length && isZh(text[j])) j++;
      const py = syll(text.slice(i, j)); for (const p of py) out.push(' ', p); i = j;
    } else if (/[A-Za-z0-9]/.test(c)) { // ascii word: insert a separating space like jieba-segment rule (len>1)
      let j = i; while (j < text.length && /[A-Za-z0-9]/.test(text[j])) j++;
      const w = text.slice(i, j); if (out.length && w.length > 1 && !' :\'"'.includes(out[out.length - 1])) out.push(' ');
      out.push(...w); i = j;
    } else { out.push(c); i++; }
  }
  return out;
}

const stats = (a) => { let m = 0, v = 0, lo = Infinity, hi = -Infinity; for (let i = 0; i < a.length; i++) { m += a[i]; lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } m /= a.length; for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2; return {mean: m, std: Math.sqrt(v / a.length), min: lo, max: hi}; };

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
function toInt16Scaled(a) { // normalizeToInt16 (quantile 0.999 of |x|) as in upstream audio.js
  const abs = Float32Array.from(a, Math.abs).sort(), pos = (abs.length - 1) * 0.999, lo = Math.floor(pos);
  const q = abs[lo] + (abs[Math.min(lo + 1, abs.length - 1)] - abs[lo]) * (pos - lo);
  const sc = q > 0 ? 32767 / q : 1, out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(a[i] * sc)));
  return out;
}
const toF16 = (t) => { const d = new Float16Array(t.data); return new ort.Tensor('float16', d, t.dims); };
const toF32 = (t) => new ort.Tensor('float32', Float32Array.from(t.data), t.dims);

async function generate({refAudio, refText, genText, speed, nfeSteps, tokenList, schedule = 'stride', noiseOverride, returnMel}) {
  if (!S) throw new Error('Model not loaded');
  const T = {}; let t = performance.now();
  const refRms = rms(refAudio); let ref = refAudio;
  if (refRms < TARGET_RMS) ref = refAudio.map((x) => x * TARGET_RMS / refRms);
  const pcm = toInt16Scaled(ref);
  // tokenList: optional pre-tokenized input (diagnostic hook; e.g. reference jieba+pypinyin tokens for Chinese).
  // Default is upstream browser behaviour: one vocab lookup per UTF-16 character, unknown -> 0.
  const units = tokenList || await tokenize(refText + ' ' + genText);
  const tokens = Int32Array.from(units, (c) => S.vocab[c] || 0);
  const unknown = [...new Set(units.filter((c) => !S.vocab[c]))];
  const enc = new TextEncoder(), refBytes = enc.encode(refText).length, genBytes = enc.encode(genText).length; // F5 uses UTF-8 byte lengths
  const refLen = Math.trunc(ref.length / HOP);
  const duration = refLen + Math.trunc((refLen / (refBytes + 1)) * genBytes / speed);
  T.prep_ms = performance.now() - t; t = performance.now();

  post('phase', {name: 'encode'});   // progress reporting only (UI text); no effect on inference
  const encOut = await S.encoder.run({
    [S.encoder.inputNames[0]]: new ort.Tensor('int16', pcm, [1, 1, pcm.length]),
    [S.encoder.inputNames[1]]: new ort.Tensor('int32', tokens, [1, tokens.length]),
    [S.encoder.inputNames[2]]: new ort.Tensor('int64', BigInt64Array.from([BigInt(duration)]), [1]),
  });
  const o = S.encoder.outputNames.map((n) => encOut[n]);
  let [noise, cosQ, sinQ, cosK, sinK, mel, melDrop] = o; const refSignalLen = o[7];
  if (noiseOverride) { if (noiseOverride.length !== noise.data.length) throw new Error(`noiseOverride length ${noiseOverride.length} != ${noise.data.length}`); noise = new ort.Tensor('float32', Float32Array.from(noiseOverride), noise.dims); } // diagnostic: fixed seed
  if (S.fp16) [noise, cosQ, sinQ, cosK, sinK, mel, melDrop] = [noise, cosQ, sinQ, cosK, sinK, mel, melDrop].map(toF16);
  T.encoder_ms = performance.now() - t; t = performance.now();

  const plan = eulerPlan(nfeSteps - 1, schedule); const stepMs = [];
  post('phase', {name: 'sample', n: plan.length});
  for (let s = 0; s < plan.length; s++) { // nfeSteps counts like the original loop: nfeSteps-1 transformer evaluations
    const ts = performance.now(), {idx, scale} = plan[s], prev = noise.data;
    const out = await S.transformer.run(Object.fromEntries([noise, cosQ, sinQ, cosK, sinK, mel, melDrop, new ort.Tensor('int32', new Int32Array([idx]), [1])].map((v, i) => [S.transformer.inputNames[i], v])));
    noise = out[S.transformer.outputNames[0]];
    if (scale !== 1) { const d = noise.data; for (let i = 0; i < d.length; i++) d[i] = prev[i] + (d[i] - prev[i]) * scale; } // typed array of the tensor's own dtype (fp16 or fp32)
    stepMs.push(performance.now() - ts); post('step', {s: s + 1, n: plan.length});
  }
  T.transformer_ms = performance.now() - t; T.step_ms = stepMs; t = performance.now();

  if (S.fp16) noise = toF32(noise);
  const melGen = noise.data.subarray(refLen * 100), melStats = {...stats(melGen), tEnd: plan[plan.length - 1].t1, steps: plan.length, schedule};
  post('phase', {name: 'decode'});
  const dec = await S.decoder.run({[S.decoder.inputNames[0]]: noise, [S.decoder.inputNames[1]]: refSignalLen});
  const sig = dec[S.decoder.outputNames[0]].data; // int16-range
  let wav = Float32Array.from(sig, (v) => v / 32767);
  if (refRms < TARGET_RMS) wav = wav.map((x) => x * refRms / TARGET_RMS);
  T.decoder_ms = performance.now() - t;
  post('generated', {units, samples: wav, sampleRate: SR, stages: T, duration, refLen, nTokens: tokens.length, unknown, melStats, mel: returnMel ? Float32Array.from(noise.data) : undefined, genMs: T.prep_ms + T.encoder_ms + T.transformer_ms + T.decoder_ms}, [wav.buffer]);
}

self.onmessage = async (e) => {
  try { if (e.data.type === 'load') await load(e.data.data); else if (e.data.type === 'generate') await generate(e.data.data); }
  catch (err) { post('error', {message: String(err.message || err), stack: err.stack}); }
};
diag('worker:ready');
post('worker-ready', {});
