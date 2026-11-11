// Per-frame feature extraction from MediaPipe Face Landmarker output.
// Pure functions (no DOM), so they can be unit-tested in Node.
//
// Why these features: blendshape scores are MediaPipe's own learned "how closed / where looking"
// estimates; EAR and iris offsets are geometric measurements that do not depend on that model.
// Giving the classifier both makes it more robust to one of them failing for a given person
// (e.g. drooping eyelids fool the blink blendshape but not the iris position).

// Blendshape channels we keep (names verified against MediaPipe 0.10.21 output on 2026-10-01).
export const BLENDSHAPE_CHANNELS = [
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'browInnerUp', 'browDownLeft', 'browDownRight',
];

export const GEOMETRIC_CHANNELS = [
  'earA', 'earB',          // eye aspect ratio of the two eyes (A = image-left eye, B = image-right eye)
  'irisXA', 'irisYA',      // iris centre offset inside eye A, in units of eye width
  'irisXB', 'irisYB',
  'headYaw', 'headPitch',  // crude head-pose proxies from nose position
];

export const FEATURE_NAMES = [...BLENDSHAPE_CHANNELS, ...GEOMETRIC_CHANNELS];
export const NUM_FEATURES = FEATURE_NAMES.length;

// FaceMesh landmark indices. Eye A = landmarks 33/133 (appears on the image's left),
// eye B = 263/362. EAR pairs follow Soukupová & Čech (2016): (p2,p6), (p3,p5) over (p1,p4).
const EYE_A = { outer: 33, inner: 133, pairs: [[160, 144], [158, 153], [159, 145]] };
const EYE_B = { outer: 263, inner: 362, pairs: [[385, 380], [387, 373], [386, 374]] };
const IRIS_CENTRES = [468, 473]; // assigned to eyes by proximity, so we never depend on the convention
const NOSE_TIP = 1, CHEEK_A = 234, CHEEK_B = 454, CHIN = 152;

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

function eyeAspectRatio(lm, eye) {
  const width = dist(lm[eye.outer], lm[eye.inner]);
  if (width < 1e-6) return 0;
  const heights = eye.pairs.map(([a, b]) => dist(lm[a], lm[b]));
  return heights.reduce((s, h) => s + h, 0) / (heights.length * width);
}

function eyeCentre(lm, eye) {
  return { x: (lm[eye.outer].x + lm[eye.inner].x) / 2, y: (lm[eye.outer].y + lm[eye.inner].y) / 2 };
}

// Iris offset relative to the eye centre, normalised by eye width so it is distance-invariant.
function irisOffset(lm, eye, iris) {
  const c = eyeCentre(lm, eye);
  const w = dist(lm[eye.outer], lm[eye.inner]) || 1e-6;
  return [(iris.x - c.x) / w, (iris.y - c.y) / w];
}

/**
 * Turn one Face Landmarker result into a fixed-length feature vector.
 * @param {Array<{x:number,y:number,z:number}>} landmarks 478 normalised landmarks of one face
 * @param {Array<{categoryName:string,score:number}>} blendshapes the face's blendshape categories
 * @returns {Float32Array|null} NUM_FEATURES values, or null if input is incomplete
 */
export function extractFeatures(landmarks, blendshapes) {
  if (!landmarks || landmarks.length < 478 || !blendshapes) return null;
  const out = new Float32Array(NUM_FEATURES);
  const scores = Object.create(null);
  for (const b of blendshapes) scores[b.categoryName] = b.score;
  BLENDSHAPE_CHANNELS.forEach((name, i) => { out[i] = scores[name] ?? 0; });

  let k = BLENDSHAPE_CHANNELS.length;
  out[k++] = eyeAspectRatio(landmarks, EYE_A);
  out[k++] = eyeAspectRatio(landmarks, EYE_B);

  // Give each eye the iris centre closest to it.
  const cA = eyeCentre(landmarks, EYE_A);
  const [i0, i1] = IRIS_CENTRES.map(i => landmarks[i]);
  const [irisA, irisB] = dist(i0, cA) <= dist(i1, cA) ? [i0, i1] : [i1, i0];
  const [axA, ayA] = irisOffset(landmarks, EYE_A, irisA);
  const [axB, ayB] = irisOffset(landmarks, EYE_B, irisB);
  out[k++] = axA; out[k++] = ayA; out[k++] = axB; out[k++] = ayB;

  // Head pose proxies: horizontal nose offset between cheeks, vertical nose position between eyes and chin.
  const nose = landmarks[NOSE_TIP], ca = landmarks[CHEEK_A], cb = landmarks[CHEEK_B], chin = landmarks[CHIN];
  const faceW = dist(ca, cb) || 1e-6;
  out[k++] = (nose.x - (ca.x + cb.x) / 2) / faceW;
  const cB = eyeCentre(landmarks, EYE_B);
  const eyesY = (cA.y + cB.y) / 2;
  out[k++] = (nose.y - eyesY) / ((chin.y - eyesY) || 1e-6);
  return out;
}

// Landmark indices worth drawing on the overlay (eye contours + iris centres).
export const OVERLAY_POINTS = [
  EYE_A.outer, EYE_A.inner, ...EYE_A.pairs.flat(),
  EYE_B.outer, EYE_B.inner, ...EYE_B.pairs.flat(),
  ...IRIS_CENTRES,
];
