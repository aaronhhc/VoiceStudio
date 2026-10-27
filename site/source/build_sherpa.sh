#!/usr/bin/env bash
# Rebuild the patched sherpa-onnx (v1.13.8 + sherpa-onnx-zipvoice-split.patch) used by experiments/webgpu/hybrid.
# Everything lands in .toolchain/ (git-ignored). Needs: git, python3, uv, ~3 GB disk. ~10 min on an M5 Pro.
#   ./experiments/webgpu/build_sherpa.sh          # WASM runtime -> experiments/webgpu/hybrid/runtime/
#   ./experiments/webgpu/build_sherpa.sh native   # + native C API lib and zv_split_test (validation)
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD; TC=$ROOT/.toolchain; mkdir -p "$TC"
[ -d "$TC/emsdk" ] || git clone -q https://github.com/emscripten-core/emsdk.git "$TC/emsdk"
(cd "$TC/emsdk" && ./emsdk install 4.0.23 >/dev/null && ./emsdk activate 4.0.23 >/dev/null)
[ -x "$TC/cmakevenv/bin/cmake" ] || { uv venv -q "$TC/cmakevenv" && uv pip install -q --python "$TC/cmakevenv" cmake ninja; }
export PATH=$TC/cmakevenv/bin:$PATH
if [ ! -d "$TC/sherpa-onnx" ]; then
  git clone -q --depth 1 --branch v1.13.8 https://github.com/k2-fsa/sherpa-onnx.git "$TC/sherpa-onnx"
  git -C "$TC/sherpa-onnx" apply "$ROOT/experiments/webgpu/sherpa-onnx-zipvoice-split.patch"
fi
[ -f models/zipvoice-bundle/tokens.txt ] || python3 scripts/extract-bundle.py
cp -R models/zipvoice-bundle/. "$TC/sherpa-onnx/wasm/tts/assets/"
(cd "$TC/sherpa-onnx" && source "$TC/emsdk/emsdk_env.sh" >/dev/null 2>&1 && ./build-wasm-simd-tts.sh > wasm-build.log 2>&1)
OUT=experiments/webgpu/hybrid/runtime; mkdir -p $OUT
cp "$TC"/sherpa-onnx/build-wasm-simd-tts/install/bin/wasm/tts/sherpa-onnx-wasm-main-tts.{js,wasm,data} $OUT/
# the HF Space build selects the model type by editing this line; 4 = ZipVoice
sed 's/^let modelType = 0;/let modelType = 4;  \/\/ zipvoice/' "$TC/sherpa-onnx/wasm/tts/sherpa-onnx-tts.js" > $OUT/sherpa-onnx-tts.js
echo "WASM runtime -> $OUT"
if [ "${1:-}" = native ]; then
  B=$TC/sherpa-onnx/build-native; mkdir -p "$B"
  (cd "$B" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DSHERPA_ONNX_ENABLE_C_API=ON \
     -DSHERPA_ONNX_ENABLE_PYTHON=OFF -DSHERPA_ONNX_ENABLE_TESTS=OFF -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
     -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF -DSHERPA_ONNX_ENABLE_BINARY=OFF -DSHERPA_ONNX_ENABLE_JNI=OFF .. >/dev/null && ninja sherpa-onnx-c-api >/dev/null)
  clang++ -std=c++17 -O2 -I"$TC/sherpa-onnx" -I"$B/_deps/onnxruntime-src/include" experiments/webgpu/native/zv_split_test.cc \
    -L"$B/lib" -lsherpa-onnx-c-api -L"$B/_deps/onnxruntime-src/lib" -lonnxruntime \
    -Wl,-rpath,"$B/lib" -Wl,-rpath,"$B/_deps/onnxruntime-src/lib" -o "$B/zv_split_test"
  echo "native test -> $B/zv_split_test"
fi
