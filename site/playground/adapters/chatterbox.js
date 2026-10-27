// Chatterbox (onnx-community/chatterbox-ONNX) via Transformers.js 4.0.0-next.2 + onnxruntime-web WebGPU.
// Worker: ../workers/chatterbox.worker.js (from branch experiment/chatterbox-browser, see docs/playground.md).
import { resample, refKey, rpcWorker, hosting, swCached } from './common.js';

const WORKER_URL = new URL('../workers/chatterbox.worker.js', import.meta.url);
const LOCAL_BASE = new URL('../../models/chatterbox/', import.meta.url).href;
const LOCAL_VOICE = LOCAL_BASE + 'onnx-community/chatterbox-ONNX/default_voice.wav';
const HF_VOICE = 'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/default_voice.wav';   // pinned (deploy/ghpages/hosting.json)

let worker = null, rpc = null, encodedKey = null, local = null, progress = null, runtimeInfo = null;
const probeLocal = async () => (local ??= await fetch(LOCAL_BASE + 'onnx-community/chatterbox-ONNX/config.json', {method: 'HEAD'}).then((r) => r.ok).catch(() => false));

export default {
  id: 'chatterbox', name: 'Chatterbox', backend: 'WebGPU · Transformers.js / ORT-web (q4f16 LM)',
  languages: ['en'], size: '≈ 1.5 GB', needsRefText: false,
  status: 'Inference verified by automated tests (ASR, seeded bitwise decoder check). Fast-start runtime: the project owner\'s stock-vs-patched listening comparison passed (normal Chrome, 2026-10-25). Individual outputs of this app are not certified.', knownIssues: [],
  note: 'English only. Keep input to about two sentences (≈ 200 characters): one generation is capped at max_new_tokens.',
  refHint: 'Reference clip of about 5–10 s. No transcript needed. Expression is controlled by exaggeration (0–1.5).',
  params: [{id: 'exaggeration', label: 'Exaggeration', type: 'number', def: 0.5, min: 0, max: 1.5, step: 0.05},
           {id: 'maxNewTokens', label: 'max_new_tokens', type: 'number', def: 256, min: 32, max: 1000, step: 16}],

  async defaultVoice() {
    const h = await hosting, url = h?.files['models/chatterbox/onnx-community/chatterbox-ONNX/default_voice.wav'] || ((await probeLocal()) ? LOCAL_VOICE : HF_VOICE);
    const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.arrayBuffer();
  },

  // Runtime selection (developer option, not in the user interface): ?ort=auto (default) | patched | stock. See docs/chatterbox_fastload.md.
  // auto: try the patched fast-load runtime; if it is missing, mismatched or fails to initialise, terminate that worker and load again with the stock
  // runtime in a fresh worker (no runtime state is shared), recording why. patched: strict, errors are reported. stock: the original runtime.
  async load(opts) {
    const want = new URLSearchParams(location.search).get('ort') || 'auto';
    if (want !== 'auto') return this._load(opts, want === 'patched' ? 'patched' : 'stock', null);
    try { return await this._load(opts, 'patched', null); }
    catch (e) {
      const reason = String(e.message || e).split('\n')[0];
      if (worker) worker.terminate(); worker = null; rpc = null;
      opts.onProgress?.({text: 'Using the standard runtime…'});
      return this._load(opts, 'stock', reason);
    }
  },

  async _load({onProgress, onDiag}, ort, fallbackReason) {
    // A deployed release (playground/hosting.json) loads the weights from the revision-pinned Hugging Face repository; development reads models/ when provisioned.
    const t0 = performance.now(), qs = new URLSearchParams(location.search), h = await hosting, hub = h?.repos?.chatterbox || null;
    const useLocal = !hub && await probeLocal();
    if (!useLocal && !hub && document.querySelector('meta[name="vs-release"]')) throw new Error('Chatterbox model files could not be reached on this website (offline, or missing from the site).');
    worker = new Worker(WORKER_URL, {type: 'module'}); encodedKey = null;
    rpc = rpcWorker(worker, {onEvent: (type, d) => {
      if (type === 'diag' && onDiag) onDiag(d);
      if (type === 'progress') {
        const fs = Object.values(d.files), tot = fs.reduce((s, f) => s + (f.total || 0), 0), got = fs.reduce((s, f) => s + (f.loaded || 0), 0);
        if (tot) onProgress({text: `${useLocal ? 'Loading local weights' : 'Downloading from Hugging Face'} ${(got / 1e6).toFixed(0)} / ${(tot / 1e6).toFixed(0)} MB`, fraction: got / tot});
      } else if (type === 'diag' && ['import:ok', 'processor:ok', 'model:ok'].includes(d.stage)) onProgress({text: d.stage.replace(':ok', ' ready')});
    }});
    const done = rpc.expect('loaded');
    rpc.send('load', {local: useLocal, base: LOCAL_BASE, hub: hub && {host: hub.host, revision: hub.revision, cached: swCached()}, profile: qs.get('cbdiag') === '1', runtime: {ort}, device: qs.get('cbdevice') || undefined});
    const info = await done; runtimeInfo = {...info.runtime, fallbackReason};
    return {...info, runtime: runtimeInfo, source: useLocal ? 'local static files' : hub ? `Hugging Face ${hub.repo}@${hub.revision.slice(0, 8)}` : 'Hugging Face Hub', loadMs: performance.now() - t0};
  },

  async generate({text, ref, params, onProgress}) {
    let encodeMs = 0;
    const key = refKey(ref);
    if (key !== encodedKey) {
      onProgress({text: 'Encoding reference voice…'});
      const s = await resample(ref, 24000), enc = rpc.expect('encoded');
      rpc.send('encode', {samples: s}, [s.buffer]);
      encodeMs = (await enc).ms; encodedKey = key;
    }
    onProgress({text: 'Generating…'});
    const gen = rpc.expect('generated');
    rpc.send('generate', {text, exaggeration: params.exaggeration ?? 0.5, maxNewTokens: params.maxNewTokens ?? 256});
    const r = await gen;
    return {samples: r.samples, sampleRate: r.sampleRate, genMs: r.genMs,
            detail: {ortRuntime: runtimeInfo && (runtimeInfo.ort + (runtimeInfo.fallbackReason ? ` (fallback: ${runtimeInfo.fallbackReason})` : '')), device: r.device, encodeMs: Math.round(encodeMs), tokenizeMs: Math.round(r.tokenizeMs), exaggeration: params.exaggeration, maxNewTokens: params.maxNewTokens}};
  },

  unload() { if (worker) worker.terminate(); worker = null; rpc = null; encodedKey = null; runtimeInfo = null; },
};
