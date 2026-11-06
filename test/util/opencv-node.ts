// Vitest loads ESM dependencies via dynamic import(); OpenCV.js's module
// object exposes `then`, so the namespace would be treated as a promise and
// hang. Loading it through Node's require() sidesteps that.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Test the slim build when one is checked in (see scripts/opencv/build.sh).
const slim = fileURLToPath(new URL('../../vendor/opencv/opencv.js', import.meta.url));
export default require(existsSync(slim) ? slim : '@techstark/opencv-js');
