// AudioWorklet for recorder.js: copies each microphone block to the main thread. A static file (not a blob: URL) so a strict Content-Security-Policy
// (script-src 'self') allows it.
class Tap extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor('tap', Tap);
