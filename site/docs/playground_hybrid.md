# ZipVoice Hybrid WebGPU in the playground

Branch `experiment/playground-hybrid` (from `experiment/unified-playground`; **nothing merged**, `main` untouched). The hybrid implementation from
`experiment/webgpu-feasibility` was *inspected and selectively copied*, not merged. The WASM baseline is unchanged and remains the automatic fallback.

## What the hybrid is (inspection)
| Piece | Detail |
|---|---|
| Runtime | patched sherpa-onnx v1.13.8 WASM (`experiments/webgpu/sherpa-onnx-zipvoice-split.patch`, 521 lines) exporting `ZipvoicePrepare / ZipvoiceVocode / ScaleSilence / SetSeed`. Built artifacts are git-ignored: `sherpa-onnx-wasm-main-tts.{js,wasm}`, `sherpa-onnx-tts.js` (13 MB). Build: `experiments/webgpu/build_sherpa.sh` on that branch. |
| Model data | `sherpa-onnx-wasm-main-tts.data` (204 MB) — **byte-identical to the baseline's** (sha256 `0e2f08ed…`), so both backends share one download. |
| Decoder | `decoder.dq.fp32.onnx` (478 MB): the bundle's INT8 decoder with `MatMulInteger/DynamicQuantizeLinear` rewritten to dequantized FP32 MatMul (`experiments/webgpu/dequantize.py`), because ORT-web's WebGPU EP lacks kernels for those ops. Git-ignored. (An fp16 variant exists but is invalid.) |
| Execution | WASM: text frontend + encoder + noise; **WebGPU**: 4 Euler steps of the flow-matching decoder (onnxruntime-web 1.30.0); WASM: Vocos vocoder + silence scaling. Not streaming. |

## What was integrated
- `playground/workers/zipvoice-hybrid.worker.js` — copy of `experiments/webgpu/hybrid/worker.js` (2e89ca5) with these changes only: (1) `locateFile` serves the model `.data` from the **baseline** runtime path (shared download) and the patched JS/WASM from `playground/hybrid-runtime/`; (2) ORT-web 1.30.0 loaded from a pinned CDN URL instead of `node_modules`; (3) fails fast if there is no WebGPU adapter, **before** the 478 MB download; (4) the decoder is streamed with progress and a 60 s no-bytes stall abort; (5) errors are reported instead of silent; (6) the `verify` debug hook was dropped.
- `playground/adapters/zipvoice-hybrid.js` — adapter with the common contract plus `fallback: 'zipvoice'`, `preflight()`, and parameters Euler steps, speed, **seed** and **decoder** (`webgpu` | `wasm`; the `wasm` choice runs the original INT8 path inside the *same* patched runtime, which allows same-seed comparisons).
- `playground/app.js`: select-type parameters, a permanent **notice** when a fallback happens, and automatic fallback to the baseline on load *or* first-generation failure (the notice names the reason; the switch is never silent).
- `playground/run_cases.mjs`: per-case parameter reset (cases cannot leak settings into each other), `--no-gpu` / `--block-decoder` fault injection, `expectFallback`, ran-model assertion.

## Integration risks and how each was handled
| Risk | Status |
|---|---|
| Two sherpa runtimes (baseline + patched) in one app | Separate workers; only the selected one exists (switching terminates it). Shared `.data` file. **Verified**: 12-cell interleaved regression, no leaks between models. |
| WebGPU missing / decoder download fails / device lost | Pre-flight + automatic fallback with notice. **Verified** for no-WebGPU and for a blocked decoder download (below). Mid-generation device loss is only covered by the generic "first generation failed → fall back" path, **not tested**. |
| Large download (decoder 478 MB) | Progress + stall abort added. First visit ≈ 204 + 14 + 478 ≈ 700 MB; fallback adds only the baseline's 14 MB wasm. Cold download over the network **not timed** (local server only). |
| ORT version sprawl (1.22 / 1.25-dev / 1.30) | Isolated per worker; CDN-pinned. Costs cache space (not measured). |
| Provisioning: patched runtime and dequantized decoder are git-ignored | Documented here; artifacts are cloned from the experiment checkout. Rebuild path is on `experiment/webgpu-feasibility`. A fresh clone cannot run the hybrid until they are provided. |
| Numerical/perceptual difference (INT8 → FP32 decoder) | Measured numerically only (below); **perceptual quality not validated**. Hybrid cells added to the listening set. |
| Copied worker drifts from the experimental branch | Provenance header names the source commit; reconcile if/when that branch is merged (needs your approval). |
| Memory: 4 models in one tab session | Workers are terminated on switch. Peak process memory of the hybrid was ~3.9 GB RSS on the experiment branch; **not re-measured inside the playground**. |

## Evidence (headless, muted, UI-driven; Chrome 156.0.8078.48, Apple M5 Pro; raw rows in the git-ignored `outputs/hybrid-*/summary.json`)
**Four-model interleaved regression, one page, 12/12 pass** (zipvoice, hybrid, chatterbox, f5 in alternation; `outputs/hybrid-all`):
| Case | RTF |
|---|---|
| zipvoice en / zh / mix (WASM baseline) | 2.10 / 2.13 / 2.17 |
| **hybrid en / zh / mix (WebGPU)** | **0.15 / 0.15 / 0.17** (warm; first run after load up to 0.27–0.32 incl. shader warm-up) |
| chatterbox en | 0.98 (once, after a hybrid unload) / 0.62 |
| f5 en / zh / mix | 0.96 / 1.60 / 1.96 |
- ASR (whisper-small, intelligibility only): hybrid en and zh exact; mix right except English words ("Mitting", "Stabacus"), same kind of error as the baseline.
- **Same seed ⇒ identical output**: two WebGPU runs, seed 1234, log-mel distance 0.000 (bit-identical audio).
- **Speed-up vs the baseline on the same model**: warm RTF 0.13–0.15 vs 2.0–2.1 (≈ 14×), decoder-only change; output audio durations match (4.76 s vs 4.74–4.81 s).
- **Numerical closeness, WebGPU FP32 decoder vs WASM INT8 decoder, same seed** (mean |Δ log-mel|, English sentence): seed 2: 0.48; seed 1234: 1.50. **Seed-to-seed spread** (different seeds, same text): ≈ 2.8. So the decoder precision change is 1.9–5.9× smaller than ordinary seed variation. This metric is crude and alignment-sensitive and **says nothing about perception**.
- **Fault injection → automatic fallback** (both PASS, ran the baseline, ASR equal, notice shown):
  - no WebGPU (`navigator.gpu` hidden): notice "…failed (WebGPU unavailable (navigator.gpu missing)) — switched to ZipVoice-Distill (INT8)."; RTF 2.26.
  - decoder download blocked: notice "…failed (Hybrid initialization failed: TypeError: Failed to fetch) — switched to …"; RTF 2.24.
- **Cross-model interference check**: hybrid ⇄ Chatterbox alternated 3×: Chatterbox RTF 0.64 / 0.63 / 0.64 after each hybrid unload — the one 0.98 seen earlier did not reproduce.
- **Normally launched Chrome 156.0.8078.48** (real headed instance via `open -g`, fresh profile, only `--mute-audio` and a debugging port; no automation flags and no `--enable-unsafe-webgpu`; same apple/metal-3 adapter): hybrid en / zh / mix **PASS**, RTF 0.24 (first) / 0.15 / 0.19, baseline zipvoice-en 2.07, 0 console errors, 0 `play()` calls (`outputs/hybrid-normal-chrome`).
- **Second listening set**: `outputs/listening/20261022-set2/index.html` (19 cells = set 1 + 5 hybrid cells with seed 1234; all pass; F5 English cells carry the known-failure flag).
- Safety in all runs: 0 `play()` calls, nothing playing, headless + `--mute-audio`.

## Not done / still open
1. ~~Normal Chrome~~ **Done** for the hybrid (below). A human in their own profile, and headed Chrome with audible output, were not exercised.
2. Perceptual quality of FP32-WebGPU vs INT8-WASM decoder: listening set `outputs/listening/…-set2` has hybrid cells (seed 1234) next to the baseline; nobody has listened.
3. Cold network download time, memory footprint with the playground, mid-run GPU loss, behaviour on other GPUs/browsers.
4. A fresh-clone provisioning script for `playground/hybrid-runtime/` and the decoder (currently copied from the experiment checkout).
5. Whether the baseline *should* default to the hybrid when WebGPU exists (not changed: both are separate selectable models; the baseline stays the default and the fallback).
