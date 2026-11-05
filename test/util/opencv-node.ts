// Vitest loads ESM dependencies via dynamic import(); OpenCV.js's module
// object exposes `then`, so the namespace would be treated as a promise and
// hang. Loading it through Node's require() sidesteps that.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export default require('@techstark/opencv-js');
