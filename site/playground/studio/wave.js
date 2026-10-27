// Waveform helpers shared by Compare and My creations (same look as the Create player in ux/ux.js: rounded bars, accent gradient, dimmed after the playhead).
export function peaks(samples, n = 96) {   // -> plain array of n values in 0..1 (small enough to keep with a creation instead of the samples)
  const out = new Array(n).fill(0), step = Math.max(1, Math.floor(samples.length / n)); let mx = 1e-6;
  for (let i = 0; i < n; i++) { let p = 0; const a = i * step, b = Math.min(samples.length, a + step); for (let j = a; j < b; j++) { const v = Math.abs(samples[j]); if (v > p) p = v; } out[i] = p; if (p > mx) mx = p; }
  return out.map((v) => +Math.pow(v / mx, .7).toFixed(3));
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export function paint(cv, pk, played = 0) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth || 300, h = +cv.getAttribute('height') || 48;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = h * dpr; }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const n = pk.length, gap = 2, bw = Math.max(1.5, (w - gap * (n - 1)) / n), g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, css('--accent')); g.addColorStop(1, css('--accent-2'));
  for (let i = 0; i < n; i++) {
    const hh = Math.max(2, pk[i] * (h - 6)), x = i * (bw + gap), y = (h - hh) / 2;
    c.globalAlpha = played <= 0 || i / n < played ? 1 : .28; c.fillStyle = g; c.beginPath(); c.roundRect(x, y, bw, hh, bw / 2); c.fill();
  }
  c.globalAlpha = 1;
}
