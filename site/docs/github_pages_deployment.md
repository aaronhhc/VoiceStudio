# Deployment: Voice Studio on GitHub Pages + Hugging Face (Task D)

Status (2026-10-27): **built, audited and verified locally against a GitHub Pages stand-in; publication approved by the owner (§10) after the
issue #14 fix (model files are sha256-verified before any runtime can use them, §4).** The test of the real https://aaronhhc.github.io/VoiceStudio/ is
recorded in §11 of this document in the research repository (the copy published with the release predates it).

Branch `deployment/github-pages-hf` (from the Task C release branch at `5f87fb8`). Supersedes the Cloudflare Pages + R2 plan of `docs/deployment.md`
(that tooling, `deploy/*.mjs|sh|js`, is kept for reference and is not used by this release). Asset audit: `docs/asset_compatibility.md`.

## 1. Architecture

```
https://aaronhhc.github.io/VoiceStudio/   (GitHub Pages, public repo aaronhhc/VoiceStudio, deployed by GitHub Actions from site/)
 ├─ index.html → playground/ (the app: Create, Compare, My creations, Project Journey, Advanced settings, Developer diagnostics)
 ├─ playground/workers/*, adapters/*, vendored JS (Transformers.js, ONNX Runtime Web 1.22 / 1.30 / 1.25-dev, pinyin-pro), hybrid-runtime/ (our sherpa-onnx build),
 │  ort-patched/ (Chatterbox fast-start ONNX Runtime), web/worker.js + sherpa-onnx JS glue
 ├─ models/webgpu/decoder.dq.graph.onnx (4.2 MB) + decoder.dq.recipe.json (24 KB)   — no large weights
 ├─ playground/hosting.json   large-file path → revision-pinned Hugging Face URL (+ repos)
 ├─ sw.js (scope /VoiceStudio/)   app shell per release; model files sha256-verified before use, kept after first use
 └─ source/ (patches, build scripts, decoder recipe tool, licence texts), docs/, THIRD_PARTY.md, 404.html
                     │ fetch (CORS), only when a model is used
                     ▼
Hugging Face Hub (anonymous, free; 302 → Xet CDN *.hf.co, Access-Control-Allow-Origin: *)
 ├─ spaces/k2-fsa/web-assembly-zh-en-tts-zipvoice @ a118980a   sherpa-onnx-wasm-main-tts.data (204 MB), .wasm (13.5 MB)
 ├─ onnx-community/chatterbox-ONNX @ 3cab09af                    17 files, 1.85 GB (≈ 1.50 GB used per device)
 └─ nsarang/F5-TTS-ONNX @ 2e7e47e1                               4 files, 792 MB (+ transformer_fp32 1.32 GB only without shader-f16)

visitor's browser: all inference (sherpa-onnx WASM, ONNX Runtime Web WebGPU/WASM, Transformers.js) — nothing is sent anywhere
```

- **No server code anywhere.** GitHub Pages and the Hub serve static files. There is no proxy, function, tunnel or inference API.
- **No weights re-hosted.** Every large model file is downloaded from the original repository at a fixed revision, unchanged (byte identity checked, §4).
- **One derived file is not hosted either.** ZipVoice's WebGPU path needs the INT8 decoder dequantised to FP32 (478 MB). The browser rebuilds those
  exact weights from the INT8 decoder that is already inside the downloaded `.data` bundle (`playground/workers/zipvoice-decoder.js`, recipe from
  `deploy/ghpages/decoder_recipe.py`). Rebuilt weights: byte-identical (sha256 checked in the page); outputs bit-identical on WebGPU (§5).
- **Cross-origin caching.** A service worker cannot be installed for huggingface.co, but it does see the cross-origin requests of the pages and model
  workers it controls. `sw.js` passes those CORS (non-opaque) responses to the worker through a verified stream and stores a second branch of the same
  stream in Cache Storage (`playground/workers/verify.js`, streaming sha256 ≈ 216 MB/s in Node); nothing is used or kept unless size **and** sha256 match
  the release (§4). Transformers.js' and
  F5's own caches are switched off while the service worker controls the page (one stored copy). Without a service worker (hard reload, development)
  the workers download directly and use their own caches, so the site still works.
- **Base path.** Everything is relative (`new URL(…, import.meta.url)`), the service worker resolves its lists against its own location, and the
  vendored Transformers.js imports are rewritten from root-absolute to module-relative at build time. The build fails if a root-absolute site path remains.
- **CSP** (GitHub Pages cannot send headers, so a `<meta>` tag in every page): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
  connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'
  'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'none'` + `<meta name="referrer" content="no-referrer">`. Limits vs Task C's headers: a
  meta CSP does not cover the model workers (they get no CSP; same-origin scripts only), `frame-ancestors`, COOP/CORP and Permissions-Policy are not
  available on GitHub Pages. No model needs cross-origin isolation (it was not enabled in Task C either).

## 2. What changed from the Task C release (code)

| File | Change |
|---|---|
| `playground/adapters/common.js` | `hosting` (release asset map, `null` in development), `swCached()` |
| `web/worker.js`, `playground/workers/zipvoice-hybrid.worker.js` | bundle `.data` (and baseline `.wasm`) from the map; hybrid rebuilds the WebGPU decoder from graph + recipe + `/decoder.int8.onnx` read from the bundle's in-memory file system (`FS.readFile`), sha256-checked; full-file fallback kept for old dev checkouts |
| `playground/workers/zipvoice-decoder.js` (new) | the rebuild: 362 byte copies + 298 dequantisations `f32((q − zp)·s)`, input/output sha256 |
| `playground/workers/chatterbox.worker.js`, `adapters/chatterbox.js` | Transformers.js remote mode with `revision` = pinned commit, `remoteHost` from the map; own cache off under the service worker; patched runtime and its session hook unchanged |
| `playground/workers/f5.worker.js`, `adapters/f5.js` | pinned repository base from the map (dev fallback now pinned too); own cache off under the service worker; sampling schedule code unchanged |
| `playground/preflight.js` | hosted files are not contacted at startup; checked against the service worker's saved copies only when the site is unreachable |
| `playground/studio/offline.js` | service worker registered relative to the site root (works at `/` and `/VoiceStudio/`); integrity errors shown in My creations; ZipVoice first-use size 0.25 GB |
| `playground/credits.html`, `THIRD_PARTY.md`, `studio/journey.json`, `studio/models-info.js` | where files come from, decoder rebuild, new milestone |
| `deploy/ghpages/*` (new) | build, service worker, hosting map, decoder recipe, preview, HF mirror (tests), QA, unit tests, public README/workflow, publish + audit |

## 3. Release build and local verification

```bash
playground/tools/provision_assets.sh && node playground/tools/check_assets.mjs                 # git-ignored assets (once per checkout)
uv run deploy/ghpages/decoder_recipe.py models/webgpu/decoder.dq.fp32.onnx models/zipvoice-bundle/decoder.int8.onnx models/webgpu/
node deploy/ghpages/test_unit.mjs                                                              # streaming sha256, verified stream + fetch gate, decoder rebuild (Node)
node deploy/ghpages/build.mjs --record                                                         # → outputs/ghpages/<release>/site + inventory.json; deploy/releases/<release>.json
node deploy/ghpages/preview.mjs --port 8480                                                    # GitHub Pages stand-in: http://127.0.0.1:8480/VoiceStudio/
node deploy/ghpages/test_site.mjs --only shell,gen --profile outputs/ghpages/profiles/p1      # real Hugging Face downloads (≈ 2.6 GB on a fresh profile)
node deploy/ghpages/test_site.mjs --only warm,cbinit --profile outputs/ghpages/profiles/p1    # reload, offline A/B, Chatterbox stock vs patched init
node deploy/ghpages/hf_mirror.mjs &                                                            # test-only Hugging Face stand-in (local verified copies)
node deploy/ghpages/test_site.mjs --only faults,integrity,device,layout --mirror             # fault injection, sha256 gate (issue #14), capability fallbacks, layout
node playground/test_studio.mjs --base http://127.0.0.1:8480/VoiceStudio/ --profile <dir>    # Voice Studio feature regression against the release
```
The release id is `vs-<date>-<commit>`; a build from uncommitted tracked files is `-dirty` and `publish.sh` refuses it. The build fails if any hosted file
differs from the Hub at its revision, a file exceeds GitHub's limits, an audio/weight file type or ONNX > 5 MiB would be published, a local path,
credential or root-absolute path is found. Our own WASM builds embed the build machine's source paths in assertion strings: the published copies
replace the account name (same length in binaries, `~/` in text).

Site: 85 files, 124.3 MB, largest 28.0 MB (patched ONNX Runtime WASM). Hosted upstream: 23 files (2.85 GB used by default; + 1.32 GB F5 FP32 transformer
only on GPUs without `shader-f16`).

## 4. Integrity

| Where | What is checked |
|---|---|
| build (`build.mjs`) | each hosted file: Hub tree API at the pinned revision — size, LFS sha256 (or git blob sha1) — equals `assets.manifest.json` and the local copy |
| browser, ZipVoice | `decoder.int8.onnx` sha256 before, rebuilt weights sha256 after (both in `decoder.dq.recipe.json`) |
| browser, service worker | every model file it answers from the network: verified stream (below); mismatch → the worker's download fails, nothing kept, reported in My creations and in the error ("integrity-error") |
| browser, model workers | the same gate on `fetch()` (`vsVerify.installFetch`, map = `hosting.json` "integrity") for responses that did not come through the service worker: hard reload, page not yet controlled, no service worker |
| browser, Chatterbox | patched runtime: build commit must match the ONNX Runtime version Transformers.js imports (unchanged from Task C), else automatic stock fallback |

**Verified stream (issue #14, fixed).** `vsVerify.verified()` hashes each chunk as it arrives and passes it on, but always holds back the most recent
chunk; at the end of the download it releases that chunk only if the byte count and sha256 equal the release, otherwise it errors the stream. Every
consumer here (Emscripten's package loader, `WebAssembly.instantiateStreaming`, ONNX Runtime Web, Transformers.js, F5's `fetchCached`) reads to the end
of the stream before using a file, so none of them ever has a complete unverified file: a mismatch becomes a failed download. Memory cost: one chunk;
download progress is unchanged. The service worker marks responses it gated (`x-vs-sha256`, a header a cross-origin host cannot expose to the page), so
the workers' gate does not hash them twice; files read back from Cache Storage were verified before they were stored. Earlier releases (before this fix)
hashed a parallel branch only, so a corrupted file was reported and not kept but could be used once.

Not covered: JavaScript loaded with `import()` / `importScripts` (Transformers.js, ONNX Runtime glue, the sherpa-onnx loader) is gated when the service
worker answers it, but not without one; it is code from this site, like the app shell, which is precached without per-file hashes (same trust as the
page itself, served over HTTPS). The Chatterbox default voice (`default_voice.wav`, an input recording, not a model) is fetched by the page, so only the
service worker gates it.

Tests: `test_unit.mjs` (Node: intact file passes byte-identical; one flipped bit, a middle byte, truncation and an oversized body each error the stream
before the consumer has the whole file; a single-chunk corrupted body delivers 0 bytes; the fetch gate handles URL strings, `Request` objects,
site-relative entries, leaves HEAD and unlisted URLs alone, skips responses already gated) and `test_site.mjs --only integrity --mirror` (Chrome, below).

## 5. Measured results (local GitHub Pages stand-in, real Hugging Face network)

Apple M5 Pro (18 cores, 25.8 GB), macOS, Chrome 156.0.0.0 headless, muted, fake microphone (`benchmarks/refs/ref_en.wav`, a macOS `say` voice), served by
`deploy/ghpages/preview.mjs` at `http://127.0.0.1:8480/VoiceStudio/`, model files from `huggingface.co` (Xet CDN `us.aws.cdn.hf.co`) over a home connection.
Raw: `deploy/ghpages/results/` (results + perf JSON, network logs). WAVs for listening: `outputs/ghpages/qa/127.0.0.1_8480/wav/` (git-ignored).

**Decoder equivalence (component test, `outputs/poc/dec_equiv.*`):** original `decoder.dq.fp32.onnx` vs graph + browser-rebuilt weights, two ORT-web 1.30
WebGPU sessions in one Chrome worker, seeded random inputs T = 120 / 347 / 64 (t = 0.3 / 0.85 / 0.0, guidance 1 / 1 / 3): **bit-identical, max |Δ| = 0**
for all three. Rebuild cost in Chrome: verify INT8 86 ms + rebuild 180 ms + verify weights 354 ms.

**Release QA (`test_site.mjs`):**

| Section | Result |
|---|---|
| shell (base path, CSP, SW scope, startup makes no third-party request, credits, `/source/`, 12 unpublished paths → 404, docs without local paths, 404 page) | 13/13 after the credits update |
| gen (fresh profile, real HF; ZipVoice zh/en, Chatterbox en, F5 en/zh, F5 NFE 12/16/32, network audit, single stored copy, My creations) | 20/21 → the failing check was the test's own transfer accounting (fixed; re-verified in the public run) |
| warm (reload without re-download, offline A, offline B for all three models, removed model shown unavailable offline) | 12/12 |
| cbinit (Chatterbox model-ready from saved files, 2 runs each) | patched 5.22 s vs stock 56.04 s (medians), ×10.7 — Task B/C's ×10.2 (38.37 → 3.77 s, local files) is preserved |
| faults / device / layout (HF mirror) | see `deploy/ghpages/results/` |
| integrity (HF mirror serving one corrupted file per loader: ZipVoice `.data` via Emscripten, F5 `decoder_fp32.onnx` via ORT, Chatterbox `embed_tokens.onnx_data` via Transformers.js; once without and once with the service worker) | 16/16 on 2026-10-27 (build `vs-test-integrity` = this fix, uncommitted): each model fails to load with an error naming the file and the sha256 mismatch, nothing is kept; after the host serves correct files all three load and generate; the file was verified by the worker gate (no SW) or the service worker gate only (with SW, not hashed twice) |
| shell + faults re-run with the fix (HF mirror) | 14/14 shell (incl. 10 research documents served, 7 internal notes → 404) + 11/11 faults (interrupted download, Hub 404, corrupted file now fails before use, quota, worker crash, mic denied) |

**Generation (cold = first use on a fresh profile, model preloaded while the 5 s recording ran; warm = model already loaded):**

| Run | Backend | Audio | Inference | RTF | Click → result |
|---|---|---:|---:|---:|---:|
| ZipVoice zh, cold | WebGPU decoder (FP32) + WASM front end/vocoder | 4.55 s | 0.98 s | 0.21 | 3.6 s |
| ZipVoice en, warm | same | 4.62 s | 0.99 s | 0.22 | 1.0 s |
| Chatterbox en, cold | WebGPU, Transformers.js / ORT-web (q4f16 LM), patched runtime | 3.46 s | 3.91 s | 1.13 | 47.1 s |
| F5 en, cold (NFE 16) | WebGPU, ORT-web 1.22, FP16 transformer | 5.45 s | 7.93 s | 1.45 | 34.0 s |
| F5 zh, warm, NFE 12 / 16 / 32 | same | 7.90 s | 7.62 / 10.72 / 22.14 s | 0.96 / 1.36 / 2.80 | — |

ZipVoice cold model-ready alone (adapter `load()` on a fresh profile, `outputs/poc/dbg_hybrid.mjs`): 12.1 s = bundle download + WASM instantiate 9.3 s,
sherpa init 0.8 s, graph/recipe fetch + rebuild 0.7 s, WebGPU session 1.3 s. RTF < 1 is not streaming: every model returns the whole utterance at once.
Inference time excludes model loading; "click → result" includes whatever loading was still left.

## 6. Licensing and redistribution (rechecked 2026-10-27 against the actual files; not legal advice)

| Item | Licence | How this release handles it |
|---|---|---|
| ZipVoice-Distill weights (in the k2-fsa `.data`) | CC-BY-NC (k2-fsa/ZipVoice README §4 @ 889dd609: "licensed under the CC-BY-NC due to constraints from its training data (Emilia)") | not redistributed: downloaded by the visitor's browser from k2-fsa's own Space; attribution + licence link on the credits page |
| ZipVoice WebGPU decoder graph + recipe | CC BY-NC 4.0 (adaptation; contains small tensors only, no large weights) | published on the site with attribution and the change stated (credits page, `/source/decoder_recipe.py`) |
| F5-TTS weights (nsarang ONNX export) | CC-BY-NC-4.0 (SWivid/F5-TTS card @ 84e5a410); export tagged Apache-2.0 but derived | not redistributed: downloaded from nsarang/F5-TTS-ONNX; attribution on credits page |
| Chatterbox | MIT (ResembleAI/chatterbox; onnx-community export MIT) | not redistributed; credits |
| eSpeak NG (GPL-3.0) in sherpa-onnx WASM | GPL-3.0 | k2-fsa's baseline `.wasm` is **not hosted** (loaded from k2-fsa's Space, so its unknown exact source commit — the open item of Task C — is no longer this site's distribution). Our hybrid build **is** hosted: corresponding source = sherpa-onnx v1.13.8 + `/source/sherpa-onnx-zipvoice-split.patch` + `/source/build_sherpa.sh` |
| sherpa-onnx (Apache-2.0), ONNX Runtime Web incl. our patched build (MIT), Transformers.js (Apache-2.0), pinyin-pro (MIT), Vocos (MIT) | permissive | vendored copies hosted with licence texts (`/source/LICENSES.md`, `THIRD_PARTY.md`); ORT patch + build script in `/source/` |

The whole site is a non-commercial academic demonstration (no ads, accounts, analytics or fees), which is what CC BY-NC 4.0 requires. Outstanding for
the owner: confirm the non-commercial status (and, if required, the university's); decide whether the public repository's own code gets a licence (none
is added; without one it is "all rights reserved" except the third-party parts, which keep theirs).

## 7. Cost and free-tier limits (checked 2026-10-27)

| Service | Plan | Limits that matter | This site |
|---|---|---|---|
| GitHub (public repo, Pages, Actions) | Free, no payment method | Pages: site ≤ 1 GB, files ≤ 100 MB, soft bandwidth 100 GB/month, soft 10 builds/hour; Actions minutes free for public repos | 124 MB, largest file 28 MB; each visitor's first visit ≈ 15–60 MB of app files depending on models used |
| Hugging Face Hub (anonymous downloads) | Free, no account needed by visitors | rate limits on `resolve` requests per IP (generous for a class-size demo); files stay available as long as the upstream repos keep these revisions | ≈ 0.25 / 1.5 / 0.8 GB per model per device, once |

No billing was enabled anywhere; nothing in the deployment asks for a payment method.

## 8. Updating, adding a model, rollback

- **Update the app:** change code on this branch → test → commit → `node deploy/ghpages/build.mjs --record` → QA (§3) → `deploy/ghpages/publish.sh <release> --push`
  (asks for the release id to confirm). The public repository's workflow re-checks `site/` and deploys it; the new service worker takes over after
  visitors close old tabs, removes the old shell and any stored model file the new release does not use.
- **New upstream revision of a model:** update `deploy/ghpages/hosting.json` (and the local copy + `make_manifest.mjs` if the bytes change); the build
  refuses mismatches, so a changed upstream file cannot slip in unnoticed.
- **Add a fourth model:** adapter in `playground/adapters/` + worker in `playground/workers/` (read large files through `hosting.json` like the others),
  register it in `playground/app.js`/`studio/models-info.js`, add its files to `make_manifest.mjs` (new group) and its repository to `hosting.json`
  (`prefix` = its local folder), add it to the gen/perf sections of `test_site.mjs`. Large weights must come from an existing repository at a pinned
  revision; anything derived needs either a browser-side rebuild like ZipVoice's or a new Hugging Face repository (owner approval + licence check).
- **Roll back:** `deploy/ghpages/publish.sh <older release> --push` (older builds stay in `outputs/ghpages/`; their inventories in `deploy/releases/`), or
  `git revert <release commit>` in the public repository (the workflow redeploys), or re-run the workflow of an older commit in the Actions tab.

## 9. Known limitations

- Measured on one machine, headless Chrome; Safari, Firefox, Windows, Android and iPhone not tested. External-device testing not done.
- Upstream availability: if a repository owner deletes or squashes a pinned revision, that model stops loading (the page reports the download error;
  `verify` = rebuild, which re-checks the Hub). Mitigation if it happens: re-pin to the new revision after re-verifying, or (owner approval) mirror.
- Interrupted downloads restart the file from the beginning (no Range resume); so does a file that fails its sha256 check.
- Human listening of this build is pending; ASR/automatic checks are not a substitute.

## 10. Approval gates before the first publication

1. Push the audited package (§3, `publish.sh`) to the public repository `aaronhhc/VoiceStudio` and enable Pages with the GitHub Actions source.
2. Owner confirmation of the non-commercial use (CC BY-NC 4.0) and of publishing the hybrid sherpa-onnx WASM (GPL-3.0 eSpeak NG) with its source in `/source/`.
3. Commit e-mail in the public repository (default: the configured git identity; `VS_PUBLIC_EMAIL` to use a GitHub noreply address).

No model weights need to be uploaded anywhere.

## 11. Public deployment record

Published documents: the research records behind the app's claims only (`PUBLIC_DOCS` in `build.mjs`: feasibility, performance analysis, playground,
ZipVoice hybrid ×2, F5 fix, Chatterbox lifecycle and fast load, asset compatibility, this document) + `THIRD_PARTY.md`. Internal development notes
(demo asset provisioning, guided-recording branch log, Voice Studio 2.0 branch log, four UX iteration notes) stay in this repository; the journey shows
their names as text. The F5 card's evidence no longer cites a UX note: its Whisper and listening results are in `docs/playground_f5_fix.md`.

(Public test results: added after deployment.)
