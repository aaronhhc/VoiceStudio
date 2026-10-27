// Loads the sherpa-onnx WASM runtime (fetched into runtime/) and runs ZipVoice generation off the main thread.
let tts = null;
const heapBytes = () => self.Module.HEAPF32.byteLength;
const t0 = performance.now();

// Release asset map (../playground/hosting.json, written by deploy/ghpages/build.mjs): the model bundle (.data) comes from its revision-pinned
// upstream Hugging Face Space. Absent when this baseline runs on its own or in development: everything is then read from runtime/.
const HOSTING = (() => { try { const x = new XMLHttpRequest(); x.open('GET', new URL('../playground/hosting.json', self.location.href), false); x.send(); return x.status === 200 ? JSON.parse(x.responseText) : null; } catch { return null; } })();
// Issue #14: in a release, the bundle and the runtime are sha256-checked before the Emscripten loader can use them (../playground/workers/verify.js).
if (HOSTING) { importScripts('../playground/workers/verify.js'); self.vsVerify.installFetch(HOSTING.integrity, new URL('../', self.location.href)); }

// The Emscripten loader downloads the model bundle with fetch(); a dropped connection rejects a promise nobody awaits, which a worker never reports to
// the page. Report it, and treat 60 s without download progress as a failure too, so the page shows an error instead of waiting forever.
let ready = false, lastProgress = performance.now();
const fail = (message) => { if (!ready) self.postMessage({type: 'error', message}); ready = true; };
self.addEventListener('unhandledrejection', (e) => fail('Model download failed: ' + (e.reason?.message || e.reason)));
const stall = setInterval(() => { if (ready) clearInterval(stall); else if (performance.now() - lastProgress > 60e3) fail('Model download stalled: no data for 60 s'); }, 5e3);

self.Module = {
  locateFile: (path, dir = '') => HOSTING?.files['web/runtime/' + path] || dir + 'runtime/' + path,
  setStatus: (status) => { lastProgress = performance.now(); self.postMessage({type: 'status', status}); },
  onRuntimeInitialized: () => {
    ready = true; const tFetched = performance.now();
    try {
      tts = createOfflineTts(self.Module);
      const tReady = performance.now();
      self.postMessage({
        type: 'ready',
        modelType: getDefaultOfflineTtsModelType(),
        sampleRate: tts.sampleRate,
        loadMs: {download_and_instantiate: tFetched - t0, init_tts: tReady - tFetched, total: tReady - t0},
        wasmHeapBytes: heapBytes(),
      });
    } catch (e) {
      self.postMessage({type: 'error', message: 'TTS initialization failed: ' + e.message});
    }
  },
};
importScripts('runtime/sherpa-onnx-wasm-main-tts.js');
importScripts('runtime/sherpa-onnx-tts.js');

self.onmessage = (e) => {
  const {type, text, genConfig} = e.data;
  if (type !== 'generate' || !tts) return;
  const start = performance.now();
  let firstChunkMs = null, chunks = 0;
  try {
    const config = {...genConfig};
    config.callback = (samples, n, progress) => {
      if (firstChunkMs === null) firstChunkMs = performance.now() - start;
      chunks++;
      self.postMessage({type: 'progress', progress});
      return 1; // continue
    };
    const audio = tts.generateWithConfig(text, config);
    const genMs = performance.now() - start;
    self.postMessage({
      type: 'result', samples: audio.samples, sampleRate: audio.sampleRate,
      genMs, firstChunkMs, chunks, wasmHeapBytes: heapBytes(),
    }, [audio.samples.buffer]);
  } catch (err) {
    self.postMessage({type: 'error', message: 'Generation failed: ' + (err.stack || err.message || err)});
  }
};
