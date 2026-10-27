// Rebuilds the ZipVoice WebGPU decoder's FP32 weights in the browser from the upstream INT8 decoder (see deploy/ghpages/decoder_recipe.py).
// The INT8 decoder (/decoder.int8.onnx, byte-identical to k2-fsa/ZipVoice zipvoice_distill/fm_decoder_int8.onnx) is already inside the sherpa-onnx
// .data bundle every ZipVoice backend downloads, so the 478 MB decoder.dq.fp32.onnx never has to be hosted or downloaded: the site serves only the
// weight-free graph (decoder.dq.graph.onnx) and this recipe. Both input and output are checked against the sha256 recorded in the recipe.
//   copy [dst, src, len]               out[dst..] = int8file[src..]                        unchanged FP32 tensors
//   dq   [dst, src, count, zp, scale]  f32(out)[i] = f32((int8(int8file[src+i]) - zp) * scale)   W_f = (W_q - W_zp) * W_s, as dequantize.py
// (q - zp) is an exact small integer and scale a float32, so the double product is exact and the Float32Array store rounds once, exactly like numpy's
// float32 arithmetic in dequantize.py: the result is byte-identical, not just close.
self.vsDecoder = {
  async sha256(u8) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map((b) => b.toString(16).padStart(2, '0')).join(''); },
  async build(int8, recipe, {verify = true} = {}) {
    const t0 = performance.now(), times = {};
    if (int8.length !== recipe.source.bytes) throw new Error(`decoder.int8.onnx is ${int8.length} bytes, expected ${recipe.source.bytes}`);
    if (verify) { const h = await this.sha256(int8); if (h !== recipe.source.sha256) throw new Error(`decoder.int8.onnx sha256 ${h.slice(0, 12)}… ≠ ${recipe.source.sha256.slice(0, 12)}…`); }
    times.verify_source_ms = performance.now() - t0;
    const out = new Uint8Array(recipe.weights.bytes), i8 = new Int8Array(int8.buffer, int8.byteOffset, int8.length);
    for (const [dst, src, n] of recipe.copy) out.set(int8.subarray(src, src + n), dst);
    for (const [dst, src, n, zp, scale] of recipe.dq) {
      const f = new Float32Array(out.buffer, dst, n);
      for (let i = 0; i < n; i++) f[i] = (i8[src + i] - zp) * scale;
    }
    times.rebuild_ms = performance.now() - t0 - times.verify_source_ms;
    if (verify) { const h = await this.sha256(out); if (h !== recipe.weights.sha256) throw new Error(`rebuilt decoder weights sha256 ${h.slice(0, 12)}… ≠ ${recipe.weights.sha256.slice(0, 12)}…`); }
    times.verify_weights_ms = performance.now() - t0 - times.verify_source_ms - times.rebuild_ms;
    return {weights: out, times};
  },
};
