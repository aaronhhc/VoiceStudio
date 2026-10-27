# Hybrid WebGPU ZipVoice in the microphone-only Recording Playground

Branch `feature/recording-hybrid` (from `feature/guided-voice-recording` ebdc352). Nothing merged or pushed. The hybrid pipeline is the one validated in `docs/playground_hybrid.md`; its worker and adapter are byte-copies from `experiment/playground-hybrid` c717e51 (no inference code rewritten).

## Integration
- Public page: one **ZipVoice-Distill** tile backed by the hybrid adapter. WebGPU decoder when the browser has an adapter, otherwise (or if the decoder download / first generation fails) automatic fallback to the WASM baseline adapter with a notice that stays on screen.
- **Advanced settings → ZipVoice backend**: "Automatic" (default) or "WASM CPU only" (plain baseline adapter), plus the hybrid's own Euler steps / speed / seed / decoder controls.
- After every generation the page states the **backend that actually ran**, taken from the adapter's result (`detail.backend`), not from the request: result line "Backend used: …", metrics rows "Backend actually used", "RTF (inference ÷ audio)", "End-to-end RTF (click → result ÷ audio)", and the hybrid's component timings under "Backend detail".
- Guided recording UI, transcript automation, Generate gating, Chatterbox and F5 are unchanged. `research.html` lists all four adapters (WASM baseline, hybrid, Chatterbox, F5) for the regression tools.
- Ported from the hybrid branch: adapter, worker, `compare_logmel.py`, hybrid cases in `cases.json`/`listening.json`, fault-injection flags in `run_cases.mjs`, `.gitignore` entry for `playground/hybrid-runtime/`. `app.js` was integrated by hand (select params, notice, fallback, routing).
- Provisioning (unchanged from the hybrid doc): `playground/hybrid-runtime/` (patched sherpa WASM) and `models/webgpu/decoder.dq.fp32.onnx` (478 MB) are git-ignored and were copied from the experiment checkout; a fresh clone cannot run the hybrid until they are provided (the page then falls back to WASM).

## Benchmark (`playground/bench_backends.mjs`, headless, muted)
Hardware/browser: MacBook Pro Apple M5 Pro, Chrome 156.0.8078.48 (headless, `--mute-audio`), ORT-web 1.30.0, sherpa-onnx 1.13.8, ZipVoice-Distill, **numSteps 4**, speed 1. Through the **public page**: one microphone recording per language (Chrome's fake capture device looping a macOS `say` WAV with a known transcript; en 8.69 s, zh 11.79 s, 48 kHz mono), reused for every run; same text in every run. Models were already in the HTTP cache (local server), so "load" excludes network time. Order: 3× WASM, 3× hybrid, WASM again, hybrid again (A-B-A) to expose order effects.

| English text (audio ≈ 8 s) | load | inference | audio | RTF | click→result | end-to-end RTF |
|---|---|---|---|---|---|---|
| WASM baseline, 3 runs + 1 later | 0.64 s | 28.9 / 29.0 / 29.1 / 29.3 s | 8.05 s | 3.59 – 3.64 | 29.0 – 29.9 s | 3.61 – 3.72 |
| **Hybrid WebGPU, first run** (incl. load) | 1.58 s | 2.04 s | 8.05 s | 0.25 | 3.62 s | 0.45 |
| **Hybrid WebGPU, warm** (2 runs) | – | 1.76 / 1.74 s | 7.85 / 8.05 s | 0.22 | 1.76 / 1.74 s | 0.22 |
| Hybrid again after a reload | 1.53 s | 2.00 s | 8.05 s | 0.25 | 3.53 s | 0.44 |

| Mandarin text (audio ≈ 10.6 s) | load | inference | audio | RTF | click→result | end-to-end RTF |
|---|---|---|---|---|---|---|
| WASM baseline (4 runs) | 0.67 s | 28.5 – 29.3 s | 10.5 – 10.6 s | 2.68 – 2.75 | 28.5 – 29.9 s | 2.68 – 2.81 |
| Hybrid first run | 1.61 s | 2.39 s | 10.63 s | 0.22 | 4.00 s | 0.38 |
| Hybrid warm | – | 2.03 – 2.04 s | 10.63 – 10.75 s | 0.19 | 2.0 s | 0.19 |

- The English WASM run reproduces the user's own measurement (RTF 3.64, 10.2 s reference, 31.0 s inference): the WASM cost grows with reference length (8.7–11.8 s here; the earlier regression used shorter synthetic references and measured RTF ≈ 2.0–2.4).
- **Speed-up, inference only: ≈ 16× (en) and ≈ 14× (zh)**; end-to-end including the first load ≈ 8× (en) / 7× (zh). Same model weights family; only the decoder precision/backend differs (INT8 WASM → dequantized FP32 on WebGPU).
- **Component timings (hybrid, warm, en):** prepare (front end + encoder + noise, WASM) ≈ 145 ms, decoder (4 Euler steps, WebGPU) ≈ 1200 ms, vocoder + silence scaling (WASM) ≈ 390 ms; the text is split into 2 chunks, values are summed over chunks. zh: 68 / 1415 / 548 ms. First run is slower (≈ +0.25 s in the decoder stage: shader / pipeline warm-up, the same signature as in `docs/playground_hybrid.md`).
- **Hybrid load breakdown (en, first):** sherpa instantiate 84 ms + init 548 ms + decoder fetch 130 ms (local cache) + WebGPU session 815 ms = 1.58 s.
- **WASM baseline has no component split:** sherpa returns one total; the only internal marker is the first chunk at ≈ 10.9 s (of 29 s, 2 chunks). The hybrid's `decoder` = `wasm` run (INT8 decoder inside the patched runtime) reports everything as one 29.6 s block, so the INT8 decoder's share of the WASM time is **not** separated here.
- Not measured: cold network download (decoder ≈ 478 MB + 204 MB bundle), memory, other GPUs/browsers, power. The headless runs share a machine with nothing else heavy but are single measurements per cell, no confidence intervals.

## Audio correctness (objective only)
- **ASR (whisper-small, intelligibility only):** English and Mandarin outputs from both backends are understandable and close to the target text. Small slips occur on both ("a server" → "iServer" on WASM run 1; "a text" → "iTex" on hybrid run 1; "server" → "our server" on hybrid runs with seeds; zh "测试"→"测是" once on hybrid). No backend is consistently worse on this sample; ASR cannot judge naturalness or speaker similarity.
- **Determinism:** same seed (1234) → identical audio on WebGPU twice (log-mel L1 0.000, en and zh).
- **Numerical closeness, same seed, same reference:** WebGPU FP32 decoder vs WASM INT8 decoder: log-mel L1 en 2.32, zh 1.01. Run-to-run spread of the WASM baseline with random noise: en 2.15, zh 3.79; WebGPU vs baseline: en 3.3–3.4, zh 2.5–3.7. So the precision change is within ordinary noise-seed variation for this crude metric (alignment-sensitive; says nothing about perception).
- Output durations differ a little between runs (7.85–8.05 s en) because the model samples noise; with a fixed seed they are identical.

## Regression (all headless, muted, 0 `play()` calls, nothing playing)
- `test_recording.mjs --gen`: **47/47** — UI contract (no upload/default voice, mic only on click, Generate gating, drag-drop ignored), permission denial and retry, short recording rejected, recording survives model switches, then record → generate with ZipVoice(hybrid tile) en + zh, Chatterbox, F5 en + zh with "Backend used" asserted, plus: Advanced "WASM CPU only" runs the baseline (no notice); no WebGPU → automatic WASM fallback **with notice**; decoder download blocked → fallback **with notice**. Whole run: GET/HEAD only, no request bodies (no microphone upload).
- `run_cases.mjs` on `research.html`: 14/14 for the four adapters (zipvoice 3, hybrid 7, chatterbox 1, f5 3 with ODE end time 1.0); the 15th case `hybrid-fallback-en` is a fault-injection case and fails by design without a flag (it correctly did **not** fall back); with `--no-gpu` and with `--block-decoder` it passes (ran the baseline, RTF ≈ 2.06 / 2.08). Interleaved model-switch run (zipvoice, hybrid, chatterbox, f5, hybrid, zipvoice, f5, chatterbox, hybrid): 9/9.
- F5 schedule unit tests: 35/35.

## Needs manual acceptance (not done)
1. **Listen**: hybrid (WebGPU FP32 decoder) vs WASM baseline from your own microphone recording: similarity to your voice, artifacts, English/Mandarin intelligibility. Files: `outputs/bench-hybrid/{en,zh}/*.wav` (synthetic `say` reference, not your voice; use the Playground with your own recording for the real check).
2. Normal (non-automated) Chrome with a real microphone: permission prompt, first-visit download time of the 478 MB decoder (cold network), whether the WebGPU path works on your Chrome profile without flags.
3. F5 English remains "listening verification pending".
