# /// script
# dependencies = ["onnx", "numpy", "onnxconverter-common"]
# ///
"""Rewrite the dynamically-quantized decoder into a float model WebGPU can run:
  DynamicQuantizeLinear(A) -> MatMulInteger(A_q, W_q, A_zp, W_zp) -> Cast -> Mul(A_s * W_s)
  ==>  MatMul(A, W_f),  W_f = (W_q - W_zp) * W_s     (same int8 weights, dequantized; no retraining)
usage: uv run dequantize.py in.onnx out_fp32.onnx [out_fp16.onnx]"""
import sys, numpy as np, onnx
from onnx import numpy_helper, helper
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src); g = m.graph
init = {t.name: t for t in g.initializer}
prod = {o: n for n in g.node for o in n.output}
cons = {}
for n in g.node:
    for i in n.input: cons.setdefault(i, []).append(n)
arr = lambda name: numpy_helper.to_array(init[name])

new_inits, replace = [], {}  # replace: id(final Mul node) -> new MatMul node
for n in g.node:
    if n.op_type != "MatMulInteger": continue
    aq, wq, _azp, wzp = n.input
    dql = prod[aq]; assert dql.op_type == "DynamicQuantizeLinear"
    cast = cons[n.output[0]]; assert len(cast) == 1 and cast[0].op_type == "Cast"
    mul = cons[cast[0].output[0]]; assert len(mul) == 1 and mul[0].op_type == "Mul"
    scale_mul = prod[[i for i in mul[0].input if i != cast[0].output[0]][0]]  # Mul(A_scale, W_scale)
    w_scale = [i for i in scale_mul.input if i in init][0]
    Wf = (arr(wq).astype(np.float32) - arr(wzp).astype(np.float32)) * arr(w_scale).astype(np.float32)
    wname = wq + "_dequant"
    new_inits.append(numpy_helper.from_array(Wf.astype(np.float32), wname))
    replace[id(mul[0])] = helper.make_node("MatMul", [dql.input[0], wname], [mul[0].output[0]], name=n.name.replace("_quant", "_float"))

nodes = [replace.get(id(n), n) for n in g.node]
# prune nodes whose outputs are no longer used (DQL, MatMulInteger, Cast, scale Mul) and unused initializers;
# inputs referenced inside If subgraphs (recursively) count as used
def sub_inputs(n):
    s = set()
    for a in n.attribute:
        if a.type == onnx.AttributeProto.GRAPH:
            for sn in a.g.node: s |= set(sn.input) | sub_inputs(sn)
    return s
graph_outputs = {o.name for o in g.output}
while True:
    used = {i for n in nodes for i in n.input} | set().union(*(sub_inputs(n) for n in nodes)) | graph_outputs
    keep = [n for n in nodes if any(o in used for o in n.output)]
    if len(keep) == len(nodes): break
    nodes = keep
del g.node[:]; g.node.extend(nodes)
inits = [t for t in list(g.initializer) + new_inits if t.name in used]
del g.initializer[:]; g.initializer.extend(inits)
onnx.checker.check_model(m, full_check=False) if m.ByteSize() < 2**31 - 1 else None
onnx.save(m, dst)
print("rewrote", len(replace), "MatMulInteger;", "remaining MatMulInteger/DQL:",
      sum(n.op_type in ("MatMulInteger", "DynamicQuantizeLinear") for n in g.node), "nodes", len(g.node))
if len(sys.argv) > 3:
    from onnxconverter_common import float16
    m16 = float16.convert_float_to_float16(m, keep_io_types=True)
    onnx.save(m16, sys.argv[3]); print("saved fp16", sys.argv[3])
