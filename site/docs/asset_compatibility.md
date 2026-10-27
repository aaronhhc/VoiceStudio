# Asset compatibility matrix: Voice Studio model files on Hugging Face (Task D, Phase A/B)

Date: 2026-10-27. Branch `deployment/github-pages-hf` (from the Task C release `5f87fb8`). Question: which of the files the working Voice Studio uses can the
browser download **unchanged** from an existing, revision-pinned Hugging Face repository, so that the public site (GitHub Pages) needs to host only the app?

Method: every local file pinned in `playground/assets.manifest.json` (size + sha256) was compared with the Hub's tree API at a fixed revision
(`/api/{models|spaces}/<repo>/tree/<rev>?recursive=true`): LFS files by their `lfs.oid` (= sha256 of the content), small non-LFS files by their git blob
sha1 recomputed locally. `deploy/ghpages/build.mjs` repeats this check on every release build and refuses to build on any difference. ONNX signatures,
precision and external-data references were read with `onnx.load(..., load_external_data=False)` (raw dump: not committed; regenerate with the snippet in §5).
Then a real browser test (Phase B, §3) downloaded the pinned URLs with `fetch` under the production CSP.

## 1. Pinned upstream repositories

| Id | Repository | Revision (pinned) | Licence (as stated upstream) |
|---|---|---|---|
| zipvoice-space | Space `k2-fsa/web-assembly-zh-en-tts-zipvoice` | `a118980aaa8d985d10e57425c1fdc2301c05f4cc` (2026-08-11) | none declared; bundle contains ZipVoice weights (CC-BY-NC, k2-fsa/ZipVoice README §4), Vocos (MIT), eSpeak NG data (GPL-3.0); `.wasm` links eSpeak NG (GPL-3.0) |
| — (provenance) | `k2-fsa/ZipVoice` | `889dd609a42f0de9cf9aac335eae42677becb1b9` | code Apache-2.0; pre-trained models CC-BY-NC (Emilia) |
| chatterbox | `onnx-community/chatterbox-ONNX` | `3cab09af388d3f02bba43443fce88c1f4525ac43` | MIT (base model `ResembleAI/chatterbox`, MIT) |
| f5 | `nsarang/F5-TTS-ONNX` | `2e7e47e103a565c85dcd32141b6b11eeeb57eee6` | tagged apache-2.0, but derived from `SWivid/F5-TTS` weights = **CC-BY-NC-4.0** (card @ `84e5a410`) |
| rejected | `huggingfacess/F5-TTS-ONNX` | `b6a8c955…` | different export (`F5_Preprocess/F5_Transformer/F5_Decode` .onnx/.ort, DakeQQ-style graph split): not our encoder/transformer/decoder contract; not used |

## 2. Matrix

Sizes in bytes. "Identical" = byte-identical to the file the working app used (sha256). All hosted files: **direct browser download works** (§3) and
**the app uses them unchanged**.

| Model / component | Local path (dev checkout) | Size | sha256 (prefix) | Upstream file @ pinned revision | Identical | Signature (inputs → outputs) | Precision / quantisation | External data | Runtime |
|---|---|---:|---|---|---|---|---|---|---|
| ZipVoice bundle (text front end, INT8 encoder + **INT8 flow-matching decoder**, Vocos, tokens, lexicons, eSpeak NG data) | `web/runtime/sherpa-onnx-wasm-main-tts.data` | 204,108,836 | `0e2f08ed` | zipvoice-space `sherpa-onnx-wasm-main-tts.data` | yes (LFS) | Emscripten package; contains `/decoder.int8.onnx` (= k2-fsa/ZipVoice `zipvoice_distill/fm_decoder_int8.onnx`, sha256 `3cc2e08a`) and `/encoder.int8.onnx` (= `text_encoder_int8.onnx`, `f2de9a76`) | decoder: INT8 weights, `DynamicQuantizeLinear` ×283 + `MatMulInteger` ×298, per-tensor scale/zero-point | — | sherpa-onnx WASM (CPU) |
| ZipVoice baseline runtime | `web/runtime/sherpa-onnx-wasm-main-tts.wasm` | 13,473,435 | `d60db524` | zipvoice-space `sherpa-onnx-wasm-main-tts.wasm` | yes (LFS) | — | — | — | WebAssembly (served `application/wasm` by the Hub CDN) |
| ZipVoice baseline JS glue | `web/runtime/sherpa-onnx-tts.js`, `…-main-tts.js` | 33,227 / 111,298 | `91bb4b30` / `b8f1d2f2` | same Space (git blobs) | yes | — | — | — | hosted on Pages (small, Apache-2.0) |
| ZipVoice **WebGPU decoder** (FP32, dequantised) | `models/webgpu/decoder.dq.fp32.onnx` | 478,100,893 | `cff04e09` | **none** — our derivative (`dequantize.py`: `W_f = (W_q − zp)·s`) | — | `t:f32[]`, `x`, `text_condition`, `speech_condition: f32[N,T,100]`, `guidance_scale:f32[]` → `v:f32[N,T,100]` | FP32 (118.5 M params) | inline | ORT-web 1.30 WebGPU |
| …replaced by: decoder graph | `models/webgpu/decoder.dq.graph.onnx` | 4,174,360 | (release inventory) | not upstream; published on Pages (no large weights; CC BY-NC adaptation) | — | same as above | same graph, weights external | `decoder.dq.weights` (473,969,152 B, sha256 `afb24b2c`) | ORT-web `externalData` |
| …and recipe | `models/webgpu/decoder.dq.recipe.json` | 24 KB | (release inventory) | not upstream; Pages | — | 362 byte copies + 298 dequantisations from the INT8 decoder | — | — | `playground/workers/zipvoice-decoder.js` |
| ZipVoice upstream FP32 `fm_decoder.onnx` | — | 477,534,010 | `4510d4f5` | k2-fsa/ZipVoice `zipvoice_distill/fm_decoder.onnx` | **no** — a different export (not dequantised INT8) | | FP32 | | **not used** (would silently change the model) |
| Chatterbox config/tokenizer/preprocessor/generation_config | `models/chatterbox/onnx-community/chatterbox-ONNX/*.json` | 93 – 28,543 | — | chatterbox (git blobs) | yes | — | — | — | Transformers.js |
| Chatterbox `speech_encoder` | `…/onnx/speech_encoder.onnx` + `.onnx_data` | 1,184,608 + 591,274,880 | `8f1c8a0f` / `04431dce` | chatterbox `onnx/…` | yes | `audio_values:f32[B,S]` → `audio_features:f32[B,L,1024]`, `audio_tokens:i64`, `speaker_embeddings:f32[B,192]`, `speaker_features:f32[B,F,80]` | FP32 | `speech_encoder.onnx_data` | ORT-web WebGPU (patched/stock 1.25.0-dev) |
| Chatterbox `embed_tokens` | `…/onnx/embed_tokens.onnx` + data | 13,286 + 61,640,704 | `160722ec` / `898c563c` | chatterbox | yes | `input_ids:i64`, `position_ids:i64`, `exaggeration:f32[B]` → `inputs_embeds:f32[B,L,1024]` | FP32 | `embed_tokens.onnx_data` | idem |
| Chatterbox **language model** (GPU) | `…/onnx/language_model_q4f16.onnx` + data | 229,388 + 304,737,408 | `3b78e923` / `2480da95` | chatterbox | yes | `inputs_embeds:f32`, `attention_mask:i64`, 30 layers × KV `f16[B,16,P,64]` → `logits:f32[B,L,8194]`, present KV | 4-bit weights (`MatMulNBits` ×151), FP16 activations | `language_model_q4f16.onnx_data` | idem |
| Chatterbox language model (CPU) | `…/onnx/language_model_q4.onnx` + data | 227,911 + 353,621,248 | `7f8cdca8` / `5203d1e8` | chatterbox | yes | same, KV `f32` | 4-bit weights, FP32 | `language_model_q4.onnx_data` | ORT-web WASM |
| Chatterbox **conditional decoder** | `…/onnx/conditional_decoder.onnx` + data | 6,350,448 + 533,970,816 | `1656d0d3` / `51d58345` | chatterbox | yes | `speech_tokens:i64[B,N]`, `speaker_embeddings:f32[B,192]`, `speaker_features:f32[B,F,80]` → `waveform:f32[B,S]` | FP32 | `conditional_decoder.onnx_data` | patched ORT (`session.disable_mem_reuse`, this session only) |
| Chatterbox default voice | `…/default_voice.wav` | 714,320 | `3ebc531c` | chatterbox | yes | — | — | — | research page only |
| Chatterbox patched ORT runtime | `playground/ort-patched/*.wasm/.mjs` | 27,991,399 + 48,533 | (not byte-reproducible) | not upstream: our build (MIT + patch) | — | — | — | — | hosted on Pages (< 100 MB), source in `/source/` |
| F5 encoder | `models/f5/onnx/encoder_fp32.onnx` | 68,549,853 | `e71d3ed1` | f5 `onnx/encoder_fp32.onnx` | yes (LFS) | `audio:i16[1,1,A]`, `text_ids:i32[1,T]`, `max_duration:i64[1]` → noise, RoPE cos/sin, `cat_mel_text(_drop)`, `ref_signal_len` | FP32 (+16.8 M FP16 consts) | — | ORT-web 1.22 |
| F5 **transformer (FP16)** | `models/f5/onnx/transformer_fp16.onnx` | 661,145,803 | `460b46f4` | f5 `onnx/transformer_fp16.onnx` | yes (LFS) | `noise:f16[1,D,100]`, RoPE `f16`, `cat_mel_text(_drop):f16[1,D,612]`, `time_step.1:i32[1]` → `denoised:f16[1,D,100]`, `time_step:i32[1]` | FP16 (330 M) | — | ORT-web 1.22 WebGPU (`shader-f16`) |
| F5 transformer (FP32) | — (not provisioned locally) | 1,321,718,282 | `c63aeb96` | f5 `onnx/transformer_fp32.onnx` | n/a (upstream only) | as above, FP32 | FP32 | — | used only without `shader-f16` |
| F5 decoder (Vocos) | `models/f5/onnx/decoder_fp32.onnx` | 62,550,703 | `a16fea89` | f5 `onnx/decoder_fp32.onnx` | yes (LFS) | `denoised:f32[1,D,100]`, `ref_signal_len:i64` → `output_audio:i16` | FP32 | — | ORT-web 1.22 |
| F5 vocabulary | `models/f5/vocab.txt` | 13,800 | `2a05f992` | f5 `vocab.txt` (git blob) | yes | 2,546 tokens (pinyin + chars) | — | — | worker tokenizer |
| F5 sampling grid / ODE schedule | `playground/workers/f5-schedule.js` | code | — | ours (fix of the truncated baked schedule, `experiment/f5-browser` 199e358) | — | `eulerPlan(nfe)` | — | — | hosted on Pages; verified per run (ODE end t = 1) |

Tokenizer/vocoder requirements: ZipVoice's tokens, lexicons, eSpeak NG data and Vocos are all inside the `.data` bundle; Chatterbox's tokenizer is
`tokenizer.json` (Transformers.js) and its vocoder is part of `conditional_decoder`; F5 uses `vocab.txt` + pinyin-pro (vendored, Pages) and its own
Vocos `decoder_fp32.onnx`.

## 3. Phase B: real browser downloads (Chrome 156, headless, Apple M5 Pro, 2026-10-27)

`fetch()` from a page with the production CSP (`connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co`), revision-pinned
`resolve` URLs:

| File | Redirect chain | CORS | Content-Length | Bytes received | sha256 = manifest | First bytes |
|---|---|---|---|---|---|---|
| f5 `vocab.txt` (git blob) | 307 → `huggingface.co/api/resolve-cache/…` | `ACAO: <origin>` | absent (compressed) | 13,800 | yes | text |
| chatterbox `config.json` (git blob) | 307 → resolve-cache | yes | absent | 1,097 | yes | `{ "model_type": "chatterbox"` |
| chatterbox `onnx/embed_tokens.onnx` (LFS/Xet) | 302 → `us.aws.cdn.hf.co/xet-bridge-us/…` | `ACAO: *` | 13,286 | 13,286 | yes | ONNX protobuf (`pytorch 2.8.0`) |
| k2-fsa/ZipVoice `text_encoder_int8.onnx` | 302 → Xet CDN | yes | 5,570,211 | 5,570,211 | yes | ONNX (`onnx.quantize`) |
| Space `sherpa-onnx-wasm-main-tts.wasm` | 302 → Xet CDN | yes | 13,473,435 | 13,473,435 | yes | `\0asm`, `content-type: application/wasm` |
| Space `sherpa-onnx-wasm-main-tts.data` | 302 → Xet CDN | yes | 204,108,836 | 204,108,836 (in the POC worker) | yes (`0e2f08ed`) | Emscripten package |
| missing file | 404 `Entry not found` | yes (readable) | 15 | — | — | plain text, not HTML |

No CSP violations. ETags of Xet-served files are **not** sha256 (Xet hashes), so integrity is checked by our own sha256 (§ docs/github_pages_deployment.md).
End-to-end POC (`outputs/poc/zv.*`, not committed): the unmodified sherpa-onnx baseline worker with `.wasm` and `.data` located at the Space URLs reached
"model ready" in 8.3 s (cold profile, includes the 204 MB download) and generated Mandarin (5.96 s audio) and English (3.34 s) speech (WASM, RTF ≈ 3.0–3.5
headless). Full-app results: `docs/github_pages_deployment.md`.

## 4. Decision

- **Chatterbox, F5, ZipVoice bundle and baseline runtime:** downloaded by the browser directly from the pinned upstream repositories; nothing re-uploaded.
- **ZipVoice WebGPU decoder:** the only derived weight file. Instead of uploading the 478 MB derivative to a new Hugging Face repository, the browser
  rebuilds its exact weights from the upstream INT8 decoder it already has (inside the `.data` bundle): `deploy/ghpages/decoder_recipe.py` splits
  `decoder.dq.fp32.onnx` into a weight-free graph (4.2 MB) + a byte recipe (24 KB); `playground/workers/zipvoice-decoder.js` applies the recipe
  (sha256-checked input and output). Measured: the rebuilt weights are byte-identical (sha256 `afb24b2c…` in Node and in Chrome), and the decoder outputs
  are **bit-identical** to the original file's on WebGPU (3 input shapes, max |Δ| = 0) and on ORT CPU. ZipVoice's first-use download falls from ≈ 723 MB
  to ≈ 249 MB. No new Hugging Face repository, upload or approval is needed for any weight.
- Not used: upstream FP32 `fm_decoder.onnx` (different weights), `huggingfacess/F5-TTS-ONNX` (incompatible export).

## 5. Reproduce

```bash
node playground/tools/check_assets.mjs                                       # local copies = manifest
uv run deploy/ghpages/decoder_recipe.py models/webgpu/decoder.dq.fp32.onnx models/zipvoice-bundle/decoder.int8.onnx models/webgpu/
node deploy/ghpages/test_unit.mjs                                            # streaming sha256 + decoder rebuild (Node)
node deploy/ghpages/build.mjs                                                # re-checks every hosted file against the Hub at its pinned revision
```
`models/zipvoice-bundle/decoder.int8.onnx` = bytes 2,748 … 124,659,848 of the `.data` bundle (offsets from the package table in
`sherpa-onnx-wasm-main-tts.js`; `scripts/extract-bundle.py` extracts it).
