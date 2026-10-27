// Product copy for the public Voice Studio: what each model card, the "Learn more" sheet, Compare and My Creations say about a model.
// Plain language first; technical detail only in `how`. Every claim here is backed by a measurement or record in docs/ (see `evidence`).
// Inference facts (languages, parameters, runtimes) stay in the adapters; this file never changes model behaviour.

// Verification levels, from strongest to weakest. A model can hold several; none of them certifies every future output.
//   human-accepted  — the project owner listened and accepted a specific build/setting (scope says which)
//   automated       — the browser pipeline is exercised by headless tests (valid audio, ASR intelligibility, timing); nobody listened
//   unverified      — no evidence yet
export const VERIFY_LABEL = {'human-accepted': 'Listening check passed', automated: 'Automated checks', unverified: 'Not verified yet'};

export const INFO = {
  'zipvoice-hybrid': {
    name: 'ZipVoice-Distill',
    benefit: 'Fast, responsive voice generation.',
    langs: [['en', 'English'], ['zh', '中文']],
    plus: 'Quick to get ready, and on our test Mac it spoke about four times faster than real time.',
    minus: 'Speaking style follows your recording; there is no expressiveness control.',
    about: 'A compact model that clones a voice from a short recording and speaks Mandarin and English. It is the quickest of the three on our test computer, which makes it a good first choice.',
    good: ['Quick results while you try different sentences', 'Mandarin and English', 'Repeatable output: the same seed gives the same audio'],
    mind: ['Needs the exact words of your recording (filled in automatically from the passage)', 'Mixed Chinese–English sentences work, but English words inside Mandarin can be misheard', 'No expressiveness control', 'Weights are licensed for non-commercial use only (CC BY-NC 4.0)'],
    how: 'ZipVoice-Distill (k2-fsa) is a distilled flow-matching TTS model. In this app the text front end, encoder and Vocos vocoder run in WebAssembly (sherpa-onnx), and the 4-step flow-matching decoder runs on your GPU through WebGPU (ONNX Runtime Web). Without WebGPU the whole model runs on the CPU in WebAssembly — same model, much slower.',
    size: 'about 0.25 GB the first time (about 0.22 GB without WebGPU); then saved in this browser unless you turn that off in My creations',
    settings: 'Steps, speed, seed, and (developer) backend.',
    verification: [
      {level: 'automated', text: 'Automated browser tests: English, Mandarin and mixed sentences generate valid audio; Whisper speech recognition reads English and Mandarin back exactly (intelligibility only).'},
      {level: 'automated', text: 'Measured on an Apple M5 Pro in Chrome 156: GPU decoder about 16× faster than the CPU-only path for the same English sentence (RTF 3.6 → 0.22, warm).'},
      {level: 'unverified', text: 'Nobody has yet listened to compare the GPU and CPU outputs, or judged how closely it matches a real speaker.'}],
    evidence: ['docs/recording_hybrid.md', 'docs/playground_hybrid.md', 'docs/performance_analysis.md'],
    license: 'Weights: CC BY-NC 4.0, non-commercial use only (k2-fsa ZipVoice model card, 2026-10-26); code Apache-2.0. Runtime: sherpa-onnx (Apache-2.0, includes eSpeak NG under GPL-3.0), ONNX Runtime Web (MIT).',
  },
  chatterbox: {
    name: 'Chatterbox',
    benefit: 'Expressive English voice generation.',
    langs: [['en', 'English']],
    plus: 'Adjustable expressiveness: turn the delivery up or down.',
    minus: 'English only, about two sentences at a time.',
    about: 'An English voice-cloning model with an expressiveness setting. It does not need a transcript of your recording. It does not speak Mandarin.',
    good: ['English speech with an adjustable, more or less animated delivery', 'No transcript needed for your recording'],
    mind: ['English only — Mandarin text will not sound right', 'Keep to about two sentences (≈ 200 characters) per generation', 'Its speed varies with the length of your recording and sentence: we have measured from about 0.6 to 2 seconds of work per second of speech'],
    how: 'Chatterbox (Resemble AI) in its ONNX export (onnx-community/chatterbox-ONNX): a speech encoder, a 4-bit quantised language model that predicts speech tokens, and a flow-matching decoder with vocoder. It runs through Transformers.js and ONNX Runtime Web on WebGPU (CPU WebAssembly without WebGPU). This app uses a patched ONNX Runtime build that skips one slow start-up planning step for the decoder, so the model is ready in a few seconds instead of about 40 (see Project Journey).',
    size: 'about 1.5 GB the first time; then saved in this browser unless you turn that off in My creations',
    settings: 'Exaggeration (expressiveness) and maximum length.',
    verification: [
      {level: 'human-accepted', text: 'Listening comparison passed (project owner, normal Chrome, real speech, 2026-10-25): the fast-start runtime and the original runtime sounded comparable in naturalness, intelligibility and speaker similarity, with no noise, clipping or silence. This approves the runtime change, not every output.'},
      {level: 'automated', text: 'Automated browser tests: the fast-start runtime gives bit-identical decoder output to the original on a seeded test; 42 generations transcribed exactly by Whisper; ready in 3.8 s instead of 38.4 s (Apple M5 Pro, Chrome 156).'},
      {level: 'unverified', text: 'Outputs of this integrated app have not been individually listened to.'}],
    evidence: ['docs/chatterbox_fastload.md', 'docs/chatterbox_lifecycle.md'],
    license: 'Model: MIT (Resemble AI; ONNX export by onnx-community, model card checked 2026-10-26). Runtime: Transformers.js (Apache-2.0), ONNX Runtime Web (MIT, patched build).',
  },
  f5: {
    name: 'F5-TTS',
    benefit: 'Flexible voice generation.',
    langs: [['en', 'English'], ['zh', '中文']],
    plus: 'Adjustable generation steps: fewer for speed, more for detail.',
    minus: 'Mixing Chinese and English in one sentence is experimental.',
    about: 'A voice-cloning model for Mandarin and English with an adjustable number of generation steps, so you can trade waiting time against detail.',
    good: ['Exploring the speed/quality trade-off with the step setting', 'Mandarin and English'],
    mind: ['Mixed Chinese–English sentences are experimental: English words inside Mandarin are often mispronounced', 'Usually slower than ZipVoice', 'Weights are licensed for non-commercial use only (CC BY-NC 4.0)'],
    how: 'F5-TTS (non-autoregressive flow matching with a diffusion transformer) in the nsarang/F5-TTS-ONNX export, run with ONNX Runtime Web on WebGPU (fp16 transformer). The "steps" setting is the number of function evaluations (NFE) of its Euler ODE sampler; this app uses a corrected sampling schedule so every setting integrates the full trajectory (see Project Journey). Mandarin text goes through an in-browser pinyin front end.',
    size: 'about 0.8 GB the first time; then saved in this browser unless you turn that off in My creations',
    settings: 'Steps (NFE 2–32, default 16) and speed.',
    verification: [
      {level: 'human-accepted', text: 'Listening check passed (project owner, 2026-10-22): English outputs at 12, 16 and 32 steps after the sampling fix, generated on the F5 test build, all sounded complete. This app’s outputs and Mandarin were not part of that check.'},
      {level: 'automated', text: 'Automated browser tests: every step setting reaches the end of the sampling trajectory (t = 1); English and Mandarin transcribed by Whisper; 35 schedule unit tests.'},
      {level: 'unverified', text: 'Mandarin and mixed-language sound quality: no listening check yet.'}],
    evidence: ['docs/playground_f5_fix.md'],
    license: 'Weights: CC BY-NC 4.0, non-commercial use only (SWivid F5-TTS; the nsarang ONNX export is tagged Apache-2.0 but derives from these weights). Runtime: ONNX Runtime Web (MIT), pinyin-pro (MIT).',
  },
};
// The plain WASM ZipVoice adapter is not a card; it only appears as the backend that actually ran.
INFO.zipvoice = {...INFO['zipvoice-hybrid']};

// What each parameter does, in words a non-specialist can act on. Shown under the control in Advanced settings and in Compare.
export const PARAM_HINT = {
  'zipvoice-hybrid': {numSteps: 'Decoder steps. 4 is what the model was distilled for; more steps take longer.', speed: 'Speaking rate. 1 is natural; above 1 is faster.', seed: 'Leave empty for a fresh variation each time; a number repeats the same result.', decoder: 'Developer option: where the decoder runs (GPU or CPU).'},
  zipvoice: {numSteps: 'Decoder steps. 4 is what the model was distilled for; more steps take longer.', speed: 'Speaking rate. 1 is natural; above 1 is faster.'},
  chatterbox: {exaggeration: 'Expressiveness. 0.5 is neutral; higher sounds more animated, lower flatter.', maxNewTokens: 'Upper limit on speech length. If a long sentence is cut off, raise it.'},
  f5: {nfeSteps: 'Generation steps (2–32). 16 is the default; 12 is faster; 32 is the full schedule.', speed: 'Speaking rate. 1 is natural.'},
};

// Plain-language "ran on" and settings lines for results (the exact backend string stays in a tooltip and in Developer diagnostics).
export function ranOn(backend) {
  if (/^WebGPU decoder/.test(backend)) return 'GPU + CPU (decoder on WebGPU)';
  if (/^WebGPU/.test(backend)) return 'GPU (WebGPU)';
  if (/WASM/.test(backend)) return 'CPU (WebAssembly)';
  return backend;
}
export function settingsText(model, params) {   // labels from the adapter, values from the run ("random" for an empty seed)
  if (!model || !params) return '';
  return model.params.filter((p) => !(p.id === 'decoder' && params.decoder === 'webgpu')).map((p) => `${p.label.replace('max_new_tokens', 'Max tokens')} ${params[p.id] == null ? (p.placeholder || 'auto') : params[p.id]}`).join(' · ');
}
