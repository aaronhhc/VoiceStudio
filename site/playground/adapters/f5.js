// F5-TTS (nsarang/F5-TTS-ONNX) via onnxruntime-web WebGPU (fp16 transformer). Worker: ../workers/f5.worker.js
// (from branch experiment/f5-browser). Chinese goes through an in-worker pinyin frontend (pinyin-pro).
import { resample, rpcWorker, hosting, swCached } from './common.js';

const WORKER_URL = new URL('../workers/f5.worker.js', import.meta.url);
let worker = null, rpc = null, genProgress = null;
// Diagnostic only (never exposed in the UI): ?diag=f5-truncate reproduces the ORIGINAL truncated sampling schedule so the regression can prove its detector works.
const DIAG_SCHEDULE = new URLSearchParams(location.search).get('diag') === 'f5-truncate' ? 'truncate' : 'stride';
export const F5_NFE = {min: 2, max: 32, def: 16};

export default {
  id: 'f5', name: 'F5-TTS', backend: 'WebGPU · ORT-web (fp16 transformer)',
  languages: ['zh', 'en', 'zh+en'], size: '≈ 790 MB (first visit, then cached)', needsRefText: true,
  status: 'Sampling-schedule fix (experiment/f5-browser 199e358): the project owner\'s listening check passed for English at NFE 12/16/32 on the F5 test build (2026-10-22). This app: automated checks (ODE reaches t = 1, mel statistics, ASR). Mandarin and code-switching: automated checks only.',
  knownIssues: [
    {lang: 'zh+en', level: 'warn', short: 'code-switching quality unverified', text: 'English words inside Mandarin are unreliable (e.g. "Starbucks" came out as "Starbox"); code-switching quality is unverified.'}],
  note: 'Weights are CC-BY-NC-4.0 derived (non-commercial). English–Chinese mixing is partial.',
  paramNote: 'NFE counts transformer evaluations + 1 (NFE−1 Euler steps), range 2–32. The exported transformer has a 31-step sampling grid baked in, so NFE 32 is the full grid; a lower NFE uses a subset of that grid (each step covers a longer interval, so the ODE still ends at t = 1). This approximates F5\'s own N-step schedule; it is not identical to it.',
  refHint: 'Reference clip of about 3–8 s (cost grows with its length) plus its exact transcript, in the same language as the clip.',
  params: [{id: 'nfeSteps', label: 'NFE steps', type: 'number', def: F5_NFE.def, min: F5_NFE.min, max: F5_NFE.max, step: 1,
            presets: [{label: '12 · faster', value: 12}, {label: '16 · efficient (default)', value: 16}, {label: '32 · full grid, for comparison', value: 32}]},
           {id: 'speed', label: 'Speed', type: 'number', def: 1, min: 0.5, max: 2, step: 0.1}],

  async load({onProgress}) {
    const t0 = performance.now();
    worker = new Worker(WORKER_URL, {type: 'module'});
    rpc = rpcWorker(worker, {onEvent: (type, d) => {
      // What the counter is: s = number of finished flow-matching sampling steps (one transformer evaluation each) out of n = NFE − 1 of THIS generation.
      // It is not overall progress: text analysis and the reference encoder come before step 1, the vocoder decoder and WAV conversion after step n.
      if (type === 'phase' && genProgress) genProgress({text: d.name === 'encode' ? 'Preparing your voice…' : d.name === 'decode' ? 'Finishing the audio…' : `Generating your voice — Step 1 of ${d.n}`});
      else if (type === 'step' && genProgress) genProgress({text: d.s < d.n ? `Generating your voice — Step ${d.s + 1} of ${d.n}` : 'Finishing the audio…'});
      else if (type === 'progress') {
        const fs = Object.values(d.files), tot = fs.reduce((s, f) => s + (f.total || 0), 0), got = fs.reduce((s, f) => s + (f.loaded || 0), 0);
        onProgress({text: `Downloading ${(got / 1e6).toFixed(0)} MB${tot ? ' / ' + (tot / 1e6).toFixed(0) + ' MB (current file)' : ''}`, fraction: tot ? got / tot : undefined});
      } else if (type === 'diag' && /^(ort:ok|session:start|session:ok)$/.test(d.stage)) onProgress({text: d.stage === 'ort:ok' ? 'Runtime ready' : `Compiling ${d.k || ''} ${d.stage.endsWith('ok') ? 'done' : '…'}`});
    }});
    const done = rpc.expect('loaded');
    // a deployed release without a hosting map serves the weights itself (no fallback to the Hub); with one (GitHub Pages) they come from the pinned repository
    rpc.send('load', {fp16: true, noRemote: !!document.querySelector('meta[name="vs-release"]') && !(await hosting), cached: swCached()});
    const info = await done;
    return {device: info.device, fp16: info.fp16, files: info.files, loadMs: performance.now() - t0, workerLoadMs: info.loadMs};
  },

  async generate({text, ref, refText, params, onProgress}) {
    const nfe = params.nfeSteps ?? F5_NFE.def;
    if (!Number.isInteger(nfe) || nfe < F5_NFE.min || nfe > F5_NFE.max) throw new Error(`F5 NFE must be an integer from ${F5_NFE.min} to ${F5_NFE.max} (got ${params.nfeSteps}).`);
    const refAudio = await resample(ref, 24000);
    genProgress = onProgress; onProgress({text: 'Preparing your voice…'});   // every generation starts from here; the step counter comes from this run's events only
    const gen = rpc.expect('generated');
    rpc.send('generate', {refAudio, refText, genText: text, speed: params.speed ?? 1, nfeSteps: nfe, schedule: DIAG_SCHEDULE}, [refAudio.buffer]);
    let r; try { r = await gen; } finally { genProgress = null; }
    const st = r.stages;
    return {samples: r.samples, sampleRate: r.sampleRate, genMs: r.genMs,
            detail: {unknownTokens: r.unknown, resolved: {nfeSteps: nfe}, schedule: r.melStats.schedule, odeEndT: +r.melStats.tEnd.toFixed(4), eulerSteps: r.melStats.steps, melStd: +r.melStats.std.toFixed(2), melStats: r.melStats, tokens: r.nTokens, unknownChars: r.unknown, encoderMs: Math.round(st.encoder_ms), transformerMs: Math.round(st.transformer_ms),
                     meanStepMs: Math.round(st.step_ms.reduce((a, b) => a + b, 0) / st.step_ms.length), decoderMs: Math.round(st.decoder_ms)}};
  },

  unload() { if (worker) worker.terminate(); worker = null; rpc = null; },
};
