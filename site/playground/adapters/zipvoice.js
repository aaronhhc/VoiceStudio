// ZipVoice-Distill INT8 via sherpa-onnx WASM (CPU). Reuses the baseline ../../web/worker.js unchanged.
import { } from './common.js';

let worker = null, info = null;
const WORKER_URL = new URL('../../web/worker.js', import.meta.url);

export default {
  id: 'zipvoice', name: 'ZipVoice-Distill (INT8)', backend: 'WASM · CPU · sherpa-onnx (1 thread)',
  languages: ['zh', 'en', 'zh+en'], size: '≈ 208 MB', needsRefText: true,
  status: 'Inference verified by automated tests (ASR intelligibility). No human listening check of this app yet.', knownIssues: [],
  refHint: 'Reference .wav, about 3–15 s, plus its exact transcript.',
  params: [{id: 'numSteps', label: 'Euler steps', type: 'number', def: 4, min: 1, max: 16, step: 1},
           {id: 'speed', label: 'Speed', type: 'number', def: 1, min: 0.5, max: 2, step: 0.1}],

  load({onProgress}) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      worker = new Worker(WORKER_URL);
      worker.onerror = (e) => reject(new Error('worker error: ' + (e.message || 'failed to load')));
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') {
          const d = m.status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
          if (d) onProgress({text: `Downloading ${(d[1] / 1048576).toFixed(0)} / ${(d[2] / 1048576).toFixed(0)} MB`, fraction: d[1] / d[2]});
          else if (m.status) onProgress({text: m.status === 'Running...' ? 'Initializing model…' : m.status});
        } else if (m.type === 'ready') {
          info = {loadMs: performance.now() - t0, sampleRate: m.sampleRate, wasmHeapBytes: m.wasmHeapBytes, modelType: m.modelType};
          resolve(info);
        } else if (m.type === 'error') reject(new Error(m.message));
      };
    });
  },

  generate({text, ref, refText, params, onProgress}) {
    return new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error('worker error: ' + (e.message || '')));
      const samples = ref.samples.slice(); // transferred to the worker
      const base = worker.onmessage;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress({text: `Generating… ${(m.progress * 100).toFixed(0)}%`, fraction: m.progress});
        else if (m.type === 'result') {
          worker.onmessage = base;
          resolve({samples: m.samples, sampleRate: m.sampleRate, genMs: m.genMs,
                   detail: {numSteps: params.numSteps, speed: params.speed, firstChunkMs: m.firstChunkMs, chunks: m.chunks, wasmHeapMB: Math.round(m.wasmHeapBytes / 1048576)}});
        } else if (m.type === 'error') { worker.onmessage = base; reject(new Error(m.message)); }
      };
      worker.postMessage({type: 'generate', text, genConfig: {
        speed: params.speed, numSteps: params.numSteps, referenceAudio: samples, referenceSampleRate: ref.sampleRate,
        referenceText: refText, extra: {min_char_in_sentence: 10}}}, [samples.buffer]);
    });
  },

  unload() { if (worker) worker.terminate(); worker = null; info = null; },
};
