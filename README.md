# Voice Studio — on-device speech synthesis in the browser

**Website: https://aaronhhc.github.io/VoiceStudio/**

Voice Studio is a non-commercial academic research demonstration (National Taiwan Normal University, Department of Computer Science and
Information Engineering — Speech AI industry–academia collaboration). You record a short sample of your own voice, type a sentence, and one of three
text-to-speech models speaks it in your voice. **All speech synthesis runs inside your browser, on your own device** (WebGPU or WebAssembly).
There is no inference server: your recording, your text and the generated audio are never uploaded.

中文說明與示範步驟：[GUIDE.zh-TW.md](GUIDE.zh-TW.md)

## Models

| Model | Languages | Runs on | First-use download |
|---|---|---|---|
| ZipVoice-Distill (k2-fsa) | Mandarin, English, mixed | WebGPU decoder + WebAssembly (CPU fallback) | about 0.25 GB |
| Chatterbox (Resemble AI) | English | WebGPU (CPU fallback, slow) | about 1.5 GB |
| F5-TTS (SWivid) | Mandarin, English; mixed is experimental | WebGPU | about 0.8 GB |

Model files are downloaded once and kept in the browser (Cache Storage) for later visits and offline use; they can be removed under
**My creations → Model files on this device**.

**Recommended:** desktop Chrome or Edge (current version) with WebGPU, 8 GB of memory or more, a microphone, and a fast connection for the
first use of each model. Other browsers and phones have not been tested.

## How it works

```
GitHub Pages (this repository, site/)          Hugging Face Hub (original repositories, revision-pinned)
  app, workers, WebAssembly runtimes              k2-fsa/web-assembly-zh-en-tts-zipvoice   ZipVoice bundle (.data)
  ZipVoice decoder graph + recipe                 onnx-community/chatterbox-ONNX           Chatterbox ONNX weights
  service worker (sw.js)                          nsarang/F5-TTS-ONNX                      F5-TTS ONNX weights
            \                                        /
             visitor's browser: ONNX Runtime Web / sherpa-onnx WebAssembly, WebGPU — all inference happens here
```

- The large model weights are **not** stored in this repository. The browser downloads them directly from the model authors' Hugging Face
  repositories at fixed commits (`site/playground/hosting.json`). Every file's size and SHA-256 were checked against the Hub when the release was
  built, and the browser checks each file's size and SHA-256 again before any model runtime can use it (a damaged download fails instead of
  loading) and before a copy is kept on the device.
- ZipVoice's WebGPU path needs an FP32 version of the INT8 decoder. Instead of hosting a converted 478 MB file, the browser rebuilds the exact FP32
  weights from the INT8 decoder that is already inside the downloaded bundle, using a small graph and recipe (`site/models/webgpu/`), and checks the
  result's SHA-256.
- Nothing runs on a server. GitHub Pages and Hugging Face only serve static files.

## Licences and attribution

This is a non-commercial academic research demonstration: no ads, payments, subscriptions or commercial use. The model weights keep their own licences:

- **ZipVoice-Distill** weights: CC BY-NC 4.0 (k2-fsa). Our only change is the FP32 dequantisation of the decoder (graph and recipe in `site/models/webgpu/`), under the same licence.
- **F5-TTS** weights: CC BY-NC 4.0 (SWivid). ONNX export by nsarang.
- **Chatterbox**: MIT (Resemble AI). ONNX export by onnx-community.
- **sherpa-onnx** (Apache-2.0) WebAssembly runtimes include **eSpeak NG (GPL-3.0)**; our patch and build scripts are in `site/source/`, and the complete
  corresponding source of our build (patched tree + every dependency source) is the release asset
  [`voicestudio-hybrid-runtime-source-vs-20261027-1db5a87.tar.gz`](https://github.com/aaronhhc/VoiceStudio/releases/tag/source-vs-20261027-1db5a87).
  Statically linked components and their licences: `site/source/NOTICES-hybrid-runtime.md`; ONNX Runtime third-party notices: `site/source/onnxruntime/`.
- **ONNX Runtime Web** (MIT; one patched build for Chatterbox, patch in `site/source/`), **Transformers.js** (Apache-2.0), **pinyin-pro** (MIT), **Vocos** (MIT).

This website is not affiliated with or endorsed by the authors of these models and libraries; their names are used only to credit their work.

Full credits: [site/playground/credits.html](https://aaronhhc.github.io/VoiceStudio/playground/credits.html) ·
component list: `site/THIRD_PARTY.md` · licence texts: `site/source/LICENSES.md`.

Responsible use: only clone a voice with the speaker's permission, and label generated audio as synthetic when you share it.

**This project's own application code** (HTML, CSS, JavaScript, build and test tooling): © 2026 the author, all rights reserved — no open-source
licence is granted at this time. This does not change the licences of the third-party components and model weights listed above, which apply to
those components as stated by their authors (including the GPL-3.0 corresponding source offer in `site/source/`).

## This repository

| Path | What |
|---|---|
| `site/` | the website exactly as published (built and audited in the private research repository) |
| `RELEASE.json` | the release record: every file with size and SHA-256, the Hugging Face URLs and pinned revisions |
| `.github/workflows/pages.yml` | re-checks `site/` and deploys it with the official GitHub Pages actions |
| `GUIDE.zh-TW.md` | demo guide (Traditional Chinese) |

Releases are built in the private research repository (`node deploy/ghpages/build.mjs --record`) and copied here by `deploy/ghpages/publish.sh`,
which audits the files (no weights, recordings, local paths or credentials) before committing. Each push to `main` redeploys the site.
To roll back, revert the release commit (or re-run the workflow of an earlier commit).
