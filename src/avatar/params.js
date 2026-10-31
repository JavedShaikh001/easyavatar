// Every avatar is fully described by this small, JSON-friendly object.
export const DEFAULTS = {
  name: 'My Avatar',
  style: 'anime', // 'anime' | 'real'
  faceScan: null, // { lm, uv, tex, skin } from the webcam scan
  // body (0..1, 0.5 = middle)
  build: 0.35, height: 0.5, headSize: 0.5, legs: 0.5,
  // face shape
  faceWidth: 0.5, faceLength: 0.5, jaw: 0.4, chin: 0.5,
  eyeSize: 0.55, eyeSpacing: 0.5, eyeOpen: 0.55, eyeTilt: 0.5, eyeY: 0.5,
  browHeight: 0.5, browAngle: 0.5, browThickness: 0.5,
  noseLength: 0.5, mouthWidth: 0.5, mouthY: 0.5, blush: 0.4,
  // colours
  skinColor: '#f7dcc8', hairColor: '#4a3226', eyeColor: '#7a4f2e',
  // hair
  hairStyle: 'bob', bangs: 'full', hairLength: 0.5, ahoge: false,
  // outfit
  top: 'tshirt', topColor: '#5b7cfa', bottom: 'pants', bottomColor: '#2e3a52',
  shoeColor: '#f2f2f2', socks: true, sockColor: '#f4f4f4',
};

export const SLIDERS = {
  face: [
    ['faceLength', 'Face length'], ['faceWidth', 'Face width'], ['jaw', 'Jaw width'], ['chin', 'Chin length'],
    ['eyeSize', 'Eye size'], ['eyeOpen', 'Eye openness'], ['eyeSpacing', 'Eye spacing'], ['eyeTilt', 'Eye tilt'], ['eyeY', 'Eye height'],
    ['browHeight', 'Brow height'], ['browAngle', 'Brow angle'], ['browThickness', 'Brow thickness'],
    ['noseLength', 'Nose'], ['mouthWidth', 'Mouth width'], ['mouthY', 'Mouth height'], ['blush', 'Blush'],
  ],
  body: [['height', 'Height'], ['headSize', 'Head size'], ['build', 'Body shape'], ['legs', 'Leg length']],
};

export const CHOICES = {
  style: [['anime', 'Anime'], ['real', 'Realistic']],
  hairStyle: [['short', 'Short'], ['bob', 'Bob'], ['long', 'Long'], ['ponytail', 'Ponytail']],
  bangs: [['full', 'Full'], ['side', 'Side swept'], ['parted', 'Parted']],
  top: [['tshirt', 'T-shirt'], ['long', 'Long sleeve'], ['tank', 'Tank top']],
  bottom: [['pants', 'Pants'], ['shorts', 'Shorts'], ['skirt', 'Skirt']],
};

export function normalizeParams(p) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (p && p[k] !== undefined && p[k] !== null) out[k] = p[k];
  for (const k of Object.keys(DEFAULTS)) if (typeof DEFAULTS[k] === 'number') out[k] = Math.max(0, Math.min(1, +out[k] || 0));
  return out;
}
