# /// script
# dependencies = ["onnx", "numpy", "onnxruntime"]
# ///
"""Split the ZipVoice WebGPU decoder (decoder.dq.fp32.onnx, sha256 cff04e09…) into
   1. a weight-free graph   decoder.dq.graph.onnx   (large tensors point to external data "decoder.dq.weights")
   2. a byte recipe          decoder.dq.recipe.json  (how to rebuild decoder.dq.weights from the upstream INT8 decoder)
so the browser can rebuild the exact FP32 weights from decoder.int8.onnx, which it already downloads inside the sherpa-onnx
.data bundle (byte-identical to k2-fsa/ZipVoice zipvoice_distill/fm_decoder_int8.onnx). Nothing derived from the weights
has to be hosted except this graph and recipe.

Recipe ops, all offsets in bytes:
  copy  [dst, src, len]                 dst[dst:dst+len] = int8_file[src:src+len]                       (FP32 tensors that are unchanged)
  dq    [dst, src, count, zp, scale]    f32(dst)[i] = f32((int8(int8_file[src+i]) - zp) * scale)       (dequantize.py: W_f = (W_q - W_zp) * W_s)
The rebuilt buffer is checked here against the external-data file (sha256 in the recipe), the browser checks the same sha256,
and the split model is run against the original with onnxruntime to show bit-identical outputs.

usage: uv run deploy/ghpages/decoder_recipe.py models/webgpu/decoder.dq.fp32.onnx models/zipvoice-bundle/decoder.int8.onnx models/webgpu/
"""
import hashlib, json, os, sys
import numpy as np, onnx
from onnx import numpy_helper

dq_path, int8_path, out_dir = sys.argv[1:4]
WEIGHTS, THRESHOLD, ALIGN = 'decoder.dq.weights', 1024, 64
int8_bytes = open(int8_path, 'rb').read()
sha = lambda b: hashlib.sha256(b).hexdigest()

def all_tensors(g):   # initializers and Constant/attribute tensors, recursively into subgraphs
    for t in g.initializer: yield t
    for n in g.node:
        for a in n.attribute:
            if a.type == onnx.AttributeProto.TENSOR: yield a.t
            elif a.type == onnx.AttributeProto.TENSORS: yield from a.tensors
            elif a.type == onnx.AttributeProto.GRAPH: yield from all_tensors(a.g)
            elif a.type == onnx.AttributeProto.GRAPHS:
                for sg in a.graphs: yield from all_tensors(sg)

# int8 side: for each MatMulInteger weight, its zero point and scale (same pattern dequantize.py rewrites)
q = onnx.load(int8_path); qg = q.graph
qinit = {t.name: t for t in qg.initializer}
prod = {o: n for n in qg.node for o in n.output}
cons = {}
for n in qg.node:
    for i in n.input: cons.setdefault(i, []).append(n)
dq_src = {}
for n in qg.node:
    if n.op_type != 'MatMulInteger': continue
    _, wq, _, wzp = n.input
    cast = cons[n.output[0]][0]; mul = cons[cast.output[0]][0]
    scale_mul = prod[[i for i in mul.input if i != cast.output[0]][0]]
    w_scale = [i for i in scale_mul.input if i in qinit][0]
    zp, sc = numpy_helper.to_array(qinit[wzp]), numpy_helper.to_array(qinit[w_scale])
    assert zp.size == 1 and sc.size == 1, 'only per-tensor quantisation is handled'
    assert qinit[wq].data_type == onnx.TensorProto.INT8 and qinit[wq].raw_data
    dq_src[wq + '_dequant'] = (qinit[wq].raw_data, int(zp.reshape(())), np.float32(sc.reshape(())))

m = onnx.load(dq_path)
weights, ops_copy, ops_dq, moved = bytearray(), [], [], 0
# Only main-graph initializers become external data: onnxruntime-web resolves mounted external data (InferenceSession externalData) for initializers,
# but not for Constant-node attribute tensors ("external data path could not be canonicalized"), so those stay inline in the graph.
for t in m.graph.initializer:
    raw = t.raw_data
    if len(raw) <= THRESHOLD: continue
    weights.extend(b'\0' * (-len(weights) % ALIGN)); dst = len(weights); weights.extend(raw)
    if t.name in dq_src:
        qraw, zp, sc = dq_src[t.name]
        src = int8_bytes.find(qraw); assert src >= 0
        w = ((np.frombuffer(qraw, np.int8).astype(np.float32) - np.float32(zp)) * sc).astype(np.float32)
        assert w.tobytes() == raw, f'dequantisation does not reproduce {t.name}'
        ops_dq.append([dst, src, len(qraw), zp, float(sc)])
    else:
        src = int8_bytes.find(raw); assert src >= 0, f'{t.name}: bytes not found in the INT8 decoder'
        ops_copy.append([dst, src, len(raw)])
    t.ClearField('raw_data'); t.data_location = onnx.TensorProto.EXTERNAL
    del t.external_data[:]
    for k, v in (('location', WEIGHTS), ('offset', str(dst)), ('length', str(len(raw)))):
        e = t.external_data.add(); e.key, e.value = k, v
    moved += 1
weights = bytes(weights)

# Rebuild exactly like the browser does (playground/workers/zipvoice-decoder.js) and compare.
rebuilt = bytearray(len(weights)); i8 = np.frombuffer(int8_bytes, np.int8)
for dst, src, n in ops_copy: rebuilt[dst:dst + n] = int8_bytes[src:src + n]
for dst, src, n, zp, sc in ops_dq:
    rebuilt[dst:dst + 4 * n] = ((i8[src:src + n].astype(np.float32) - np.float32(zp)) * np.float32(sc)).astype(np.float32).tobytes()
assert bytes(rebuilt) == weights, 'recipe does not rebuild the weights'

os.makedirs(out_dir, exist_ok=True)
graph_path = os.path.join(out_dir, 'decoder.dq.graph.onnx')
onnx.save(m, graph_path)
open(os.path.join(out_dir, WEIGHTS), 'wb').write(weights)
graph_bytes = open(graph_path, 'rb').read()
recipe = {
    '_note': 'Generated by deploy/ghpages/decoder_recipe.py. Rebuilds decoder.dq.weights (external data of decoder.dq.graph.onnx) from the upstream INT8 decoder.',
    'source': {'file': 'decoder.int8.onnx', 'bytes': len(int8_bytes), 'sha256': sha(int8_bytes),
               'upstream': 'k2-fsa/ZipVoice zipvoice_distill/fm_decoder_int8.onnx (also /decoder.int8.onnx inside sherpa-onnx-wasm-main-tts.data)'},
    'graph': {'file': 'decoder.dq.graph.onnx', 'bytes': len(graph_bytes), 'sha256': sha(graph_bytes)},
    'weights': {'file': WEIGHTS, 'bytes': len(weights), 'sha256': sha(weights)},
    'equivalentTo': {'file': 'decoder.dq.fp32.onnx', 'sha256': sha(open(dq_path, 'rb').read())},
    'copy': ops_copy, 'dq': ops_dq,
}
open(os.path.join(out_dir, 'decoder.dq.recipe.json'), 'w').write(json.dumps(recipe, separators=(',', ':')) + '\n')

# The split model must compute exactly what the original computes.
import onnxruntime as ort
rng = np.random.default_rng(0); T = 120
feeds = {'t': np.array(0.3, np.float32), 'x': rng.standard_normal((1, T, 100), np.float32),
         'text_condition': rng.standard_normal((1, T, 100), np.float32), 'speech_condition': rng.standard_normal((1, T, 100), np.float32),
         'guidance_scale': np.array(1.0, np.float32)}
so = ort.SessionOptions(); so.intra_op_num_threads = 1
a = ort.InferenceSession(dq_path, so, providers=['CPUExecutionProvider']).run(None, feeds)[0]
b = ort.InferenceSession(graph_path, so, providers=['CPUExecutionProvider']).run(None, feeds)[0]
print(f'moved {moved} tensors to external data ({len(ops_copy)} copied, {len(ops_dq)} dequantised); graph {len(graph_bytes)} B, weights {len(weights)} B')
print('weights sha256', recipe['weights']['sha256'])
print('onnxruntime CPU: original vs split outputs bit-identical:', a.tobytes() == b.tobytes(), 'max |diff|', float(np.abs(a - b).max()))
assert a.tobytes() == b.tobytes()
