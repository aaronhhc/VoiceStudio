// ZipVoice-Distill, hybrid: frontend + encoder + Vocos in patched sherpa-onnx WASM, flow-matching decoder (dequantized FP32)
// on WebGPU via onnxruntime-web. Falls back to the WASM baseline adapter (zipvoice.js) when WebGPU or the decoder is unavailable.
// Worker: ../workers/zipvoice-hybrid.worker.js (adapted from experiment/webgpu-feasibility, see docs/playground_hybrid.md).

const WORKER_URL = new URL('../workers/zipvoice-hybrid.worker.js', import.meta.url);
let worker = null, info = null;

export default {
  id: 'zipvoice-hybrid', name: 'ZipVoice-Distill (Hybrid WebGPU)', backend: 'WebGPU FP32 decoder + WASM frontend/Vocos · onnxruntime-web 1.30.0',
  languages: ['zh', 'en', 'zh+en'], size: '≈ 250 MB (the 204 MB bundle shared with the WASM baseline; the FP32 decoder is rebuilt from its INT8 decoder)', needsRefText: true,
  note: 'Falls back to the WASM baseline automatically if WebGPU or the decoder is unavailable. Output is not streaming.',
  status: 'Inference verified by automated tests (ASR intelligibility, same-seed determinism, numerical closeness to the WASM decoder). No human listening comparison of GPU vs CPU output yet.', knownIssues: [],
  fallback: 'zipvoice',
  refHint: 'Reference .wav, about 3–15 s, plus its exact transcript.',
  params: [{id: 'numSteps', label: 'Euler steps', type: 'number', def: 4, min: 1, max: 16, step: 1},
           {id: 'speed', label: 'Speed', type: 'number', def: 1, min: 0.5, max: 2, step: 0.1},
           {id: 'seed', label: 'Seed', type: 'number', def: '', placeholder: 'random', min: 0, max: 2147483647, step: 1},
           {id: 'decoder', label: 'Decoder', type: 'select', def: 'webgpu', options: ['webgpu', 'wasm']}],

  async preflight() { // cheap check before any large download
    if (!self.navigator.gpu) throw new Error('WebGPU unavailable (navigator.gpu missing)');
    const a = await navigator.gpu.requestAdapter();
    if (!a) throw new Error('WebGPU unavailable (no adapter)');
  },

  async load({onProgress}) {
    await this.preflight();
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      worker = new Worker(WORKER_URL);
      worker.onerror = (e) => reject(new Error('worker error: ' + (e.message || 'failed to load')));
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') {
          const d = m.status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/), g = m.status.match(/Downloading WebGPU decoder (\d+) \/ (\d+) MB/);
          if (d) onProgress({text: `Downloading bundle ${(d[1] / 1048576).toFixed(0)} / ${(d[2] / 1048576).toFixed(0)} MB`, fraction: d[1] / d[2]});
          else if (g) onProgress({text: m.status, fraction: g[1] / g[2]});
          else if (m.status) onProgress({text: m.status === 'Running...' ? 'Initializing model…' : m.status});
        } else if (m.type === 'ready') { info = {loadMs: performance.now() - t0, sampleRate: m.sampleRate, stages: m.loadMs, decoderSource: m.decoderSource}; resolve(info); }
        else if (m.type === 'error') reject(new Error(m.message));
      };
    });
  },

  generate({text, ref, refText, params, onProgress}) {
    return new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error('worker error: ' + (e.message || '')));
      const samples = ref.samples.slice(), base = worker.onmessage;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'result') {
          worker.onmessage = base; const st = m.stages;
          resolve({samples: m.samples, sampleRate: m.sampleRate, genMs: m.genMs,
                   detail: {backend: m.mode, numSteps: params.numSteps, speed: params.speed, seed: params.seed, chunks: st.chunks, prepareMs: Math.round(st.prepare_ms ?? 0),
                            decoderMs: Math.round(st.decoder_ms ?? st.generate_ms ?? 0), vocodeMs: Math.round(st.vocode_ms ?? 0), wasmHeapMB: Math.round(m.wasmHeapBytes / 1048576)}});
        } else if (m.type === 'error') { worker.onmessage = base; reject(new Error(m.message)); }
      };
      onProgress({text: 'Generating…'});
      worker.postMessage({type: 'generate', mode: params.decoder === 'wasm' ? 'wasm' : 'webgpu', text, seed: params.seed ?? -1, genConfig: {
        speed: params.speed, numSteps: params.numSteps, referenceAudio: samples, referenceSampleRate: ref.sampleRate,
        referenceText: refText, extra: {min_char_in_sentence: 10}}}, [samples.buffer]);
    });
  },

  unload() { if (worker) worker.terminate(); worker = null; info = null; },
};
