# Chatterbox load / lifecycle investigation

Trigger: real-user measurements, same 11.1 s microphone reference. 1st generation: load 43.81 s, inference 5.19 s, audio 2.68 s (RTF 1.94), click→result 51.05 s. 2nd generation: **load 47.93 s**, inference 8.56 s, audio 8.04 s (RTF 1.07), click→result 57.17 s.
Measured here: Apple M5 Pro (25.8 GB), Chrome 156.0.8078.48 headless, muted, through the public page with a fake microphone (looping a synthetic WAV). Not re-run in a human-driven normal Chrome.

## What was instrumented
`window.pg.state.lifecycle` and Advanced settings → "Lifecycle": every `new Worker` / `terminate()`, model `load` start/end/fail, unload/evict, generate start/end, per-stage worker diagnostics (incl. one `model:ok` per ONNX/WebGPU session construction), plus the model-asset bytes per click (Playwright `request.sizes()`), Chrome RSS, and (separately) physical footprint via `footprint`. Probe: `playground/test_lifecycle.mjs`; profile: `playground/profile_chatterbox.mjs`. Raw rows: `outputs/lifecycle-{before,after}-fix/`, `outputs/chatterbox-profile.json` (git-ignored).

## Findings
1. **No reload on A / B in the code.** Same model twice and new text: 0 workers created, 0 `load` calls, 0 sessions created, 0 asset bytes; click→result = inference time only (4.9 s for the 110-char text).
2. **The 40–50 s is session initialisation, not network and not cache.** Phases of one load (warm HTTP cache): all weight files fetched within ≈ 2 s (a raw `fetch` of the four 62–591 MB `.onnx_data` files takes 0.02–0.18 s each); the remaining ≈ 36–38 s is ONNX Runtime / Transformers.js creating the four WebGPU sessions. It is the same ≈ 37–39 s after a page refresh with zero network bytes (D1), after `graphOptimizationLevel` `disabled` / `basic` (no change: 38.3 / 37.2 s vs 37.9 s), and in every earlier regression (`loadInfo` 38996 ms in the final regression, never noticed because tests only looked at inference). First load on this machine moved 1527 MB; later loads ≈ 0.5 MB.
3. **Switching away and back DID reload (before the fix):** C2 = 37.19 s load, click→result 42.49 s; page refresh (D1) = 38.5 s / 43.81 s. This matches the user's 43.81 s → 47.93 s pattern (two initialisations) and is the likely cause: the code unloaded the previous model on every tile switch, and a page refresh or a visit to another tile before the second Generate re-initialises Chatterbox. I could **not** reproduce a reload without a switch/refresh/error in 10 scenario runs; if it happens again the Lifecycle table shows the exact `worker:create`, `unload`/`evict`, `load:start` sequence.
4. **The "Model load" metric was misleading.** It printed the *first* load time next to every later generation. It now says either `already loaded (initial load X s, not repeated)` or `waited X s for the model (this click | already loading in the background; total initial load Y s)`; `lastRun` also carries `modelReused`, `loadThisClickMs`, `preloadedInBackground`.
5. **Robustness bug found and fixed:** after a failed generation the model stayed marked "loaded" (possibly with a dead worker). It is now released with a visible message and re-initialises on the next click.

## Changes (public + research page share `app.js`)
- **Residency policy:** instead of unloading on every switch, keep up to `MAX_RESIDENT` models loaded (default 2; 1 if `navigator.deviceMemory < 8`; `?resident=N`). When over budget, evict the model that is cheapest to reload (measured load time), so Chatterbox (≈ 38 s) is evicted last; ZipVoice / F5 (≈ 1–2 s warm) first.
- **Background preload (public page):** 1.5 s after a tile is selected, if all of its files are local (no network needed) and nothing else is busy, the model is initialised in the background while the user records the script; Generate then only waits for what is left. `?preload=0` disables it; not used on `research.html`. Concurrent requests share one in-flight load (never a second one).
- Model adapters and workers are unchanged except that the Chatterbox adapter forwards worker diagnostics (`onDiag`). (A temporary `graphOptimizationLevel` experiment hook was removed after it showed no effect.)

### Memory (physical footprint incl. GPU, `footprint`, idle page 0.49 GB)
| Resident | Footprint |
|---|---|
| + Chatterbox | 2.5 GB (+2.0) |
| + Hybrid ZipVoice | 5.3 GB (+2.7) |
| + F5 | 8.2 GB (+2.9) |
| after terminating Chatterbox / Hybrid / F5 | 6.1 / 2.7 / 0.5 GB (terminate frees memory) |
Keeping all three would use ≈ 8.2 GB (fits a 25.8 GB Mac, not a small one), hence the cap of 2 (≈ 4.7–5.2 GB) and cost-based eviction. RSS (`ps`) was not used: it is unreliable here (compression) and excludes GPU memory.

## Before / after, click → result (same page, same 5 s reference, 110-char text unless noted)
| Scenario | Before (unload on switch) | After |
|---|---|---|
| A1 first Generate on Chatterbox (no preload time available) | 43.98 s (load 38.4) | 42.3 s (load 37.5) |
| A2 same text again | 4.93 s | 4.43 s |
| B new text (21 / 121 / 228 chars) | 1.72 / 4.99 / 6.98 s | 1.70 / 4.69 / 6.94 s |
| C1 switch to Hybrid ZipVoice | 3.46 s (incl. 1.73 s load) | 1.71 s (kept resident) |
| **C2 switch back to Chatterbox** | **42.49 s** (reloaded, 37.2 s) | **4.44 s** (no load) |
| D1 after page refresh | 43.81 s | 41.71 s (cold init is intrinsic) |
| **E select Chatterbox, then record ~8 s, then Generate** | 42.67 s (preload off) | **36.32 s** (30.7 s wait; 6–7 s hidden by the 8 s recording) |
Preload hides at most the time the user spends on step 2/3: a real user who takes ≥ 40 s to read the script and type would see ≈ 0 s wait. A first load is still ≈ 37 s on this hardware; no setting found reduces it.
Recording is not harmed by the background load: E recorded 7.99 s, peak 0.785, −16.1 dBFS, identical to the runs without preload.

## Warm inference profile (Chatterbox, load excluded, `outputs/chatterbox-profile.json`)
Warm inference = fixed cost that grows with **reference length** + ≈ 0.54 s per second of generated audio:
| Reference | 12 ch (≈ 1 s audio) | 21 ch (≈ 1.6 s) | 57 ch (≈ 3.2 s) | 110 ch (≈ 6.6 s) | 228 ch (≈ 10.3 s) |
|---|---|---|---|---|---|
| 3.2 s (two runs) | 1.06 / 1.44 s | 1.31 / 1.69 | 2.04 / 2.58 | 3.74 / 4.42 | 6.12 / 6.92 |
| 5.0 s | 2.24 | 2.33 | 3.06 | 5.23 | 7.29 |
| 11.0 s | 2.61 | 2.98 | 3.42 | 5.60 | 7.70 |
- Fixed cost ≈ 0.5 s (3 s reference) → ≈ 2.2 s (11 s reference): the reference's speech tokens sit in the LM prefix. Short sentences therefore have high RTF (1.0–3.1) while long ones converge to ≈ 0.55–0.75 (RTF < 1 from ≈ 3 s of output with a 3–5 s reference; from ≈ 4–6 s with an 11 s reference).
- Reference encoding on a new recording costs only 0.23–0.28 s (not the bottleneck).
- This explains the user's RTF 1.94 on 2.68 s of audio (11.1 s reference, first generation also includes WebGPU pipeline warm-up) and 1.07 on 8 s. Their absolute times are ≈ 1.3× ours (headed Chrome vs headless; not investigated).
- Run-to-run spread is ≈ ±15 % (the 3.2 s reference row was measured twice). Recommendation to evaluate by ear: a 5–6 s reference (the script takes about 10 s to read; Chatterbox does not need all of it). **Not evaluated: whether a shorter reference changes voice similarity**; only latency was measured.

## Regression after the change (headless, muted, 0 `play()`)
Unit 35/35; asset check READY ×4; `test_recording.mjs --gen` 51/51 (49 prior checks + 2 lifecycle checks: same-model reuse and switch-away/back keeps Chatterbox resident); `run_cases.mjs` research page 14/14; interleaved 9/9; no-GPU / blocked-decoder fallback pass; strict offline 5/5 (details in the commit message / `outputs/final2`).

## Limits
Not measured in a human-driven normal Chrome; the user's 47.93 s second load was not reproduced without a switch or refresh; first-load time is intrinsic to ORT/WebGPU session creation here (cause inside Transformers.js/ORT not isolated further); eviction cost uses this session's measured loads (a model never loaded counts as free); memory figures are for this Mac only.
