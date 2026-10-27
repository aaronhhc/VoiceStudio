# Stage 1 — Browser TTS feasibility (2026-10-21)

Machine: Apple Silicon M5 Pro, macOS, Chrome (system install) driven headless by Playwright. Server: `scripts/serve.py` on localhost (model files already in HTTP-local disk, so "download" time is ~0.1 s — **not** representative of a network first load).

## What the upstream Space is
`k2-fsa/web-assembly-zh-en-tts-zipvoice` is a *static* Space (no backend code). Files: `sherpa-onnx-wasm-main-tts.{js,wasm,data}`, `sherpa-onnx-tts.js` (JS API), a worker and a UI.
- Verified from `sherpa-onnx-tts.js` (model type 4) and ONNX metadata printed at load: `encoder.int8.onnx`, `decoder.int8.onnx` (ZipVoice flow-matching decoder, `onnx.infer=onnxruntime.quant`), `vocos_24khz.onnx`, `lexicon.txt`, `espeak-ng-data`, `tokens.txt`, all packed in the 195 MB `.data` file.
- **Full TTS inference runs inside the browser** (WASM, in a Web Worker). Text frontend, encoder, 4-step decoder and vocoder are all in the WASM module. No network calls at generate time (observed: only the 404 for `favicon.ico`).
- WASM build is **single-threaded** (no pthread/SharedArrayBuffer usage) and **CPU only** (no WebGPU backend compiled in). The page text says the same.
- Whether it works fully offline after load was **not tested** (no service worker; relies on browser cache).
- Whether the bundled decoder is "distill" vs "base": numSteps=4 is passed by upstream UI, consistent with Distill; the model card was not checked. 

## Reproduction
`./scripts/fetch-runtime.sh && python3 scripts/serve.py 8000`, open http://localhost:8000. Our own minimal UI (`web/`) drives the *unmodified* upstream runtime; I did not run the upstream page itself (same worker logic, same runtime files).

## Results (reference voice = macOS `say`, synthetic; ASR = whisper-small via mlx-whisper)
| Test | Result |
|---|---|
| Model loads, status UI, no console errors | OK (only favicon 404) |
| English text, English ref | Intelligible (ASR: "Hello, this is I-Test of the Honor device text to speech system" for "…on-device…") |
| Chinese text, Chinese ref | Intelligible (ASR exact match, trad./simpl. aside) |
| Code-switching zh+en, Chinese ref | Intelligible ("Starbucks", "coffee" recognised) |
| Chinese text, **English** ref | Poor (ASR garbage) → cross-lingual reference is weak; use same-language ref |
| English+Chinese mixed text, **English** ref | Chinese part missing/garbled |
| Voice similarity to reference | **Not evaluated** (needs human listening / speaker-embedding score) |
| Playback | `<audio>` playback of produced WAV works; autoplay may be blocked without a user gesture |

## Performance snapshot (details in Stage 3)
Warm single-thread WASM generation: **RTF ≈ 2.2–3.5** (short texts worst, fixed overhead). Example: 4.8–5.0 s audio in 11.1 s. **RTF < 1 is NOT met** by this build.
Init after files cached: ~0.6 s. WASM heap 512 MB; page JS memory ~200 MB.

## Streaming
Not streaming. The C API callback fires once per *sentence* (`min_char_in_sentence` splits) with its samples; short utterances produce a single chunk, so audio only exists after the whole sentence finishes. Our UI labels output "full-utterance". Sentence-level playback of multi-sentence text is possible via the callback but not implemented/verified.

## Unsupported / incomplete
- RTF < 1 (see above). Candidates to investigate, in order: multi-threaded WASM build of sherpa-onnx (needs COOP/COEP — already set in serve.py), onnxruntime-web WebGPU for the decoder/vocoder, fewer sentences/shorter reference, native-CPU baseline on lab machines to see how far off WASM is.
- True streaming, expressive control, cross-lingual cloning quality.
