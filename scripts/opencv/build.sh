#!/usr/bin/env bash
# Builds a slim OpenCV.js for the scanner into vendor/opencv/opencv.js.
#
# Needs: git, cmake, python3, and Emscripten (emsdk) on PATH, e.g.
#   git clone https://github.com/emscripten-core/emsdk.git
#   ./emsdk/emsdk install 3.1.74 && ./emsdk/emsdk activate 3.1.74
#   source ./emsdk/emsdk_env.sh
# Then from the repository root:  scripts/opencv/build.sh [workdir]
#
# SIMD=1 adds WebAssembly SIMD (Safari 16.4+, Chrome 91+).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="${1:-$repo/.opencv-build}"
version=4.12.0
mkdir -p "$work"
if [ ! -d "$work/opencv" ]; then
  git clone --depth 1 --branch "$version" https://github.com/opencv/opencv.git "$work/opencv"
fi
extra=()
[ "${SIMD:-0}" = 1 ] && extra+=(--simd)
emcmake python3 "$work/opencv/platforms/js/build_js.py" "$work/build" \
  --build_wasm --config "$here/scanner.config.py" "${extra[@]}" \
  -DBUILD_opencv_dnn=OFF -DBUILD_opencv_photo=OFF -DBUILD_opencv_objdetect=OFF \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF
mkdir -p "$repo/vendor/opencv"
cp "$work/build/bin/opencv.js" "$repo/vendor/opencv/opencv.js"
# Same fix as the npm package: the wrapper assigns an undeclared global,
# which throws in strict-mode (ES module) code.
sed -i 's/^    Module = {};$/    var Module = {};/' "$repo/vendor/opencv/opencv.js"
grep -q 'var Module = {};' "$repo/vendor/opencv/opencv.js"
ls -l "$repo/vendor/opencv/opencv.js"
