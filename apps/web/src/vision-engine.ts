export const SCENE_TAGS = [
  "exterior-front",
  "exterior-rear",
  "aerial",
  "kitchen",
  "dining",
  "living-room",
  "family-room",
  "primary-bedroom",
  "secondary-bedroom",
  "bathroom",
  "basement",
  "laundry",
  "office",
  "garage",
  "patio-deck",
  "pool",
  "community-amenities",
  "miscellaneous"
] as const;

export type SceneTag = (typeof SCENE_TAGS)[number];

export const PROBLEM_LABELS = [
  "TV on",
  "Ceiling fan moving",
  "Toilet lid up",
  "Trash visible",
  "Pets",
  "People",
  "Mirrors reflecting photographer",
  "Vehicles blocking exterior",
  "Dirty counters",
  "Clutter",
  "Personal photos",
  "Open cabinets",
  "Crooked blinds",
  "Lights off",
  "Burned-out bulbs",
  "Window glare"
] as const;

export type ProblemLabel = (typeof PROBLEM_LABELS)[number];

export type RecommendationAction = "keep" | "retake" | "edit" | "remove" | "move-earlier" | "move-later";

export interface VisionPhotoSignals {
  fileName: string;
  width: number;
  height: number;
  brightness: number;
  contrast: number;
  saturation: number;
  sharpness: number;
  edgeDensity: number;
  blueRatio: number;
  greenRatio: number;
  warmRatio: number;
  brightPixelRatio: number;
  darkPixelRatio: number;
}

export interface SceneDetection {
  label: SceneTag;
  confidence: number;
}

export interface PhotoQualityAnalysis {
  sharpness: number;
  noise: number;
  brightness: number;
  exposure: number;
  whiteBalance: number;
  contrast: number;
  dynamicRange: number;
  resolution: number;
  horizonLevel: number;
  lensDistortion: number;
  verticalCorrection: number;
  composition: number;
}

export interface MarketingAnalysis {
  heroImageScore: number;
  zillowAppeal: number;
  mlsAppeal: number;
  luxuryAppeal: number;
  emotionalImpact: number;
  clickLikelihood: number;
}

export interface ProblemDetection {
  label: ProblemLabel;
  detected: boolean;
  confidence: number;
}

export interface Recommendation {
  action: RecommendationAction;
  confidence: number;
  reason: string;
}

export interface VisionAnalysis {
  engineVersion: "director-vision-engine-v1";
  scene: SceneDetection;
  quality: PhotoQualityAnalysis;
  marketing: MarketingAnalysis;
  problems: ProblemDetection[];
  recommendations: Recommendation[];
}

const SCENE_KEYWORDS: Array<{ keywords: string[]; tag: SceneTag; confidence: number }> = [
  { keywords: ["front", "curb", "street", "exterior-front"], tag: "exterior-front", confidence: 0.91 },
  { keywords: ["rear", "back", "yard", "exterior-rear"], tag: "exterior-rear", confidence: 0.89 },
  { keywords: ["drone", "aerial", "bird"], tag: "aerial", confidence: 0.94 },
  { keywords: ["kitchen"], tag: "kitchen", confidence: 0.94 },
  { keywords: ["dining"], tag: "dining", confidence: 0.91 },
  { keywords: ["living"], tag: "living-room", confidence: 0.9 },
  { keywords: ["family", "greatroom", "great-room"], tag: "family-room", confidence: 0.9 },
  { keywords: ["primary", "master", "owner"], tag: "primary-bedroom", confidence: 0.9 },
  { keywords: ["bedroom", "bed", "guest"], tag: "secondary-bedroom", confidence: 0.86 },
  { keywords: ["bath", "toilet", "vanity"], tag: "bathroom", confidence: 0.9 },
  { keywords: ["basement", "lower-level"], tag: "basement", confidence: 0.89 },
  { keywords: ["laundry", "washer", "dryer"], tag: "laundry", confidence: 0.91 },
  { keywords: ["office", "study", "desk"], tag: "office", confidence: 0.89 },
  { keywords: ["garage"], tag: "garage", confidence: 0.92 },
  { keywords: ["patio", "deck", "porch"], tag: "patio-deck", confidence: 0.88 },
  { keywords: ["pool", "spa"], tag: "pool", confidence: 0.93 },
  { keywords: ["community", "amenity", "clubhouse", "gym", "hoa"], tag: "community-amenities", confidence: 0.9 }
];

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalize(value: number, min: number, max: number): number {
  if (value <= min) {
    return 0;
  }
  if (value >= max) {
    return 100;
  }
  return ((value - min) / (max - min)) * 100;
}

function tokenizedName(fileName: string): string {
  return fileName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function detectScene(signals: VisionPhotoSignals): SceneDetection {
  const fileTokens = tokenizedName(signals.fileName);
  for (const rule of SCENE_KEYWORDS) {
    if (rule.keywords.some((keyword) => fileTokens.includes(keyword))) {
      return {
        label: rule.tag,
        confidence: rule.confidence
      };
    }
  }

  const landscape = signals.width >= signals.height;

  if (signals.greenRatio > 0.36 && landscape) {
    return { label: "patio-deck", confidence: 0.73 };
  }
  if ((signals.blueRatio > 0.24 || signals.greenRatio > 0.22) && signals.brightness > 0.48 && landscape) {
    return { label: "exterior-front", confidence: 0.72 };
  }
  if (signals.warmRatio > 0.34 && signals.edgeDensity > 0.11 && signals.brightness > 0.42) {
    return { label: "kitchen", confidence: 0.69 };
  }
  if (signals.saturation < 0.2 && signals.brightness > 0.52 && signals.contrast > 0.08) {
    return { label: "bathroom", confidence: 0.67 };
  }
  if (signals.darkPixelRatio > 0.22 && signals.edgeDensity < 0.12 && signals.brightness < 0.5) {
    return { label: "primary-bedroom", confidence: 0.65 };
  }
  if (signals.edgeDensity > 0.08) {
    return { label: "living-room", confidence: 0.6 };
  }

  return {
    label: "miscellaneous",
    confidence: 0.52
  };
}

function quality(signals: VisionPhotoSignals): PhotoQualityAnalysis {
  const exposurePenalty = (signals.brightPixelRatio + signals.darkPixelRatio) * 170;
  const whiteBalanceDelta = Math.abs(signals.blueRatio - signals.warmRatio) * 120;
  const megapixels = (signals.width * signals.height) / 1_000_000;

  return {
    sharpness: clamp(normalize(signals.sharpness, 5, 70)),
    noise: clamp(100 - normalize(signals.edgeDensity * (1 - signals.saturation), 0.01, 0.25)),
    brightness: clamp(100 - Math.abs(signals.brightness - 0.56) * 180),
    exposure: clamp(100 - exposurePenalty),
    whiteBalance: clamp(100 - whiteBalanceDelta),
    contrast: clamp(normalize(signals.contrast, 0.03, 0.25)),
    dynamicRange: clamp(normalize(signals.contrast + (1 - Math.abs(signals.brightPixelRatio - signals.darkPixelRatio)), 0.5, 1.15)),
    resolution: clamp(normalize(megapixels, 0.9, 12.0)),
    horizonLevel: clamp(signals.width > signals.height ? 90 : 62),
    lensDistortion: clamp(100 - Math.abs(signals.width / Math.max(signals.height, 1) - 1.5) * 55),
    verticalCorrection: clamp(signals.width > signals.height ? 88 : 56),
    composition: clamp(
      normalize(signals.contrast, 0.03, 0.24) * 0.35 +
        normalize(signals.edgeDensity, 0.03, 0.2) * 0.2 +
        (100 - Math.abs(signals.brightness - 0.56) * 180) * 0.45
    )
  };
}

function marketing(scene: SceneDetection, q: PhotoQualityAnalysis): MarketingAnalysis {
  const qualityBlend =
    q.sharpness * 0.16 +
    q.exposure * 0.14 +
    q.whiteBalance * 0.1 +
    q.contrast * 0.12 +
    q.dynamicRange * 0.12 +
    q.resolution * 0.1 +
    q.composition * 0.16 +
    q.horizonLevel * 0.1;

  const sceneBoost =
    scene.label === "exterior-front" || scene.label === "living-room" || scene.label === "kitchen" ? 8 : scene.label === "aerial" ? 6 : 0;

  const hero = clamp(qualityBlend + sceneBoost + scene.confidence * 4);

  return {
    heroImageScore: hero,
    zillowAppeal: clamp(hero * 0.84 + q.brightness * 0.16),
    mlsAppeal: clamp(hero * 0.74 + q.composition * 0.26),
    luxuryAppeal: clamp(hero * 0.66 + q.dynamicRange * 0.34),
    emotionalImpact: clamp(hero * 0.55 + q.composition * 0.45),
    clickLikelihood: clamp(hero * 0.72 + q.contrast * 0.28)
  };
}

function hasKeyword(name: string, ...keywords: string[]): boolean {
  return keywords.some((keyword) => name.includes(keyword));
}

function detectProblems(signals: VisionPhotoSignals): ProblemDetection[] {
  const name = tokenizedName(signals.fileName);
  const detected = new Set<ProblemLabel>();
  const confidence = new Map<ProblemLabel, number>();

  const flag = (label: ProblemLabel, value: number): void => {
    detected.add(label);
    confidence.set(label, Math.max(value, confidence.get(label) ?? 0));
  };

  if (hasKeyword(name, "tv")) {
    flag("TV on", 0.9);
  }
  if (hasKeyword(name, "fan", "motion", "blur")) {
    flag("Ceiling fan moving", 0.72);
  }
  if (hasKeyword(name, "toilet", "lid")) {
    flag("Toilet lid up", 0.93);
  }
  if (hasKeyword(name, "trash", "bin", "garbage")) {
    flag("Trash visible", 0.9);
  }
  if (hasKeyword(name, "dog", "cat", "pet")) {
    flag("Pets", 0.92);
  }
  if (hasKeyword(name, "person", "people", "selfie")) {
    flag("People", 0.88);
  }
  if (hasKeyword(name, "mirror", "reflection")) {
    flag("Mirrors reflecting photographer", 0.8);
  }
  if (hasKeyword(name, "car", "vehicle", "truck") || (signals.greenRatio > 0.1 && signals.blueRatio > 0.1 && signals.edgeDensity > 0.2)) {
    flag("Vehicles blocking exterior", 0.62);
  }
  if (hasKeyword(name, "counter", "kitchen") && signals.edgeDensity > 0.19) {
    flag("Dirty counters", 0.61);
  }
  if (signals.edgeDensity > 0.23) {
    flag("Clutter", 0.66);
  }
  if (hasKeyword(name, "family-photo", "portrait", "frame")) {
    flag("Personal photos", 0.79);
  }
  if (hasKeyword(name, "cabinet", "open")) {
    flag("Open cabinets", 0.76);
  }
  if (hasKeyword(name, "blind", "shade") && signals.edgeDensity > 0.15) {
    flag("Crooked blinds", 0.68);
  }
  if (signals.brightness < 0.36 || hasKeyword(name, "dark", "lights-off")) {
    flag("Lights off", 0.7);
  }
  if (hasKeyword(name, "bulb", "burned", "burnt")) {
    flag("Burned-out bulbs", 0.86);
  }
  if (signals.brightPixelRatio > 0.2 && signals.contrast > 0.12) {
    flag("Window glare", 0.72);
  }

  return PROBLEM_LABELS.map((label) => ({
    label,
    detected: detected.has(label),
    confidence: detected.has(label) ? Number((confidence.get(label) ?? 0.55).toFixed(2)) : 0
  }));
}

function recommendations(
  scene: SceneDetection,
  q: PhotoQualityAnalysis,
  m: MarketingAnalysis,
  problems: ProblemDetection[]
): Recommendation[] {
  const problemPenalty = problems.filter((item) => item.detected).length;
  const severeProblems = problems.filter((item) => item.detected && item.confidence >= 0.82).length;

  const removeConfidence = Math.min(0.99, 0.1 + severeProblems * 0.16 + (q.resolution < 35 || q.sharpness < 35 ? 0.38 : 0));
  const retakeConfidence = Math.min(0.99, 0.2 + (q.sharpness < 55 ? 0.2 : 0) + (q.exposure < 55 ? 0.2 : 0) + problemPenalty * 0.05);
  const editConfidence = Math.min(0.98, 0.28 + (q.whiteBalance < 70 ? 0.18 : 0) + (q.dynamicRange < 62 ? 0.16 : 0));
  const keepConfidence = Math.min(0.99, 0.28 + m.heroImageScore / 180 + (problemPenalty === 0 ? 0.18 : 0));
  const moveEarlierConfidence = Math.min(0.97, 0.18 + m.heroImageScore / 170 + (scene.label === "exterior-front" || scene.label === "kitchen" ? 0.12 : 0));
  const moveLaterConfidence = Math.min(0.97, 0.18 + (q.composition < 62 ? 0.2 : 0) + (problemPenalty > 0 ? 0.16 : 0));

  return [
    {
      action: "keep",
      confidence: Number(keepConfidence.toFixed(2)),
      reason: keepConfidence > 0.65 ? "Quality and appeal support inclusion in final set." : "Can remain as coverage image if no stronger alternative exists."
    },
    {
      action: "retake",
      confidence: Number(retakeConfidence.toFixed(2)),
      reason: "Technical issues suggest a higher-quality replacement would improve listing performance."
    },
    {
      action: "edit",
      confidence: Number(editConfidence.toFixed(2)),
      reason: "Color and tonal corrections can materially improve visual consistency."
    },
    {
      action: "remove",
      confidence: Number(removeConfidence.toFixed(2)),
      reason: "Detected issues increase risk of harming buyer perception and click-through."
    },
    {
      action: "move-earlier",
      confidence: Number(moveEarlierConfidence.toFixed(2)),
      reason: "Placement near the front of the gallery can strengthen initial buyer attention."
    },
    {
      action: "move-later",
      confidence: Number(moveLaterConfidence.toFixed(2)),
      reason: "Later sequence placement reduces impact from technical or staging issues."
    }
  ];
}

export function runDirectorVisionEngineV1(signals: VisionPhotoSignals): VisionAnalysis {
  const scene = detectScene(signals);
  const qualityAnalysis = quality(signals);
  const marketingAnalysis = marketing(scene, qualityAnalysis);
  const problemAnalysis = detectProblems(signals);
  const recommendationAnalysis = recommendations(scene, qualityAnalysis, marketingAnalysis, problemAnalysis);

  return {
    engineVersion: "director-vision-engine-v1",
    scene,
    quality: qualityAnalysis,
    marketing: marketingAnalysis,
    problems: problemAnalysis,
    recommendations: recommendationAnalysis
  };
}
