# Chatterbox fast load (integrated into the four-scene Voice Studio)

Branch `integration/chatterbox-fastload` (from `feature/ux-redesign` 910f013), worktree `~/Develop/_worktrees/on-device-web-tts/chatterbox-integration`, preview `python3 playground/serve.py 8360` → http://127.0.0.1:8360/playground/. Not pushed, not merged.
Origin: experiment `experiment/chatterbox-ort` e5d9b7f (its full write-up: `docs/chatterbox_ort.md` on that branch); root-cause investigation: `diag/chatterbox-coldstart` ae20de6.

## 1. Problem and root cause (summary)
- Chatterbox took ~37–39 s to become ready on every cold start (page load, reload, new tab) on an Apple M5 Pro, even with all files local and cached. 35–37 s of it is one ONNX session: `conditional_decoder` (23,934 nodes).
- ONNX Runtime spends that time in memory-reuse planning: `SequentialPlanner::CreatePlan → PlannerImpl::ComputeSingleStreamReusePlan`, 94 % inside `PlannerImpl::FindReusableTensor`, which scans the whole free list of dead buffers for every value and re-parses type strings (native stack sampling; same in WASM). Not graph optimisation, EP init, GPU upload or shader compilation.
- ONNX Runtime has the switch (`SessionOptions::enable_mem_reuse`) but onnxruntime-web cannot reach it.

## 2. What is integrated
| Piece | Where | Notes |
|---|---|---|
| 10-line ONNX Runtime patch: config key `session.disable_mem_reuse` = "1" → `enable_mem_reuse = false` for that session | `experiments/chatterbox-ort/ort-session-disable-mem-reuse.patch` | byte-identical to the validated experiment patch; default "0" leaves ORT unchanged |
| Reproducible build of the WASM runtime | `experiments/chatterbox-ort/build_ort_web.sh` → `playground/ort-patched/` (git-ignored) | ORT a3749f13 (= the onnxruntime-web 1.25.0-dev.20260209-a3749f1353 that Transformers.js 4.0.0-next.2 imports), emsdk 4.0.23, CMake 3.31.6, official "simd + threads + WebGPU" CI flags |
| Runtime selection + decoder-only key | `playground/workers/chatterbox.worker.js` (`configureRuntime`), `playground/adapters/chatterbox.js` (`load`/`_load`) | see §3 |
| Diagnostics | Advanced → Last generation: "ONNX Runtime (Chatterbox)"; `pg.state.loadInfo.chatterbox.runtime` = {requested, ort, version, buildCommit, wasm, sessionsWithReuseOff, fallbackReason}; `?cbdiag=1` per-session timing | |
| Model-specific Advanced settings | `app.js`, `index.html` (`#backendRow`) | "ZipVoice backend" selector only for ZipVoice (from the diagnostic branch) |
| F5 preload robustness | `playground/workers/f5.worker.js` (`fetchCached`) | see §6 — a pre-existing bug found while integrating |
| Tests and benchmarks | `test_cb_runtime.mjs`, `cb_ort_ab.mjs`, `cb_ort_repeat.mjs`, `cb_session_bench.mjs` + `diag/cb_session.*`, `tools/summarize_cb_ab.py`, `test_wait.mjs --q/--only/--fresh`, `test_ux.mjs` (+3 checks) | |
Not ported from the experiment: its older scene UI/tests, `memreuse=` URL switch (the key is now always applied with the patched runtime — that is the validated configuration), experiment-only probes (`cb_coldstart.mjs`, `cb_trace.mjs`, native/trace tools stay on the diagnostic branch).

## 3. Runtime selection (developer option; not in the user interface)
- `?ort=auto` (default): use the patched runtime if `playground/ort-patched/BUILD-INFO.txt` exists, names the same ORT commit as the onnxruntime-web version Transformers.js imports, and both `.wasm`/`.mjs` exist. If any of that fails, **or** the patched WASM fails to initialise, the adapter terminates that worker and loads again in a fresh worker with the stock runtime, recording `fallbackReason` (shown in Advanced as "stock (fallback: …)").
- `?ort=patched`: strict; missing/mismatched/broken artefacts → a clear load error. Never labels a stock run as patched.
- `?ort=stock`: the original runtime (rollback).
- Selection happens inside the worker before the first `InferenceSession.create` (onnxruntime-web loads its WASM lazily at that point), so only one ORT WASM is ever fetched per worker — verified by request logs: patched → only `/playground/ort-patched/…wasm`; stock → only the vendored stock wasm.
- The key is added only when a session's external data is `conditional_decoder.onnx_data`; `embed_tokens`, `speech_encoder` and the language model keep ORT defaults. ZipVoice (sherpa + ORT 1.30) and F5 (ORT 1.22) use their own runtimes and are not touched.

## 4. Integrated Chrome benchmark (latest UX, port 8360)
Apple M5 Pro, Chrome 156.0.8078.48 headless (`--mute-audio --disable-audio-output`), nothing else GPU-heavy; real pipeline via `research.html` (same adapters/workers as the public page); reference `ref_en.wav`, text "Good morning everyone. Today we are testing a text to speech model that runs entirely inside your web browser.", default params. "Page reload" = cached assets, fresh sessions; "first visit" = empty browser profile against the local server (no Internet download).

| `?ort=` | Scenario | Model ready | conditional_decoder | other 3 sessions | 1st / warm inference | warm RTF | click→result (cold) | footprint (browser / GPU proc.) |
|---|---|---|---|---|---|---|---|---|
| stock | page reload, n=5 | **38.37 s** (37.40–39.12) | 36.73 s | 1.17 s | 3.82 / 3.67 s | 0.58 | **42.44 s** | 3181 / 2334 MB |
| patched | page reload, n=5 | **3.77 s** (3.63–3.98) | 2.23 s | 1.12 s | 3.84 / 3.75 s | 0.59 | **7.84 s** | 3278 / 2356 MB |
| auto | page reload, n=5 | **3.79 s** (3.71–4.04) | 2.32 s | 1.07 s | 3.86 / 3.73 s | 0.59 | 7.92 s | 3331 / 2384 MB |
| stock / patched / auto | first visit, n=1 | 38.86 / 5.09 / 5.16 s | 36.45 / 2.42 / 2.46 s | ≈1.1–1.2 s | ≈3.9 / 3.7 s | 0.58–0.60 | 43.0 / 9.4 / 9.5 s | ≈3.1–3.3 GB |
- Model ready **×10.2 faster** (38.37 → 3.77 s); warm inference and RTF unchanged within noise (0.58 → 0.59); footprint unchanged within run-to-run spread. Switching away and back: 0 ms load in every config. 0 console errors; all 42 generated WAVs pass NaN/clipping/silence/duration checks.
- **Perceived waiting in the four-scene UI** (`test_wait.mjs`, scripted user pace, one run each):
  | Scenario | stock: select→ready / extra wait at Generate / click→result | auto (patched): same |
  |---|---|---|
  | Chatterbox, fast user (generate ~8 s after choosing) | 38.9 s / **31.2 s** / 34.5 s | 5.0 s / **0 s** / 3.3 s |
  | Chatterbox, relaxed user (~28 s) | 38.7 s / 10.8 s / 15.1 s | 4.4 s / **0 s** / 4.6 s |
- **Repeat initialisation and release** (`cb_ort_repeat.mjs`, 5 cycles of load → generate → unload in one page, auto): load 3.5–4.7 s each, footprint after unload 500–589 MB (GPU process 124–132 MB) every cycle — no cumulative growth; stock 3 cycles: 36.3–54.8 s loads (one slow outlier), same release pattern.

## 5. Correctness
- Experiment (human, already passed): naturalness, intelligibility and speaker similarity comparable; no noise/clipping/silence.
- Controlled (WebGPU): seeded test copy of `conditional_decoder`, fixed inputs → **bitwise-identical** waveforms stock vs patched (original build and the fresh-clone build).
- Integrated pipeline: valid WAVs, durations as expected, warm RTF unchanged; Chatterbox, ZipVoice and F5 regression cases pass (see §7). **Human listening of the integrated UX is still pending.**

## 6. F5 preload bug found during integration (pre-existing, fixed)
`test_wait.mjs` failed "f5-fast: initialisation started within 400 ms". Investigation: F5's background preload did start at 146 ms, but **failed ~0.5 s later** on a fresh browser profile — first `Cache.put` "Unexpected internal error", then (after skipping that) reading the downloaded Blob back: "The requested file could not be read…". The load was then retried at Generate (select→ready 9.2 s, 1.4 s extra wait). The same failure reproduced on the untouched 8330 UX build, so it is **not** caused by the runtime integration. Fix in `fetchCached` only (no inference change): files served by this site (`models/f5/`) are no longer duplicated into Cache Storage; chunks are joined in memory instead of via a disk-paged Blob; a failed cache write is logged (`diag cache:put-failed`) and never aborts the load. Verified: 3 fresh-profile runs, F5 ready in 1.0–1.1 s before Generate, 0 s wait, all checks pass.
Separate observation: during these late runs F5 inference itself was slower on *both* 8330 and 8360 (≈ 8.3 s vs 5.5 s earlier for the same short text) — machine-level (same code on 8330), not caused by this branch; re-measure in a quiet session.

## 7. Regression (latest UX suite on 8360; see `outputs/reg/` (git-ignored) and the commit report)
2026-10-25, Apple M5 Pro, Chrome 156 headless, muted, `--disable-audio-output`; default `?ort=auto` (= patched runtime) unless stated. Logs: `outputs/reg/`.
| Suite | Result |
|---|---|
| F5 schedule unit tests | 35/35 |
| asset check `tools/check_assets.mjs` | pass |
| UX `test_ux.mjs --gen` | 113/113 (110 + 3 new: backend selector only for ZipVoice) |
| recording `test_recording.mjs --gen` | 51/51 on rerun. The first run inside the chain had 49/51: two requests to the local static server (`serve.py`, unchanged) were reset during the startup asset preflight (`net::ERR_CONNECTION_RESET` → zipvoice-hybrid group "not ready" + 2 console errors) while the same assets loaded and generated fine later in that run. Rerun alone: preflight all four ready, 0 console errors. Treated as a transient local-server issue (likely the default listen backlog of Python's `ThreadingHTTPServer` under the startup burst); not reproduced, not caused by this branch |
| runtime `test_cb_runtime.mjs --cpu` | 13/13: auto → patched (only the patched WASM fetched; key on `conditional_decoder.onnx_data` only; runtime shown in Advanced); stock (only stock WASM; ≥ 5× slower: 56.2 vs 6.2 s); strict patched with missing artefacts → clear error; auto fallback to stock with recorded reason for missing build, mismatched ORT commit, corrupt WASM (fresh worker); no autoplay; CPU device; real no-WebGPU browser (§9) |
| research-page model cases | 14/14 + `hybrid-fallback-en` failing without flags by design (it needs `--no-gpu`/`--block-decoder`) |
| interleaved switching (ZipVoice, hybrid, Chatterbox, F5, zh/en/mixed) | 9/9 |
| ZipVoice WebGPU fallback `--no-gpu` / `--block-decoder` | pass / pass (ran WASM ZipVoice) |
| strict offline (fresh profile, all non-local requests blocked) | 5/5, 0 external requests (after a test-order fix, below) |
| lifecycle | first Chatterbox generate load 4.96 s; same text again / switch back 0.00 s; after page refresh 3.63 s; preload then generate 0.00 s; 0 `play()` |
| perceived waiting `test_wait.mjs` | all checks pass: chatterbox-fast ready 5.4 s, 0 s wait; chatterbox-relaxed 5.3 s, 0 s; zipvoice-fast 2.6 s, 0 s; **f5-fast 1.1 s, 0 s** (§6) |
- Test fix: `test_offline.mjs` set the ZipVoice backend selector before choosing a model; since the selector is now shown only for ZipVoice it timed out on F5. It now selects the tile first and sets the backend only for ZipVoice (what a user can do); assertions unchanged.
- Timing drift: during this regression the machine was slower than in §4 (stock ready 56 s vs 38 s, Chatterbox warm RTF ≈ 0.85–0.95 vs 0.58, F5 inference ≈ 8.4 s vs 5.5 s), affecting stock and patched alike; §4 numbers are the controlled benchmark.

## 8. Fresh-clone rebuild
`git clone … && git checkout integration/chatterbox-fastload && experiments/chatterbox-ort/build_ort_web.sh` was run in a clean temporary clone (outside the active worktrees) and succeeded after two fixes found that way: (1) building under `/tmp` fails on macOS — CMake rewrites `/private/tmp` to `/tmp`, Emscripten then wipes/regenerates its header cache concurrently and compiles fail with missing libc/libc++ headers; the script now uses physical paths and refuses `/tmp`/`/var`; (2) Emscripten's bundled Closure Compiler binary is x86-64-only, so the script fetches a local arm64 JDK (Temurin 21) into `.ort/tools/jdk` (nothing installed system-wide). The rebuild is **functionally identical** (decoder bitwise-identical output, 2.5 s session) but **not byte-identical** to the first build (the WASM embeds source paths; the `.mjs` differs only in embedded offsets), so the runtime is validated by its build commit at load time rather than by hash.
Prerequisites: macOS or Linux, git, curl, python3, `uv` (for the pinned CMake/Ninja), ~3 GB disk, network for the first run; Apple silicon also needs the JDK the script downloads. Time ≈ 20–30 min on an M5 Pro.

## 9. No WebGPU
- Forced CPU device (`&cbdevice=wasm`, WASM EP) with the patched runtime and the key on the decoder: ready 7.0 s, generated valid audio (2.64 s, peak 0.83).
- Real browser without WebGPU (`--disable-gpu`, default URL): Chatterbox selected its WASM device on the patched runtime (key on `conditional_decoder.onnx_data`), ready 6.9 s, generated valid audio, no error.
- So the key also removes the planning cost on the CPU path. Not measured: CPU-path inference speed vs stock, and listening quality on that path.

## 10. Maintenance and limitations
- The patched WASM must be rebuilt whenever the onnxruntime-web version imported by Transformers.js changes; `auto` detects a mismatch (commit check) and falls back to stock with a reason, so a stale build cannot be used silently.
- The key is not upstream; propose it (or a faster `FindReusableTensor`) to ONNX Runtime using the native repro on the diagnostic branch.
- Not measured: real Internet download time; other browsers/GPUs; human listening on this integrated build (human acceptance pending).
