#!/usr/bin/env bash
# Reproducible build of the patched onnxruntime-web WASM runtime used by Transformers.js 4.0.0-next.2 for Chatterbox.
# Pins: ONNX Runtime commit a3749f13536bd25e89ba8f8a5ae21e88b9337057 (= onnxruntime-web 1.25.0-dev.20260209-a3749f1353, the version Transformers.js
# resolves), emsdk 4.0.23 (the version that commit pins), CMake 3.31.6 + Ninja (as ONNX Runtime CI). Build flags = the official "simd + threads +
# WebGPU" CI step that produces ort-wasm-simd-threaded.asyncify.{mjs,wasm} (.github/workflows/linux-wasm-ci-build-and-test-workflow.yml).
# Only change: experiments/chatterbox-ort/ort-session-disable-mem-reuse.patch (an opt-in session config key, default off).
# Output: playground/ort-patched/ (git-ignored): ort-wasm-simd-threaded.asyncify.{mjs,wasm} + BUILD-INFO.txt
set -euo pipefail
# Physical paths (pwd -P), and never inside /tmp or /var on macOS: Emscripten keys its system-header cache on the toolchain path, and CMake rewrites
# /private/tmp/... to /tmp/... in its cache. Compiler processes then alternate between the two spellings, each wiping and regenerating the header cache,
# and the build fails with missing libc/libc++ headers. (Found while verifying a fresh-clone build in /tmp.)
HERE=$(cd "$(dirname "$0")" && pwd -P); ROOT=$(cd "$HERE/../.." && pwd -P); ORT=$ROOT/.ort; SRC=$ORT/src
case "$ROOT" in /private/tmp/*|/private/var/*|/tmp/*|/var/*) echo "Build from a checkout outside /tmp and /var (CMake and Emscripten disagree on symlinked paths there): $ROOT"; exit 1;; esac
COMMIT=a3749f13536bd25e89ba8f8a5ae21e88b9337057
mkdir -p "$ORT"
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"; git -C "$SRC" remote add origin https://github.com/microsoft/onnxruntime.git
  git -C "$SRC" fetch -q --depth 1 origin $COMMIT; git -C "$SRC" checkout -q FETCH_HEAD
  git -C "$SRC" submodule update --init --depth 1 cmake/external/onnx cmake/external/emsdk
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = $COMMIT ] || { echo "ORT source is not at $COMMIT"; exit 1; }
if ! git -C "$SRC" diff --quiet; then
  git -C "$SRC" diff | cmp -s - "$HERE/ort-session-disable-mem-reuse.patch" || { echo "ORT source has changes other than the patch; aborting"; exit 1; }
else
  git -C "$SRC" apply "$HERE/ort-session-disable-mem-reuse.patch"
fi
(cd "$SRC/cmake/external/emsdk" && [ -x upstream/emscripten/emcc ] || { ./emsdk install 4.0.23 && ./emsdk activate 4.0.23; })
[ -x "$ORT/tools/venv/bin/cmake" ] || { uv venv -q "$ORT/tools/venv" && uv pip install -q --python "$ORT/tools/venv" cmake==3.31.6 ninja; }
# Emscripten runs the Closure Compiler on the JS glue. Its bundled native binary is x86_64-only (fails on Apple silicon without Rosetta), so Emscripten
# falls back to the Java version: provide a local JDK (Temurin 21, arm64) instead of installing anything system-wide.
if [ "$(uname -sm)" = "Darwin arm64" ] && [ ! -x "$ORT/tools/jdk/Contents/Home/bin/java" ]; then
  mkdir -p "$ORT/tools/jdk"; curl -sfL "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse" | tar xz -C "$ORT/tools/jdk" --strip-components 1
fi
[ -x "$ORT/tools/jdk/Contents/Home/bin/java" ] && export JAVA_HOME="$ORT/tools/jdk/Contents/Home" && export PATH="$JAVA_HOME/bin:$PATH"
export PATH="$ORT/tools/venv/bin:$PATH"
cd "$SRC"
python3 tools/ci_build/build.py --build_dir "$ORT/build" --config Release --parallel --skip_submodule_sync \
  --build_wasm --enable_wasm_simd --enable_wasm_threads --use_webgpu --use_webnn --target onnxruntime_webassembly \
  --enable_wasm_api_exception_catching --skip_tests --cmake_generator Ninja
OUT=$ROOT/playground/ort-patched; mkdir -p "$OUT"
cp "$ORT/build/Release/ort-wasm-simd-threaded.asyncify.mjs" "$ORT/build/Release/ort-wasm-simd-threaded.asyncify.wasm" "$OUT/"
{ echo "onnxruntime $COMMIT + $(basename "$HERE")/ort-session-disable-mem-reuse.patch"; echo "emsdk 4.0.23, cmake $(cmake --version | head -1 | awk '{print $3}'), closure via $(java -version 2>&1 | head -1), built $(date -u +%FT%TZ) on $(uname -sm)";
  shasum -a 256 "$OUT"/ort-wasm-simd-threaded.asyncify.*; } > "$OUT/BUILD-INFO.txt"
cat "$OUT/BUILD-INFO.txt"
