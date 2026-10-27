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
