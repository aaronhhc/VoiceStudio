// Voice Studio service worker for the GitHub Pages release (published as <site>/sw.js; deploy/ghpages/build.mjs fills RELEASE, SHELL, MODEL_FILES and
// inlines playground/workers/verify.js). Works under any base path (https://<user>.github.io/<repo>/): every path is resolved against the worker's own location.
// It never sends anything anywhere: it only answers requests of this site's own pages and model workers from Cache Storage on this device.
//   App shell (HTML/JS/CSS, a few MB): precached per release, so the page reloads without a network connection.
//   Model files: the large ones come from revision-pinned Hugging Face repositories (cross-origin, CORS), the rest (runtimes) from this site. Each is
//   stored the first time a model is used, while the model worker downloads it (one download, one stored copy), and only while "Keep downloaded models
//   on this device" is on. Every download is hashed while it streams and its last chunk is released (to the model worker and to the stored copy) only
//   if size and sha256 match the release manifest; a damaged or unexpected file is never used or kept, and is reported to the page. Copies a release
//   no longer uses are dropped when it activates.
const RELEASE = "vs-20261027-1db5a87";
const SHELL = ["playground/adapters/chatterbox.js","playground/adapters/common.js","playground/adapters/f5.js","playground/adapters/zipvoice-hybrid.js","playground/adapters/zipvoice.js","playground/app.js","playground/assets.manifest.json","playground/credits.html","playground/index.html","playground/passages.js","playground/preflight.js","playground/recorder-worklet.js","playground/recorder.js","playground/studio/compare.js","playground/studio/device.js","playground/studio/history.js","playground/studio/journey.js","playground/studio/journey.json","playground/studio/library.js","playground/studio/main.js","playground/studio/models-info.js","playground/studio/offline.js","playground/studio/player.js","playground/studio/studio.css","playground/studio/wave.js","playground/ux/ux.css","playground/ux/ux.js","playground/workers/chatterbox.worker.js","playground/workers/f5-schedule.js","playground/workers/f5.worker.js","playground/workers/verify.js","playground/workers/zipvoice-decoder.js","playground/workers/zipvoice-hybrid.worker.js","web/worker.js","playground/hosting.json"];                              // paths relative to the site root
const MODEL_FILES_REL = {"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/config.json":{"n":1097,"h":"a7d8518edd1cf6346e4d2be33201747ea4c476718db756f42e6959e4828f4955","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/default_voice.wav":{"n":714320,"h":"3ebc531cdaba358a327099c1c4f0448026719957bcf4d8e9868767f227e02f4e","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/generation_config.json":{"n":93,"h":"1b6fbb953861089ebe7da64df46eeef570d53f47a44b7cc1b4d543669fc9cd50","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/conditional_decoder.onnx":{"n":6350448,"h":"1656d0d31332bae1854839959a3139300ebb67c178651dfa3f8c5fbfa5351351","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/conditional_decoder.onnx_data":{"n":533970816,"h":"51d58345a272747665ec9d5bb61e01835258a940e321a288582ac4c18cf01b5a","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/embed_tokens.onnx":{"n":13286,"h":"160722ec14789f616abdb1e31916cbbf9223c03fde0ab546d64ca74fb72e430b","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/embed_tokens.onnx_data":{"n":61640704,"h":"898c563c3a5ca1b9ea10ce89b0cdcf252b0bb5ab460dfc4eadea003b56e5d2ee","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/language_model_q4.onnx":{"n":227911,"h":"7f8cdca83b2493536cbf3acf421199808a3d68736f55f4eabd20ef8a99da4313","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/language_model_q4.onnx_data":{"n":353621248,"h":"5203d1e83c159316f9923c5c83759f6a34f87be1322ce4ad0facd9fc4aef4790","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/language_model_q4f16.onnx":{"n":229388,"h":"3b78e9235be5e2e2a811e482399155cb30415f6d87c98c21d12bf48843fc928f","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/language_model_q4f16.onnx_data":{"n":304737408,"h":"2480da95471e4cd41a6b1876686e65e8a594c82459f2e5d6fd7592a5bad4e6da","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/speech_encoder.onnx":{"n":1184608,"h":"8f1c8a0f89b77bf9cd5dd8f2e034eb2c79dc00fe70d41196b28c257643b00ccb","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/speech_encoder.onnx_data":{"n":591274880,"h":"04431dcef6325c54b02de2219845888b464bcd1f1ac2f8839c2fecd1ed2ef294","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/preprocessor_config.json":{"n":130,"h":"1c320b2eea5f45678d17d891d51c38467775091dbf26a074635ba5e98ede5950","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/tokenizer.json":{"n":28543,"h":"ecddf6aaae85e271610a2743409f7e447886957d0b0836687c1eaec5ccac2891","m":["chatterbox"]},"https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/tokenizer_config.json":{"n":244,"h":"b35967f93e30313d05fc9d520721ca9f671aaa5b3edbb03059aed3ff68b4c4c0","m":["chatterbox"]},"https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/2e7e47e103a565c85dcd32141b6b11eeeb57eee6/onnx/decoder_fp32.onnx":{"n":62550703,"h":"a16fea891beb4889b47e5987b80c841bb996beaccc1d1fe27a1f9323a089a6da","m":["f5"]},"https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/2e7e47e103a565c85dcd32141b6b11eeeb57eee6/onnx/encoder_fp32.onnx":{"n":68549853,"h":"e71d3ed14e90ba3fc1e83560512e86a771e25b6f0be7789b2cf53a5c9ba5617d","m":["f5"]},"https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/2e7e47e103a565c85dcd32141b6b11eeeb57eee6/onnx/transformer_fp16.onnx":{"n":661145803,"h":"460b46f401286ffae2270771bb38902ef293eab4e7812265d38baaf7458f97bb","m":["f5"]},"https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/2e7e47e103a565c85dcd32141b6b11eeeb57eee6/vocab.txt":{"n":13800,"h":"2a05f992e00af9b0bd3800a8d23e78d520dbd705284ed2eedb5f4bd29398fa3c","m":["f5"]},"models/webgpu/decoder.dq.graph.onnx":{"n":4174360,"h":"ba2f441a9f8732c3d8a468109dc5dd995f4b510724e95cd873cd05b5321f7587","m":["zipvoice"]},"models/webgpu/decoder.dq.recipe.json":{"n":24122,"h":"eeebceda1ac7b46786c8ef3049443e6ba2ccbaf5cf05d86b4614eb952cadea7b","m":["zipvoice"]},"playground/hybrid-runtime/sherpa-onnx-tts.js":{"n":33271,"h":"ea692f6907722b4f59085ea47108f6b9b33606d0e96400e6c48c99559832ceb8","m":["zipvoice"]},"playground/hybrid-runtime/sherpa-onnx-wasm-main-tts.js":{"n":112005,"h":"68f50c4998957b0608a8ae9747242c2dfb0ebff81f9c50f32460fbd9c66df254","m":["zipvoice"]},"playground/hybrid-runtime/sherpa-onnx-wasm-main-tts.wasm":{"n":13740412,"h":"9425c663367325cb263af8f837610b57690d0ce7e123bef51e4dac95cc50aab9","m":["zipvoice"]},"playground/ort-patched/BUILD-INFO.txt":{"n":590,"h":"2f25abdb5933c9e4474e0650691a4384c12a6e105661519b871e0b1ca105f25d","m":["chatterbox"]},"playground/ort-patched/ort-wasm-simd-threaded.asyncify.mjs":{"n":48533,"h":"bbaffcdc1305cba2d2d740c9712ac1abe743fa2c72658f3982fca9f209dece5a","m":["chatterbox"]},"playground/ort-patched/ort-wasm-simd-threaded.asyncify.wasm":{"n":27991399,"h":"0c09c1658c5c4ff1895470cea0307040316ba0494efa1f20bfa27ed6be01cbbb","m":["chatterbox"]},"playground/vendor/jsdelivr/npm/@huggingface/transformers@4.0.0-next.2/+esm.js":{"n":380546,"h":"bae1a89e23df50f6699ee6411e2531a47c22dc3d085c795d1c3e139dc31997de","m":["chatterbox"]},"playground/vendor/jsdelivr/npm/onnxruntime-common/+esm.js":{"n":19672,"h":"b3bdb1f8905e7846d1c5969a9c9d643cfb9b313efb05fda4858fdf575d0a5be2","m":["chatterbox"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.mjs":{"n":44677,"h":"1cbcba8f2c769c1eecbab66a1b1e55ef11704515bf4306373e3db3c37cf6dcd8","m":["f5"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.wasm":{"n":21872216,"h":"b45970d0632383a057c27ca5b660b216f8e00c17cf8db9f6207b5e4abc839368","m":["f5"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.mjs":{"n":357582,"h":"e131e81c9324807e1e6f9103e8f8e936112827dcc9993cde9407a333b1f07ae0","m":["f5"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.25.0-dev.20260209-a3749f1353/dist/ort-wasm-simd-threaded.asyncify.mjs":{"n":48533,"h":"6a0ecca44e2ea4ae193837f3893819f39f8d2768fadcf14e485b60fccc939762","m":["chatterbox"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.25.0-dev.20260209-a3749f1353/dist/ort-wasm-simd-threaded.asyncify.wasm":{"n":27200494,"h":"a0a8899e2a218bffc93a684a104a883648569accc3cd1f2bc7c506c6835a968b","m":["chatterbox"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.25.0-dev.20260209-a3749f1353/webgpu/+esm.js":{"n":114187,"h":"ff5a0c5e5d37e2f84298d6e5fb5b20f410e363bac7e4688e3aeb95be54c703b7","m":["chatterbox"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.mjs":{"n":53057,"h":"3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28","m":["zipvoice"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm":{"n":26781914,"h":"39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da","m":["zipvoice"]},"playground/vendor/jsdelivr/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.js":{"n":66417,"h":"7d65dad7eb4564ad98db9924a259af2e2c68ebfbdbf254fa5d728f1c5736e07a","m":["zipvoice"]},"playground/vendor/jsdelivr/npm/pinyin-pro@3.29.5/+esm.js":{"n":470405,"h":"e918fa78ada0a5f6b75e7f5db9134fbd96dba8393c5dff6dfb5aa90168246a9e","m":["f5"]},"web/runtime/sherpa-onnx-tts.js":{"n":33227,"h":"91bb4b3095ad4a449bb99518b15b4b31659886d808fd16656b6dce634405fcf1","m":["zipvoice"]},"https://huggingface.co/spaces/k2-fsa/web-assembly-zh-en-tts-zipvoice/resolve/a118980aaa8d985d10e57425c1fdc2301c05f4cc/sherpa-onnx-wasm-main-tts.data":{"n":204108836,"h":"0e2f08ed07e58a4970293252645f0fc92accc42dce40fad4a3e14a05c3f7fb21","m":["zipvoice"]},"web/runtime/sherpa-onnx-wasm-main-tts.js":{"n":111298,"h":"b8f1d2f26349561e8225a93a6b0ae9c11e4d9e9cd2df44a51fab960d90ce1a04","m":["zipvoice"]},"https://huggingface.co/spaces/k2-fsa/web-assembly-zh-en-tts-zipvoice/resolve/a118980aaa8d985d10e57425c1fdc2301c05f4cc/sherpa-onnx-wasm-main-tts.wasm":{"n":13473435,"h":"d60db5247fa13e92ad291f8cb5cfe2f6823934c0fa430b177724929a587ab9fb","m":["zipvoice"]},"https://huggingface.co/nsarang/F5-TTS-ONNX/resolve/2e7e47e103a565c85dcd32141b6b11eeeb57eee6/onnx/transformer_fp32.onnx":{"n":1321718282,"h":"c63aeb96953ccae551df6717d892f73a8408e59f1a6fe8edc2aed8063bd195b8","m":["f5"]}};              // site-relative path or absolute URL -> {n: bytes, h: sha256, m: [model ids]}
const BASE = new URL('./', self.location.href).href;
const abs = (p) => new URL(p, BASE).href;
const SHELL_URLS = new Set(SHELL.map(abs)), MODEL_FILES = Object.fromEntries(Object.entries(MODEL_FILES_REL).map(([k, v]) => [abs(k), v]));
const SHELL_CACHE = 'vs-shell-' + RELEASE, MODEL_CACHE = 'vs-models', SETTINGS = 'vs-settings', KEEP_KEY = abs('__vs/keep-models'), INDEX = abs('playground/index.html');

// Model-file integrity for the GitHub Pages release (issue #14): no model file reaches ONNX Runtime, the Emscripten loader or Transformers.js unless its
// size and sha256 match the release. The verified stream passes bytes through as they arrive (download progress keeps working, memory stays at one chunk)
// but holds back the last chunk until the whole file has been hashed; on a mismatch the stream errors instead, so the consumer never has the complete file.
//   service worker: build.mjs inlines this file into sw.js, which gates every model download it answers (and keeps only verified copies);
//   model workers:  importScripts('verify.js') / import './verify.js', then vsVerify.installFetch(hosting.integrity, <site URL>) gates the downloads that did not come
//                   through the service worker (hard reload, page not yet controlled, browser without service workers). A response the service worker
//                   already gated carries x-vs-sha256, which a cross-origin host cannot expose to us, and is not hashed twice.
// WebCrypto's digest() needs the whole file in memory (model files are up to 660 MB), hence the incremental SHA-256. Tested by deploy/ghpages/test_unit.mjs.
(() => {
function sha256Stream() {
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354,
    0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Int32Array(64), tail = new Uint8Array(64); let tailLen = 0, total = 0;
  function block(p, o) {
    for (let i = 0; i < 16; i++, o += 4) W[i] = p[o] << 24 | p[o + 1] << 16 | p[o + 2] << 8 | p[o + 3];
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      W[i] = ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3) + W[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10) + W[i - 16] | 0;
    }
    let a = H[0] | 0, b = H[1] | 0, c = H[2] | 0, d = H[3] | 0, e = H[4] | 0, f = H[5] | 0, g = H[6] | 0, h = H[7] | 0;
    for (let i = 0; i < 64; i++) {
      const t1 = h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + (e & f ^ ~e & g) + K[i] + W[i] | 0;
      const t2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0;
      h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return {
    update(u8) {
      let i = 0; total += u8.length;
      if (tailLen) { i = Math.min(64 - tailLen, u8.length); tail.set(u8.subarray(0, i), tailLen); tailLen += i; if (tailLen < 64) return; block(tail, 0); tailLen = 0; }
      for (; i + 64 <= u8.length; i += 64) block(u8, i);
      if (i < u8.length) { tail.set(u8.subarray(i), 0); tailLen = u8.length - i; }
    },
    hex() {
      const bits = total * 8, pad = new Uint8Array((tailLen < 56 ? 64 : 128) - tailLen); pad[0] = 0x80;
      const v = new DataView(pad.buffer); v.setUint32(pad.length - 8, Math.floor(bits / 0x100000000)); v.setUint32(pad.length - 4, bits >>> 0);
      total -= pad.length; this.update(pad);
      return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
    },
  };
}

// body: ReadableStream of exactly f.n bytes with sha256 f.h, else it errors (after calling onBad(reason)) before delivering the last chunk.
function verified(body, f, label, onBad) {
  const hash = sha256Stream(); let n = 0, held = null;
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { hash.update(chunk); n += chunk.length; if (n > f.n) throw fail(`larger than the release (${f.n} bytes)`); if (held) ctl.enqueue(held); held = chunk; },
    flush(ctl) {
      if (n !== f.n) throw fail(`incomplete download (${n} of ${f.n} bytes)`);
      const got = hash.hex();
      if (got !== f.h) throw fail(`sha256 ${got.slice(0, 12)}… does not match the release (${f.h.slice(0, 12)}…)`);
      if (held) ctl.enqueue(held);
    },
  }));
  function fail(reason) { onBad?.(reason); return new Error(`Integrity check failed for ${label}: ${reason}. The file was not used.`); }
}

// Wraps this worker's fetch(): GET 200 responses for files in the release's integrity map (hosting.json "integrity": site-relative path or absolute URL ->
// {n: bytes, h: sha256}) get a verified body. Not installed in development (no hosting.json); every other URL is untouched.
function installFetch(integrity, siteBase) {
  if (!integrity || self.fetch.vsVerified) return false;
  const files = Object.fromEntries(Object.entries(integrity).map(([k, v]) => [new URL(k, siteBase).href, v])), native = self.fetch.bind(self);
  const fetch = async (input, init) => {
    const resp = await native(input, init), req = input instanceof Request ? input : null;
    const u = new URL(req ? req.url : String(input), self.location.href); u.hash = '';
    const f = files[u.href], method = (init?.method || req?.method || 'GET').toUpperCase();
    if (!f || method !== 'GET' || resp.status !== 200 || !resp.body) return resp;
    const name = decodeURIComponent(u.pathname.split('/').pop());
    if (resp.headers.get('x-vs-sha256') === f.h) { stats.byServiceWorker.push(name); return resp; }
    stats.byWorker.push(name);
    return new Response(verified(resp.body, f, name), {status: resp.status, statusText: resp.statusText, headers: resp.headers});
  };
  fetch.vsVerified = true; self.fetch = fetch;
  return true;
}

const stats = {byServiceWorker: [], byWorker: []};   // which gate verified each model file this worker fetched (read by deploy/ghpages/test_site.mjs)
self.vsVerify = {sha256Stream, verified, installFetch, stats};
})();


self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll([...SHELL_URLS].map((u) => new Request(u, {cache: 'reload'}))))));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('vs-shell-') && k !== SHELL_CACHE) await caches.delete(k);
  const mc = await caches.open(MODEL_CACHE);
  for (const req of await mc.keys()) {           // drop copies this release does not use, or whose content changed
    const f = MODEL_FILES[req.url], r = f && await mc.match(req);
    if (!f || !r || r.headers.get('x-vs-sha256') !== f.h) await mc.delete(req);
  }
  await self.clients.claim();
})()));

let keep = null;
async function keepModels() {
  if (keep === null) { const r = await (await caches.open(SETTINGS)).match(KEEP_KEY); keep = r ? (await r.text()) === '1' : true; }
  return keep;
}
const sameFile = (r, f) => r && r.headers.get('x-vs-sha256') === f.h;
const name = (url) => decodeURIComponent(url.split('/').pop());
async function notify(msg) { for (const c of await self.clients.matchAll({includeUncontrolled: true})) c.postMessage({...msg, source: 'vs-sw'}); }

// Stores the second branch of the verified download. Never fatal for the page (quota, eviction, private mode); a file that fails verification errors this
// branch too, so it is never kept (the gate reports it to the page).
async function store(url, f, body, headers, failed) {
  const c = await caches.open(MODEL_CACHE);
  try {
    const h = new Headers(headers); h.set('x-vs-sha256', f.h); h.set('x-vs-release', RELEASE); h.set('content-length', String(f.n)); h.delete('content-encoding'); h.delete('vary');
    await c.put(url, new Response(body, {status: 200, headers: h}));
    notify({type: 'cached', path: name(url), url});
  } catch (err) { await c.delete(url).catch(() => {}); if (!failed()) notify({type: 'cache-error', path: name(url), url, message: String(err && (err.name + ': ' + err.message))}); }
}

// Issue #14: the model worker gets the download through vsVerify.verified() (verify.js): bytes pass as they arrive, but the last chunk only once size and
// sha256 match the release; otherwise the worker's download fails, so ONNX Runtime never receives an unverified file. x-vs-sha256 tells the worker's own
// fetch gate that this response is already verified. Kept copies are written from the same verified stream.
async function modelFile(e, url, f) {
  const c = await caches.open(MODEL_CACHE), hit = await c.match(url);
  if (sameFile(hit, f)) {
    if (e.request.method === 'HEAD') return new Response(null, {status: 200, headers: hit.headers});
    return hit;
  }
  // Cross-origin HEAD (the page's offline check) is answered from this device only: never a request to the model host just to ask.
  if (e.request.method === 'HEAD' && !url.startsWith(BASE)) return new Response(null, {status: 504, statusText: 'not saved on this device'});
  const resp = await fetch(e.request);
  if (e.request.method !== 'GET' || resp.status !== 200 || !resp.body) return resp;
  let bad = false;
  const body = vsVerify.verified(resp.body, f, name(url), (message) => { bad = true; notify({type: 'integrity-error', path: name(url), url, models: f.m, message}); });
  const h = new Headers(resp.headers); h.set('x-vs-sha256', f.h);
  if (!await keepModels()) return new Response(body, {status: 200, statusText: resp.statusText, headers: h});
  const [a, b] = body.tee(); e.waitUntil(store(url, f, b, resp.headers, () => bad));
  return new Response(a, {status: 200, statusText: resp.statusText, headers: h});
}
async function shellFile(req) {
  const hit = await caches.match(req.url, {cacheName: SHELL_CACHE});
  if (hit) return req.method === 'HEAD' ? new Response(null, {status: 200, headers: hit.headers}) : hit;
  return fetch(req);
}
async function page(req) {   // network first, so a new release is picked up; the cached shell when offline
  try { return await fetch(req); }
  catch (err) {
    const u = new URL(req.url); u.search = ''; u.hash = '';
    if (u.href === BASE || u.href === abs('index.html')) return Response.redirect(abs('playground/'), 302);
    const hit = await caches.match(u.href.endsWith('/') ? u.href + 'index.html' : u.href, {cacheName: SHELL_CACHE}) || await caches.match(INDEX, {cacheName: SHELL_CACHE});
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.headers.has('range') || !['GET', 'HEAD'].includes(req.method)) return;
  if (req.mode === 'navigate') { if (req.url.startsWith(BASE)) e.respondWith(page(req)); return; }
  const u = new URL(req.url); u.hash = '';
  const f = MODEL_FILES[u.href];
  if (f) return e.respondWith(modelFile(e, u.href, f));
  u.search = '';
  if (SHELL_URLS.has(u.href)) return e.respondWith(shellFile(req));
});

// Storage panel (My creations): usage per model, removal, and the keep setting. Replies on the MessageChannel port.
self.addEventListener('message', (e) => {
  const reply = (d) => e.ports[0]?.postMessage(d), d = e.data || {};
  e.waitUntil((async () => {
    if (d.type === 'keep') { keep = !!d.on; await (await caches.open(SETTINGS)).put(KEEP_KEY, new Response(keep ? '1' : '0')); }
    if (d.type === 'clear') {
      const c = await caches.open(MODEL_CACHE);
      for (const req of await c.keys()) { const f = MODEL_FILES[req.url]; if (!d.model || (f && f.m.includes(d.model))) await c.delete(req); }
    }
    const c = await caches.open(MODEL_CACHE), models = {};
    for (const req of await c.keys()) { const f = MODEL_FILES[req.url]; if (!f) continue;
      for (const m of f.m) { const x = models[m] ??= {bytes: 0, files: 0}; x.bytes += f.n; x.files++; } }
    reply({release: RELEASE, keep: await keepModels(), models});
  })());
});
