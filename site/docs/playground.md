# Unified on-device TTS playground

Branch `experiment/unified-playground` (based on `main`; **not merged**). One page, three models, all inference in the browser.

```
python3 playground/serve.py 8300          # static file server for the repo root; serves files only
open http://127.0.0.1:8300/playground/    # Chrome; WebGPU is required for Chatterbox and F5
```
Needs git-ignored assets: `web/runtime/` (`scripts/fetch-runtime.sh`), optionally `models/chatterbox/` (`playground/tools/fetch_chatterbox_models.sh`,
else Chatterbox pulls weights from the Hugging Face Hub), and reference clips (`benchmarks/make_refs.sh` or your own).

## What it is
| Model | Backend | Languages | Reference needs | Size |
|---|---|---|---|---|
| ZipVoice-Distill INT8 | WASM, CPU, 1 thread (sherpa-onnx) | zh, en, zh+en | audio + exact transcript | ~208 MB |
| Chatterbox (q4f16 LM) | WebGPU, Transformers.js / ORT-web | en only | audio only (or the repo's default voice) | ~1.5 GB |
| F5-TTS (fp16) | WebGPU, ORT-web | zh, en, zh+en (mixing partial) | audio + exact transcript (same language as the clip) | ~790 MB |

- The selected model **loads lazily** (first Generate, or the Load button); selecting another model **terminates the previous worker** so its memory is released.
- The UI shows loading status/progress, errors, generated duration, inference time, RTF, click-to-result time, per-model parameters and a language warning
  (e.g. Chatterbox with Chinese text).
- **Playback needs a user click.** The page never calls `play()`; results appear in `<audio controls preload="none">`.

## Architecture
`playground/app.js` (UI, no framework) talks to adapters in `playground/adapters/` with one contract: `load / generate / unload`.
Each adapter owns a Web Worker:

| Adapter | Worker | Origin |
|---|---|---|
| `zipvoice.js` | `web/worker.js` | baseline from `main`, **unchanged** |
| `chatterbox.js` | `workers/chatterbox.worker.js` | copy of `chatterbox/worker.js` from `experiment/chatterbox-browser` (the file has not changed since its first commit on that branch) |
| `f5.js` | `workers/f5.worker.js` + `workers/f5-schedule.js` | copy of `f5/worker.js` from `experiment/f5-browser`, plus (1) `vocab.txt` goes through the same cache as the weights, and (2) the **sampling-schedule fix** ported from commit `199e358` (`f5-schedule.js` is a byte-identical copy of that commit's `f5/schedule.js`; see `docs/playground_f5_fix.md`) |

The two copied workers must be reconciled if/when those branches are merged. The directory is `adapters/`, not `models/`, because the repo-wide `models/` ignore rule would hide it.
The ZipVoice **hybrid WebGPU** branch is untouched and not integrated.

## Audio safety (tests must be silent)
Root cause of the earlier unexpected speaker output: `web/app.js` called `out.play()` after every generation, the ZipVoice benchmark drivers passed
`--autoplay-policy=no-user-gesture-required`, and several drivers opened visible windows. Fixes (separate commits, see git log):
- `web/app.js`, Chatterbox and F5 pages: no autoplay. Benchmarks use `--mute-audio` (`memory.mjs` stays headed because it samples process RSS, but muted).
- **Headless Chrome 156 does expose WebGPU here** (Apple, metal-3, shader-f16), so UI regression tests use no window at all.
- `playground/run_cases.mjs` runs headless with `--mute-audio`, traps `HTMLMediaElement.prototype.play` (any call fails the run) and requires every `<audio>` to be paused at the end.
- **Not changed:** the hybrid branch (`experiment/webgpu-feasibility`) still autoplays and launches headed Chrome, as requested.
- WAVs are saved to `outputs/` (git-ignored) for manual listening.

## Model readiness (read this first)
- **No model is labelled demo-ready**: that requires a human to listen and accept, which has not happened. All three have *automated inference verification* only.
- **F5-TTS English: fix integrated — listening verification pending.** The earlier audio-quality failure (user-reported; invisible to ASR) was a truncated sampling schedule: at NFE < 32 the ODE stopped before t = 1 (NFE 16 → t = 0.275). The fix from `experiment/f5-browser` `199e358` is integrated and its objective checks pass (`docs/playground_f5_fix.md`), but the UI keeps an amber "fix integrated — listening verification pending" label until you have listened to the playground output. **English WAVs generated before the fix are invalid.**
- F5 Mandarin and zh+en: automated checks only (ODE reaches t = 1, mel/noise-floor checks, ASR); listening acceptance pending; English words inside Mandarin are unreliable. ZipVoice and Chatterbox: inference verified, listening acceptance pending.

## Regression evidence (headless, muted, UI-driven, one page switching models; Chrome 156.0.8078.48, Apple M5 Pro, macOS 27.0.1)
> **Correction (F5 schedule bug).** Every F5 number in this section and in the normal-Chrome table below was produced **before** the schedule fix. At NFE < 32 those runs did not complete the ODE (so "RTF 0.91 at 16 steps", "Mandarin needs ≥ 24 steps" and the F5 cells of listening sets 1 and 2 are artifacts of the bug and are superseded). Post-fix results: `docs/playground_f5_fix.md`.

Order: zipvoice-en, chatterbox-en, f5-en, zipvoice-zh, f5-zh, chatterbox-en, f5-mix, zipvoice-mix. References: synthetic macOS `say` voices.
| Case | audio s | inference s | RTF | ASR (whisper-small) |
|---|---|---|---|---|
| zipvoice en | 4.82 | 9.85 | 2.04 | exact |
| chatterbox en | 6.00 | 3.79 | 0.63 | exact |
| f5 en (16 steps) | 5.13 | 4.67 | 0.91 | exact |
| zipvoice zh | 5.09 | 10.93 | 2.15 | exact (traditional chars) |
| f5 zh (24 steps) | 5.21 | 8.01 | 1.54 | exact |
| chatterbox en, after reload | 6.00 | 3.75 | 0.63 | exact |
| f5 zh+en (32 steps) | 5.89 | 13.06 | 2.22 | "Starbox", "密挺" (English words wrong) |
| zipvoice zh+en | 5.44 | 12.93 | 2.38 | English words right in this run |
All 8 passed; play() calls = 0; no audio playing. Network: localhost, jsDelivr, Hugging Face (F5 weights on first load). Raw rows: `outputs/regression-all/summary.json` (untracked).
Earlier single-model runs agree (zipvoice RTF 2.0–2.3 as in the baseline docs, chatterbox 0.61–0.64, f5 en 0.98 on first load including shader compile).

## A/B listening set
`playground/make_listening_set.sh [--out DIR] [--human-ref FILE --human-text "exact transcript" --human-lang en|zh]` drives the playground UI (muted),
runs ASR, and writes `outputs/listening/<id>/` with WAVs, reference copies, `manifest.json` and a self-contained `index.html` (blind A/B mode, 1–5 rating
fields stored only in the browser, export to JSON). Nothing autoplays.
- **Group 1 – synthetic references** (macOS `say`: Samantha, Tingting): en × 3 models, zh × {ZipVoice, F5}, zh+en × {ZipVoice, F5}.
- **Group 2 – the Chatterbox repo's `default_voice.wav`** (7.4 s, provenance undocumented; labelled default/synthetic; its transcript is **machine-derived**) with all three models, plus an
  "excited" sentence (Chatterbox at exaggeration 0.5 and 1.0). Same reference for all models so the comparison is fair.
- **Group 3 – REAL-HUMAN reference: not run.** It needs a recording and its exact transcript from you; the script adds the group when given them.
- Each card records reference source, text, language, parameters, model revisions, runtime, inference time and RTF (`manifest.json`). Sampling: ZipVoice and F5 noise is not seeded, so
  one cell is one random sample. Model revisions: Chatterbox `onnx-community/chatterbox-ONNX@3cab09af`, F5 `nsarang/F5-TTS-ONNX@2e7e47e1`, ZipVoice = k2-fsa HF Space `@a118980a` bundle.
- Built set: `outputs/listening/20261022-set1/` (14 cells, 0 failed). ASR there measures **intelligibility only**.
- **Nothing about naturalness, expressiveness or zero-shot speaker similarity is validated by this set.** It exists so a human can judge.

## Outstanding quality / engineering issues
1. No human listening yet; no real-human reference test; no objective speaker-similarity measurement.
2. RTF < 1 for Chatterbox (0.63) and, after the F5 fix, F5 at NFE 12/16 only for medium and long texts (0.6–1.0; short texts are above 1). ZipVoice (WASM) 2.0–2.4; F5 at NFE 32 about 2.0.
   **RTF depends on reference length** (ZipVoice with the 7.4 s default voice: RTF 3.0–5.4; F5: 1.3–1.5), so RTFs across different references are not comparable. None of this is streaming.
3. Code-switching English words are unreliable in every model that supports it, and vary run to run.
4. Chatterbox is English-only and has no text chunking (≈ one or two sentences per generation, `max_new_tokens`). Exaggeration 0.5 vs 1.0 changed RMS (0.14 vs 0.17) but not the duration of the "excited" sample; its perceptual effect is unvalidated.
5. F5 weights are CC-BY-NC-derived (non-commercial) with undocumented provenance; the user must type the reference transcript. (The old "Mandarin needs ≥ 24 steps" claim was the schedule bug.)
6. Downloads: Chatterbox ~1.5 GB, F5 ~790 MB. A complete cold in-browser Chatterbox download from Hugging Face was not finished in any run (≈ 3 MB/s observed ⇒ ~8 min).
7. WebGPU is required for Chatterbox and F5; no WASM fallback was tested. Tested only in headless/muted Chrome 156 on one machine: **real audible playback in headed Chrome was not tested (by design)**.
8. Memory with several models, and whether terminating a worker really frees GPU memory, were not measured.
9. The ZipVoice WebGPU hybrid is not integrated; `web/` (baseline) differs from `main` only by the autoplay removal.

## Confirmed in a normally launched Chrome (not only automated headless)
`playground/run_cases.mjs --cdp http://127.0.0.1:9333` attaches to a Chrome started the ordinary way (`open -g -n -a "Google Chrome" --args --user-data-dir=/tmp/pg-normal-chrome --remote-debugging-port=9333 --mute-audio ...`):
real headed Chrome 156.0.8078.48, fresh profile, **no `--enable-unsafe-webgpu`, no automation flags**; Playwright only observes. The page saw the same WebGPU adapter (apple / metal-3, shader-f16).
Same 8 interleaved cells (zipvoice-en, chatterbox-en, f5-en, zipvoice-zh, f5-zh, chatterbox-en, f5-mix, zipvoice-mix): **8/8 pass**, 0 `play()` calls, nothing playing, 0 console errors.
| Case | RTF headless | RTF normal Chrome | ASR (normal Chrome) |
|---|---|---|---|
| zipvoice en / zh / mix | 2.04 / 2.15 / 2.38 | 2.10 / 2.85 / 2.23 | exact / exact / "Starbucks", "meeting" right |
| chatterbox en (x2) | 0.63 / 0.63 | 0.75 / 0.70 | exact |
| f5 en / zh / mix | 0.91 / 1.54 / 2.22 | 1.14 / 1.57 / 1.93 | exact / exact / "Starbucks", "meeting" right |
The normal-Chrome window was opened in the background (`open -g`) and muted; RTFs are 0–35 % slower than headless (one run each, unpooled; background-window throttling is a hypothesis, not tested).
This is still automated observation: **a human opening the page in their own Chrome profile has not been recorded**, and a headed Chrome with real audio output was not exercised (by design).
Raw rows: `outputs/regression-normal-chrome/summary.json` and `outputs/regression-all/summary.json` (git-ignored).

## Keeping the page available for manual testing
`python3 playground/serve.py 8300` from this worktree serves http://127.0.0.1:8300/playground/ (files only). Work on new integrations happens in other worktrees/branches
(e.g. `experiment/playground-hybrid`, served on another port) so this copy stays stable. Local snapshot tags (not pushed): `snapshot/playground-3models-20261022`, `snapshot/chatterbox-working-20261022`, `snapshot/f5-working-20261022`.
