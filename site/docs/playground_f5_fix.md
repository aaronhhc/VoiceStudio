# F5-TTS sampling-schedule fix in the playground

Branch `experiment/unified-playground`. Source: `experiment/f5-browser` commit `199e358` ("fix noisy audio for NFE < 32 (baked schedule was truncated)"),
inspected via `git show` and **selectively ported**; the F5 branch and its worktree were not modified and nothing was merged.

## The bug and the fix (from the source commit's evidence)
The exported F5 transformer has the sway-sampling Euler schedule **baked in**: the `time_step` input indexes a 32-entry time-embedding table and a 31-entry `dt` table (Σdt = 1).
The old loop ran `NFE−1` consecutive indices, so **NFE 16 integrated only to t = 0.275** and stopped, leaving a noise-dominated mel (std 1.05 vs 2.8). fp16 vs fp32 was not the cause.
Whisper ASR cannot see it (the noisy audio is "intelligible"), which is why my earlier ASR-based F5 English checks passed while you heard noise.
`eulerPlan` now selects `NFE−1` of the 32 baked time points and rescales each returned update by (interval dt) / (baked dt), so every NFE **ends at t = 1**; NFE 32 is the unmodified baked schedule.
It is a *subset-of-grid Euler approximation*, not F5's own N-step grid (the export cannot produce time embeddings for other t).

## What was ported and what was not
| Ported | Where |
|---|---|
| `schedule.js` (byte-identical, sha256 `106265ed…`) | `playground/workers/f5-schedule.js` |
| `generate()` changes: `eulerPlan` loop, `melStats` (mean/std/min/max, `tEnd`, steps, schedule), diagnostic `schedule` / `noiseOverride` / `returnMel` parameters | `playground/workers/f5.worker.js` (applied as a patch on the playground copy) |
| 35 schedule unit tests (only the import path changed) | `playground/test_f5_schedule.mjs` |
| Browser regression cases + checks + negative control | `playground/f5_regression.json` + F5 checks in `playground/run_cases.mjs` |
| NFE range 2–32 | adapter validation + input `min/max` |
| **Not ported (by design)** | `f5/diag/*` native-CPU analysis scripts, `docs/data/*`, the F5 page's diagnostic hooks (`window.noiseOverride`, `wantMel`), the source's own `app.js`/`index.html`/`run.mjs` |
`f5.worker.js` keeps the playground's earlier `vocab.txt`-through-cache change. The unified model interface (`load / generate / unload`) is unchanged.

## Playground behaviour
- Default NFE **16** (the efficient preset); preset buttons **12 · faster**, **16 · efficient (default)**, **32 · full grid, for comparison**; any integer 2–32 is accepted, anything else is rejected with an error (no silent clamping).
- A note under the parameters explains that NFE < 32 uses a subset of the exported 31-step grid and that it approximates, not equals, F5's own N-step schedule.
- Each F5 result shows **"ODE end time (must be 1.000) after N Euler steps"** (from `melStats`).
- The original truncated schedule exists **for diagnostics only**: `?diag=f5-truncate` in the URL (not shown in the UI). The regression uses it as a negative control.
- Status label: **"fix integrated — listening verification pending"** on the F5 tile, on English text and on every F5 result, plus a separate amber *"code-switching quality unverified"* warning. The old red "known audio-quality failure" label is gone; the pending label is to be removed only after your new listening test.
- The earlier auto rule "24 steps for Chinese" was a workaround for the bug and is gone (default 16 for every language).

## Regression results (headless Chrome 156.0.8078.48 + `--mute-audio`, Apple M5 Pro, WebGPU fp16; UI-driven; 0 `play()` calls; raw rows `outputs/f5fix-regression/summary.json`, untracked)
1. **Schedule unit tests: 35/35 pass** (`node --test playground/test_f5_schedule.mjs`; every NFE 2…32 reaches t = 1).
2. **F5 browser regression: 48/48 pass, F5 checks active.** Checks per case: ODE end `t ≥ 0.999`, Euler steps = NFE−1, generated-mel std in (2, 4), finite audio with peak < 1.5, noise floor (p5−p95 frame dB) < −30 dB, plausible duration.
   - 7 texts (en short/medium/long, zh short/medium/long, zh+en code-switch) × NFE 12 and 16, plus en/zh medium at NFE 32: all pass; mel std 2.46–3.65, noise floor ≤ −53 dB, peak ≤ 1.00.
   - **NFE sweep 2…32 (31 browser runs): `tEnd` = 1.0000 and steps = NFE−1 for every NFE.** (Only the three listed checks are asserted for the sweep; quality at very low NFE is not claimed.)
   - **Negative control** (`?diag=f5-truncate`, NFE 16): `tEnd` 0.2752, mel std 1.05, floor span −12.2 dB → **detected** (fails `tEnd`, `melStd`, `floor`), same numbers as the source commit.
   - ASR (whisper-small, intelligibility only) of the 16 main cells: correct for all English and Mandarin cells; code-switch brand words vary ("Starbox"/"Starbucks", "Meting"/"meeting").
   - *An earlier run of this regression reported 48/48 but the F5 checks had silently not executed (a text replacement missed its insertion point); it was discarded (`outputs/f5fix-regression-INVALID-checks-did-not-run/`) and re-run with the check insertion asserted.*
3. **Three-model interleaved regression** (zipvoice, chatterbox, f5 in one page): 8/8 pass; F5 cells `nfe 16 stride tEnd 1`, mel std 2.9–3.2.
4. **ZipVoice Hybrid WebGPU + fallback** are on `experiment/playground-hybrid`, not in this branch. I verified the *combination* in a scratch worktree (merge of this commit into the hybrid branch; local branch `experiment/playground-hybrid-f5fix-check`, merge commit `9ee616d`, unpushed):
   it merged with conflicts in `app.js`, `run_cases.mjs`, `cases.json`, `listening.json` (all additive, resolved by combining); 35/35 unit tests; **12/12** interleaved cells across zipvoice (WASM), hybrid, chatterbox and f5 (hybrid RTF 0.16–0.22, F5 `tEnd 1`); fallback **PASS** for both *no WebGPU* and *blocked decoder download* (ran the WASM baseline, notice shown). `experiment/playground-hybrid` itself was not modified.

5. **Normally launched Chrome 156.0.8078.48** (real headed instance via `open -g`, fresh profile, only `--mute-audio` and a debugging port; no automation flags, no `--enable-unsafe-webgpu`; apple/metal-3): en-medium NFE 12 and 16, en-long NFE 16, zh-medium NFE 16 and the negative control — all **PASS** with the F5 checks active (`tEnd` 1, mel std 2.83–2.98; control tEnd 0.2752, std 1.09, detected); 0 console errors, 0 `play()` calls.
6. **Listening set 3** (`outputs/listening/20261022-set3/index.html`, 25 cells, post-fix): all 25 generated and transcribed correctly by ASR; every F5 cell reports `tEnd = 1.000`. **4 of the 16 F5 cells are flagged by the objective mel-std check**: the "excited" sentence with the default-voice reference at NFE 12/16/32 (mel std 4.24 / 4.48 / 4.51 and 4.15 at default NFE 16, i.e. *above* the 4.0 upper bound; noise floor −109 dB; ODE finished; clipping ≤ 0.034 % of samples). That is the opposite of the old bug (truncation gives std ≈ 1) and it also happens at NFE 32, so it is not the schedule; my reading is that the 2–4 bound, calibrated on the synthetic `say` references, is too narrow for this reference voice. I did **not** widen the check to make it pass; the listening page shows the flag on those cells. **Please listen to them.**
   Listening sets 1 and 2 predate the fix: set 1's page now marks its 5 F5 cells "PRE-FIX CELL … INVALID"; set 2 (in the hybrid worktree) was not regenerated, so ignore its F5 cells.

### F5 timing (single runs, one machine, not a benchmark; RTF = inference time / audio time; not streaming)
| text | audio s | NFE 12 s / RTF | NFE 16 s / RTF | NFE 32 s / RTF |
|---|---|---|---|---|
| en-short | 1.22 | 2.27 / 1.86 | 2.83 / 2.33 | — |
| en-medium | 4.45 | 3.40 / 0.76 | 4.34 / 0.97 | 8.85 / 1.99 |
| en-long | 9.09 | 5.70 / 0.63 | 7.38 / 0.81 | — |
| zh-short | 2.25 | 2.48 / 1.10 | 3.47 / 1.54 | — |
| zh-medium | 5.21 | 3.84 / 0.74 | 5.44 / 1.04 | 10.89 / 2.09 |
| zh-long | 14.08 | 8.26 / 0.59 | 11.81 / 0.84 | — |
| codeswitch | 4.91 | 3.85 / 0.78 | 5.20 / 1.06 | — |
Consequence: the earlier "F5 English RTF 0.91–0.98 at 16 steps" described runs that never completed the ODE. A real 16-step solve is about 1.0 for medium text and above 1 for short text (the fixed reference cost dominates short outputs); NFE 12 is about 0.75 for medium and long text.

## Corrections to my earlier claims
All F5 results at NFE < 32 in `docs/playground.md`, listening sets 1 and 2 and the normal-Chrome table predate the fix: those WAVs are invalid for judging F5, and "Mandarin needs ≥ 24 steps (16 fails)" was the bug, not a model property.

## Unresolved
- **Listening acceptance in the playground is still yours to do** (files below). Your earlier acceptance was on the F5 branch's English files at NFE 12/16/32.
- Mandarin and code-switch outputs have only objective checks + ASR; no human listening. English brand names inside Mandarin remain unreliable.
- `个` → token `ge` is missing from `vocab.txt` (id 0) as in the reference frontend; reported by the source commit, not fixed. Very short English (1.2 s) peaks at 1.00 in some runs (possible clipping), not investigated.
- Subset-of-grid Euler is an approximation of F5's own schedule; quality at NFE ≤ 8 is not claimed.
- The mel-std heuristic (2–4) flags the "excited" sentence with the default-voice reference (see item 6); either the bound needs recalibrating on more references or those outputs have a real problem. Only listening can decide.
- Same caveat as the source evidence: one text/speaker/seed mostly with synthetic references; no real-human reference tested.

## What to listen to for final acceptance (`http://127.0.0.1:8300/outputs/listening/20261022-set3/index.html`, Group 4 first; blind mode available)
1. **English, the case you accepted on the F5 branch:** `g4-en-f5-nfe12`, `g4-en-f5-nfe16`, `g4-en-f5-nfe32` (same text and reference as your earlier files, now produced by the playground).
2. **The flagged cells:** `g4-excited-f5-nfe12`, `…-nfe16`, `…-nfe32` and `g2-excited-f5` (default-voice reference, emphatic sentence).
3. **Mandarin:** `g4-zh-f5-nfe12`, `…-nfe16`, `…-nfe32`.
4. **Code-switching (expected to be imperfect):** `g4-mix-f5-nfe16`, `g4-mix-f5-nfe32`.
5. Also try the live page: http://127.0.0.1:8300/playground/ → F5-TTS → type new text → presets 12 / 16 / 32 (playback only when you press play).
