import {
  runDirectorVisionEngineV1,
  type Recommendation,
  type SceneTag as VisionSceneTag,
  type VisionAnalysis
} from "./vision-engine.js";

export interface FileDescriptor {
  name: string;
  path?: string;
  type?: string;
  size?: number;
}

export interface MediaCounts {
  photos: number;
  videos: number;
  pdfs: number;
  documents: number;
  other: number;
}

export type SceneTag = VisionSceneTag;

export type DecisionTag = "recommended" | "needs-work" | "remove";

export interface PhotoMetrics {
  fileName: string;
  filePath: string;
  thumbnailUrl: string;
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
  perceptualHash: string;
  colorHistogram: number[];
}

export interface PhotoScores {
  sharpness: number;
  exposure: number;
  brightness: number;
  contrast: number;
  resolution: number;
  orientation: number;
  usableAspect: number;
}

export interface ExecutiveSummary {
  strengths: string[];
  weaknesses: string[];
  missingShots: string[];
  heroImageRecommendation: string;
  estimatedMlsReadiness: string;
}

export interface PhotoAssessment extends PhotoMetrics {
  sceneTag: SceneTag;
  scores: PhotoScores;
  totalScore: number;
  issues: string[];
  scoreReasons: string[];
  recommendationReasons: string[];
  decision: DecisionTag;
  duplicateGroupId: number | null;
  similarGroupId: number | null;
  duplicateOfPath: string | null;
  recommendedMlsOrder: number;
  heroScore: number;
  vision: VisionAnalysis;
  primaryRecommendation: Recommendation;
}

export interface DirectorReview {
  storyAngle: string;
  buyerAngle: string;
  missingMedia: string[];
  missingShotChecklist: string[];
  actionItems: string[];
  launchReadinessScore: number;
  launchReadinessLabel: "Not Ready" | "Needs Work" | "Almost Ready" | "Launch Ready";
  listingReadinessLabel: "Ready" | "Needs Attention" | "Critical";
  readinessBreakdown: Array<{
    key:
      | "photos"
      | "hero-image"
      | "raw-availability"
      | "edited-availability"
      | "drone"
      | "video"
      | "floor-plans"
      | "matterport"
      | "walkthrough"
      | "seller-facts"
      | "mls-completion"
      | "marketing-completion";
    label: string;
    weight: number;
    score: number;
    status: "Ready" | "Needs Attention" | "Critical";
    reason: string;
  }>;
  readinessDeductions: string[];
  actionableRecommendations: Array<{
    id: string;
    title: string;
    explanation: string;
    affectedPhotoPaths: string[];
    priority: "high" | "medium" | "low";
  }>;
  mediaHealth: {
    duplicateCount: number;
    rawCount: number;
    editedCount: number;
    uneditedCount: number;
    missingEdits: number;
    missingHero: boolean;
    unusedAssets: number;
    stagedAssets: number;
    twilightCandidates: number;
  };
  executiveSummary: ExecutiveSummary;
}

export interface ReviewContext {
  rawCount?: number;
  editedCount?: number;
  droneCount?: number;
  floorPlanCount?: number;
  matterportCount?: number;
  walkthroughCount?: number;
  sellerFactsCount?: number;
  mlsCompletion?: number;
  marketingCompletion?: number;
}

export interface IntakeSummary {
  address: string;
  listPrice: string;
  fileCount: number;
  mediaCounts: MediaCounts;
  photos: PhotoAssessment[];
  generatedAt: string;
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "txt", "rtf", "xlsx", "csv", "ppt", "pptx"]);
const FLOOR_PLAN_KEYWORDS = ["floorplan", "floor-plan", "floor_plan", "fp", "plan"];

function normalizedMediaName(file: FileDescriptor): string {
  const raw = `${file.path ?? ""} ${file.name}`;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function isFloorPlanDescriptor(file: FileDescriptor): boolean {
  const normalized = normalizedMediaName(file);
  if (!FLOOR_PLAN_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }
  const extension = getExtension(file.name);
  return extension === "pdf" || IMAGE_EXTENSIONS.has(extension);
}

function getExtension(fileName: string): string {
  const segments = fileName.toLowerCase().split(".");
  if (segments.length < 2) {
    return "";
  }
  return segments[segments.length - 1] ?? "";
}

export function isImageDescriptor(file: FileDescriptor): boolean {
  const extension = getExtension(file.name);
  return (file.type ?? "").startsWith("image/") || IMAGE_EXTENSIONS.has(extension);
}

export function classifyMedia(files: FileDescriptor[]): MediaCounts {
  const counts: MediaCounts = {
    photos: 0,
    videos: 0,
    pdfs: 0,
    documents: 0,
    other: 0
  };

  for (const file of files) {
    const extension = getExtension(file.name);
    const type = file.type ?? "";

    if (isFloorPlanDescriptor(file)) {
      if (extension === "pdf" || type === "application/pdf") {
        counts.pdfs += 1;
      } else {
        counts.documents += 1;
      }
      continue;
    }

    if (type.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
      counts.photos += 1;
      continue;
    }

    if (type.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
      counts.videos += 1;
      continue;
    }

    if (extension === "pdf" || type === "application/pdf") {
      counts.pdfs += 1;
      continue;
    }

    if (DOCUMENT_EXTENSIONS.has(extension)) {
      counts.documents += 1;
      continue;
    }

    counts.other += 1;
  }

  return counts;
}

function normalize(value: number, min: number, max: number): number {
  if (value <= min) {
    return 0;
  }
  if (value >= max) {
    return 100;
  }
  return Math.round(((value - min) / (max - min)) * 100);
}

function hammingDistance(hashA: string, hashB: string): number {
  const length = Math.min(hashA.length, hashB.length);
  let distance = 0;

  for (let index = 0; index < length; index += 1) {
    if (hashA[index] !== hashB[index]) {
      distance += 1;
    }
  }

  distance += Math.abs(hashA.length - hashB.length);
  return distance;
}

function histogramDistance(histA: number[], histB: number[]): number {
  const length = Math.min(histA.length, histB.length);
  if (length === 0) {
    return 1;
  }

  let distance = 0;
  for (let index = 0; index < length; index += 1) {
    distance += Math.abs((histA[index] ?? 0) - (histB[index] ?? 0));
  }

  return distance / length;
}

function scoreAspectRatio(width: number, height: number): number {
  if (height === 0) {
    return 0;
  }

  const ratio = width / height;
  const target = 1.5;
  const distance = Math.min(Math.abs(ratio - target), 1.5);
  return Math.round((1 - distance / 1.5) * 100);
}

function scoreOrientation(width: number, height: number): number {
  if (width > height) {
    return 95;
  }
  if (width === height) {
    return 70;
  }
  return 30;
}

function scoreExposure(brightPixelRatio: number, darkPixelRatio: number): number {
  const clipped = brightPixelRatio + darkPixelRatio;
  return Math.max(0, 100 - Math.round(clipped * 200));
}

function scoreBrightness(brightness: number): number {
  const target = 0.56;
  const distance = Math.min(Math.abs(brightness - target), 0.56);
  return Math.round((1 - distance / 0.56) * 100);
}

function scorePhoto(photo: PhotoMetrics): PhotoScores {
  return {
    sharpness: normalize(photo.sharpness, 5, 65),
    exposure: scoreExposure(photo.brightPixelRatio, photo.darkPixelRatio),
    brightness: scoreBrightness(photo.brightness),
    contrast: normalize(photo.contrast, 0.04, 0.24),
    resolution: normalize(photo.width * photo.height, 1100 * 700, 4200 * 2800),
    orientation: scoreOrientation(photo.width, photo.height),
    usableAspect: scoreAspectRatio(photo.width, photo.height)
  };
}

function buildIssueFlags(scores: PhotoScores, photo: PhotoMetrics): string[] {
  const issues: string[] = [];

  if (scores.sharpness < 45) {
    issues.push("blurry");
  }
  if (photo.brightness < 0.38 || scores.brightness < 45) {
    issues.push("dark");
  }
  if (photo.brightPixelRatio > 0.18 || scores.exposure < 45) {
    issues.push("overexposed");
  }
  if (scores.resolution < 45) {
    issues.push("low resolution");
  }
  if (photo.width < photo.height || scores.orientation < 45) {
    issues.push("vertically distorted");
  }
  if (scores.usableAspect < 45) {
    issues.push("poor usable aspect ratio");
  }

  return issues;
}

function buildScoreReasons(scores: PhotoScores, issues: string[]): string[] {
  const reasons: string[] = [
    `Sharpness score ${scores.sharpness}/100`,
    `Exposure score ${scores.exposure}/100`,
    `Brightness score ${scores.brightness}/100`,
    `Contrast score ${scores.contrast}/100`,
    `Resolution score ${scores.resolution}/100`,
    `Orientation score ${scores.orientation}/100`,
    `Aspect ratio score ${scores.usableAspect}/100`
  ];

  if (issues.length === 0) {
    reasons.push("No critical technical issues detected");
  }

  return reasons;
}

function bestRecommendation(analysis: VisionAnalysis): Recommendation {
  const ordered = [...analysis.recommendations].sort((a, b) => b.confidence - a.confidence);
  return ordered[0] ?? { action: "keep", confidence: 0.5, reason: "Default keep decision." };
}

function normalizedStem(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-(raw|edited|edit|retouched|retouch|final|export|enhanced)\b/g, "")
    .replace(/-\d+\b/g, "")
    .replace(/--+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function likelyRawEditedPair(a: PhotoAssessment, b: PhotoAssessment): boolean {
  const aExt = getExtension(a.fileName);
  const bExt = getExtension(b.fileName);
  const isRawA = ["cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2"].includes(aExt);
  const isRawB = ["cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2"].includes(bExt);
  if (isRawA === isRawB) {
    return false;
  }
  const stemA = normalizedStem(a.filePath);
  const stemB = normalizedStem(b.filePath);
  return stemA.length > 0 && stemA === stemB;
}

function decisionFromRecommendation(recommendation: Recommendation): DecisionTag {
  if (recommendation.action === "remove") {
    return "remove";
  }
  if (recommendation.action === "retake" || recommendation.action === "edit" || recommendation.action === "move-later") {
    return "needs-work";
  }
  return "recommended";
}

function compareForMlsOrder(a: PhotoAssessment, b: PhotoAssessment): number {
  const scenePriority = new Map<SceneTag, number>([
    ["exterior-front", 0],
    ["aerial", 1],
    ["living-room", 2],
    ["kitchen", 3],
    ["dining", 4],
    ["family-room", 5],
    ["primary-bedroom", 6],
    ["primary-bathroom", 7],
    ["secondary-bedroom", 8],
    ["bathroom", 9],
    ["office", 10],
    ["laundry", 11],
    ["basement", 12],
    ["garage", 13],
    ["patio-deck", 14],
    ["pool", 15],
    ["community-amenities", 16],
    ["exterior-rear", 17],
    ["exterior-side", 18],
    ["miscellaneous", 19]
  ]);

  const decisionWeight = (value: DecisionTag) => {
    if (value === "recommended") {
      return 0;
    }
    if (value === "needs-work") {
      return 1;
    }
    return 2;
  };

  if (decisionWeight(a.decision) !== decisionWeight(b.decision)) {
    return decisionWeight(a.decision) - decisionWeight(b.decision);
  }

  const aPriority = scenePriority.get(a.sceneTag) ?? 99;
  const bPriority = scenePriority.get(b.sceneTag) ?? 99;
  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }

  return b.heroScore - a.heroScore;
}

function narrativeSequence(photos: PhotoAssessment[]): PhotoAssessment[] {
  const scenePriority = new Map<SceneTag, number>([
    ["exterior-front", 0],
    ["aerial", 1],
    ["living-room", 2],
    ["kitchen", 3],
    ["dining", 4],
    ["family-room", 5],
    ["primary-bedroom", 6],
    ["primary-bathroom", 7],
    ["secondary-bedroom", 8],
    ["bathroom", 9],
    ["office", 10],
    ["laundry", 11],
    ["basement", 12],
    ["garage", 13],
    ["patio-deck", 14],
    ["pool", 15],
    ["community-amenities", 16],
    ["exterior-rear", 17],
    ["exterior-side", 18],
    ["miscellaneous", 19]
  ]);

  const remaining = [...photos];
  const ordered: PhotoAssessment[] = [];
  let previousScene: SceneTag | null = null;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) {
        continue;
      }

      const sceneRank = scenePriority.get(candidate.sceneTag) ?? 99;
      const decisionScore = candidate.decision === "recommended" ? 28 : candidate.decision === "needs-work" ? 12 : -20;
      const repetitionPenalty = previousScene && previousScene === candidate.sceneTag ? 38 : 0;
      const openingBoost =
        ordered.length === 0 && (candidate.sceneTag === "exterior-front" || candidate.sceneTag === "aerial") ? 22 : 0;
      const sidePenalty = candidate.sceneTag === "exterior-side" ? 14 : 0;

      const total =
        decisionScore +
        candidate.heroScore * 0.9 +
        candidate.vision.marketing.clickLikelihood * 0.35 +
        (100 - sceneRank * 4) +
        openingBoost -
        repetitionPenalty -
        sidePenalty;

      if (total > bestScore) {
        bestScore = total;
        bestIndex = index;
      }
    }

    const [selected] = remaining.splice(bestIndex, 1);
    if (!selected) {
      break;
    }
    ordered.push(selected);
    previousScene = selected.sceneTag;
  }

  return ordered;
}

function computeGroups(photos: PhotoAssessment[]): { duplicates: number[][]; similars: number[][] } {
  const duplicateGroups: number[][] = [];
  const similarGroups: number[][] = [];
  const usedDuplicate = new Set<number>();
  const usedSimilar = new Set<number>();

  for (let i = 0; i < photos.length; i += 1) {
    if (usedDuplicate.has(i)) {
      continue;
    }

    const duplicateCluster = [i];
    for (let j = i + 1; j < photos.length; j += 1) {
      const left = photos[i];
      const right = photos[j];
      if (!left || !right) {
        continue;
      }
      const hashDistance = hammingDistance(left.perceptualHash, right.perceptualHash);
      const histDistance = histogramDistance(left.colorHistogram, right.colorHistogram);
      if (likelyRawEditedPair(left, right)) {
        continue;
      }
      if (hashDistance <= 5 && histDistance < 0.08) {
        duplicateCluster.push(j);
        usedDuplicate.add(j);
      }
    }

    if (duplicateCluster.length > 1) {
      duplicateGroups.push(duplicateCluster);
      usedDuplicate.add(i);
    }
  }

  for (let i = 0; i < photos.length; i += 1) {
    if (usedSimilar.has(i)) {
      continue;
    }

    const similarCluster = [i];
    for (let j = i + 1; j < photos.length; j += 1) {
      const hashDistance = hammingDistance(photos[i]?.perceptualHash ?? "", photos[j]?.perceptualHash ?? "");
      const histDistance = histogramDistance(photos[i]?.colorHistogram ?? [], photos[j]?.colorHistogram ?? []);
      if (hashDistance <= 14 && histDistance < 0.16) {
        similarCluster.push(j);
        usedSimilar.add(j);
      }
    }

    if (similarCluster.length > 1) {
      similarGroups.push(similarCluster);
      usedSimilar.add(i);
    }
  }

  return {
    duplicates: duplicateGroups,
    similars: similarGroups
  };
}

export function assessPhotos(metrics: PhotoMetrics[]): PhotoAssessment[] {
  const initial: PhotoAssessment[] = metrics.map((photo) => {
    const scores = scorePhoto(photo);
    const issues = buildIssueFlags(scores, photo);
    const vision = runDirectorVisionEngineV1({
      fileName: photo.fileName,
      width: photo.width,
      height: photo.height,
      brightness: photo.brightness,
      contrast: photo.contrast,
      saturation: photo.saturation,
      sharpness: photo.sharpness,
      edgeDensity: photo.edgeDensity,
      blueRatio: photo.blueRatio,
      greenRatio: photo.greenRatio,
      warmRatio: photo.warmRatio,
      brightPixelRatio: photo.brightPixelRatio,
      darkPixelRatio: photo.darkPixelRatio
    });

    const primaryRecommendation = bestRecommendation(vision);
    const decision = decisionFromRecommendation(primaryRecommendation);

    const assessment: PhotoAssessment = {
      ...photo,
      sceneTag: vision.scene.label,
      scores,
      totalScore: vision.marketing.heroImageScore,
      heroScore: vision.marketing.heroImageScore,
      issues,
      scoreReasons: buildScoreReasons(scores, issues),
      recommendationReasons: vision.recommendations.map(
        (item) => `${item.action} (${Math.round(item.confidence * 100)}%): ${item.reason}`
      ),
      decision,
      duplicateGroupId: null,
      similarGroupId: null,
      duplicateOfPath: null,
      recommendedMlsOrder: 0,
      vision,
      primaryRecommendation
    };

    return assessment;
  });

  const groups = computeGroups(initial);

  groups.duplicates.forEach((cluster, clusterIndex) => {
    const sorted = [...cluster].sort((a, b) => (initial[b]?.heroScore ?? 0) - (initial[a]?.heroScore ?? 0));
    const anchorIndex = sorted[0];
    if (anchorIndex === undefined) {
      return;
    }
    const anchor = initial[anchorIndex];

    sorted.forEach((photoIndex, indexInCluster) => {
      const item = initial[photoIndex];
      if (!item) {
        return;
      }
      item.duplicateGroupId = clusterIndex + 1;
      if (indexInCluster > 0) {
        item.decision = "remove";
        item.duplicateOfPath = anchor?.filePath ?? null;
        item.issues = [...item.issues, "redundant"];
        item.recommendationReasons.unshift(`remove (97%): probable duplicate of ${item.duplicateOfPath ?? "higher-ranked frame"}.`);
      }
    });
  });

  groups.similars.forEach((cluster, clusterIndex) => {
    cluster.forEach((photoIndex) => {
      const item = initial[photoIndex];
      if (item) {
        item.similarGroupId = clusterIndex + 1;
      }
    });
  });

  const ordered = narrativeSequence([...initial].sort(compareForMlsOrder));
  ordered.forEach((item, index) => {
    item.recommendedMlsOrder = index + 1;
  });

  return ordered;
}

function parsePrice(listPrice: string): number {
  const parsed = Number(listPrice.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function createMissingShotChecklist(summary: IntakeSummary): string[] {
  const checklist: string[] = [];
  const observed = new Set(summary.photos.map((candidate) => candidate.sceneTag));
  const price = parsePrice(summary.listPrice);
  const address = summary.address.toLowerCase();
  const isLuxury = price >= 900000;
  const isCondo = /condo|unit|apt|apartment|suite/.test(address);
  const hasStrongExterior = observed.has("exterior-front") || observed.has("aerial");

  if (!observed.has("exterior-front")) {
    checklist.push("Capture a bright curb-appeal exterior front hero shot from street level.");
  }
  if (!observed.has("exterior-rear") && !observed.has("patio-deck") && !observed.has("pool")) {
    checklist.push("Add at least one rear-yard, patio, or pool lifestyle composition.");
  }
  if (!observed.has("kitchen")) {
    checklist.push("Shoot a wide kitchen frame including counters and island if present.");
  }
  if (!observed.has("living-room") && !observed.has("family-room")) {
    checklist.push("Include at least one primary living area shot for flow and scale.");
  }
  if (!observed.has("primary-bedroom")) {
    checklist.push("Include a primary bedroom shot that shows depth and natural light.");
  }
  if (!observed.has("bathroom")) {
    checklist.push("Add a clean bathroom image that shows vanity and shower or tub context.");
  }
  if (!observed.has("primary-bathroom")) {
    checklist.push("Add at least one primary bathroom shot with vanity and shower detail.");
  }
  if (!observed.has("laundry")) {
    checklist.push("Include a laundry room shot to complete utility-area coverage.");
  }
  if (!observed.has("exterior-rear") && !observed.has("patio-deck") && !observed.has("pool") && !isCondo) {
    checklist.push("No backyard coverage detected. Add one rear exterior lifestyle frame.");
  }

  if (isLuxury) {
    checklist.push("Large luxury listing detected. Include at least 3 drone perspectives.");
    checklist.push("Recommend twilight hero set for premium launch impact.");
  } else if (isCondo) {
    checklist.push("Condo profile detected: drone is optional and should focus on context if available.");
    if (hasStrongExterior) {
      checklist.push("Twilight is optional but recommended if exterior light balance is strong.");
    }
  } else if (hasStrongExterior) {
    checklist.push("Exterior coverage is strong; consider adding one twilight exterior for marketing lift.");
  }

  if (summary.mediaCounts.videos < 1) {
    checklist.push("Record one vertical teaser or walkthrough clip under 60 seconds.");
  }
  if (summary.mediaCounts.pdfs < 1) {
    checklist.push("Create a one-page feature PDF for buyer handoff and agent follow-up.");
  }

  return checklist;
}

function topHeroCandidates(photos: PhotoAssessment[]): PhotoAssessment[] {
  const keepers = photos.filter((item) => item.decision !== "remove");
  const preferred = keepers.filter((item) => item.sceneTag !== "exterior-side");
  const source = preferred.length > 0 ? preferred : keepers;
  return source
    .sort((a, b) => {
      const sidePenaltyA = a.sceneTag === "exterior-side" ? 14 : 0;
      const sidePenaltyB = b.sceneTag === "exterior-side" ? 14 : 0;
      const uniquenessA = (a.duplicateGroupId ? -12 : 0) + (a.similarGroupId ? -6 : 4);
      const uniquenessB = (b.duplicateGroupId ? -12 : 0) + (b.similarGroupId ? -6 : 4);
      const scoreA = a.heroScore * 0.7 + a.vision.marketing.emotionalImpact * 0.2 + a.vision.marketing.clickLikelihood * 0.2 + uniquenessA - sidePenaltyA;
      const scoreB = b.heroScore * 0.7 + b.vision.marketing.emotionalImpact * 0.2 + b.vision.marketing.clickLikelihood * 0.2 + uniquenessB - sidePenaltyB;
      return scoreB - scoreA;
    })
    .slice(0, 5);
}

function buildExecutiveSummary(summary: IntakeSummary): ExecutiveSummary {
  const photos = summary.photos;
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  const avgHero =
    photos.length > 0 ? Math.round(photos.reduce((total, photo) => total + photo.vision.marketing.heroImageScore, 0) / photos.length) : 0;
  const highAppeal = photos.filter((photo) => photo.vision.marketing.clickLikelihood >= 75).length;
  const issueHeavy = photos.filter((photo) => photo.vision.problems.some((problem) => problem.detected)).length;

  if (avgHero >= 70) {
    strengths.push(`Strong overall hero potential with average score ${avgHero}/100.`);
  }
  if (highAppeal > 0) {
    strengths.push(`${highAppeal} images show high click-through potential.`);
  }

  if (issueHeavy > 0) {
    weaknesses.push(`${issueHeavy} images contain detected staging or technical problems.`);
  }
  const needsWork = photos.filter((photo) => photo.decision === "needs-work").length;
  if (needsWork > 0) {
    weaknesses.push(`${needsWork} images should be retouched or retaken before launch.`);
  }

  if (strengths.length === 0) {
    strengths.push("Initial coverage is present, but hero quality needs improvement.");
  }
  if (weaknesses.length === 0) {
    weaknesses.push("No major visual blockers detected.");
  }

  const heroCandidate = topHeroCandidates(photos)[0];
  const missingShots = createMissingShotChecklist(summary);

  return {
    strengths,
    weaknesses,
    missingShots,
    heroImageRecommendation: heroCandidate
      ? `${heroCandidate.fileName} (${heroCandidate.sceneTag}) is the best hero candidate at ${heroCandidate.heroScore}/100.`
      : "No viable hero image detected yet.",
    estimatedMlsReadiness: avgHero >= 80 ? "High" : avgHero >= 65 ? "Medium" : "Low"
  };
}

function findHero(photos: PhotoAssessment[]): PhotoAssessment | null {
  return [...photos]
    .filter((item) => item.decision !== "remove")
    .sort((a, b) => b.heroScore - a.heroScore)[0] ?? null;
}

function classifyReadinessStatus(score: number): "Ready" | "Needs Attention" | "Critical" {
  if (score >= 82) {
    return "Ready";
  }
  if (score >= 58) {
    return "Needs Attention";
  }
  return "Critical";
}

export function buildDirectorReview(summary: IntakeSummary, context: ReviewContext = {}): DirectorReview {
  const { mediaCounts, photos } = summary;
  const price = parsePrice(summary.listPrice);

  const duplicateCount = photos.filter((item) => item.duplicateGroupId !== null).length;
  const rawCount = context.rawCount ?? 0;
  const editedCount = context.editedCount ?? mediaCounts.photos;
  const uneditedCount = Math.max(0, rawCount - editedCount);
  const missingEdits = Math.max(0, photos.filter((item) => item.decision === "needs-work").length - editedCount);
  const stagedAssets = photos.filter((item) => item.fileName.toLowerCase().includes("stage") || item.fileName.toLowerCase().includes("virtual")).length;
  const twilightCandidates = photos.filter((item) => item.sceneTag.startsWith("exterior") && item.heroScore >= 70).length;
  const missingHero = findHero(photos) === null;
  const unusedAssets = photos.filter((item) => item.decision === "remove").length;

  const missingMedia: string[] = [];
  if (mediaCounts.photos < 24) {
    missingMedia.push("Add at least 24 polished listing photos");
  }
  if (mediaCounts.videos < 1) {
    missingMedia.push("Include one walkthrough or vertical teaser video");
  }
  if (mediaCounts.pdfs < 1) {
    missingMedia.push("Include a printable brochure PDF");
  }
  if (mediaCounts.documents < 1) {
    missingMedia.push("Attach disclosure sheets or room-by-room notes");
  }

  const heroCandidates = topHeroCandidates(photos);
  const photoDepthScore = normalize(mediaCounts.photos, 8, 36);
  const videoScore = mediaCounts.videos > 0 ? 100 : 35;
  const pdfScore = mediaCounts.pdfs > 0 ? 100 : 40;
  const docsScore = mediaCounts.documents > 0 ? 85 : 55;
  const topThree = heroCandidates.slice(0, 3);
  const heroDepth =
    topThree.length > 0 ? Math.round(topThree.reduce((total, item) => total + item.heroScore, 0) / topThree.length) : 0;

  const launchReadinessScore = Math.round(
    photoDepthScore * 0.26 + videoScore * 0.16 + pdfScore * 0.12 + docsScore * 0.1 + heroDepth * 0.36
  );

  const launchReadinessLabel: DirectorReview["launchReadinessLabel"] =
    launchReadinessScore >= 85
      ? "Launch Ready"
      : launchReadinessScore >= 70
        ? "Almost Ready"
        : launchReadinessScore >= 50
          ? "Needs Work"
          : "Not Ready";

  const buyerAngle =
    price >= 1_000_000
      ? "Luxury lifestyle buyer seeking design, privacy, and prestige"
      : price >= 450_000
        ? "Move-up buyer prioritizing space, neighborhood fit, and finish quality"
        : "Value-focused buyer seeking turnkey confidence and payment clarity";

  const topHero = heroCandidates[0];
  const storyAngle = topHero
    ? `Lead with ${summary.address} using ${topHero.sceneTag.replace(/-/g, " ")} imagery and technical clarity to build instant confidence.`
    : `Position ${summary.address} as a practical, move-in ready opportunity with clear lifestyle benefits.`;

  const actionItems: string[] = [];
  if (topHero) {
    actionItems.push(`Use ${topHero.fileName} as the lead hero image in MLS order #1.`);
  }

  const removeCount = photos.filter((item) => item.decision === "remove").length;
  if (removeCount > 0) {
    actionItems.push(`Remove ${removeCount} duplicate or low-quality photos before launch.`);
  }

  const needsWorkCount = photos.filter((item) => item.decision === "needs-work").length;
  if (needsWorkCount > 0) {
    actionItems.push(`Retouch or re-shoot ${needsWorkCount} photos currently marked needs-work.`);
  }

  actionItems.push("Follow recommended MLS sequencing for narrative flow from hero exterior to key interiors.");

  const readinessBreakdown: DirectorReview["readinessBreakdown"] = [
    {
      key: "photos",
      label: "Photos",
      weight: 0.16,
      score: normalize(mediaCounts.photos, 10, 38),
      status: classifyReadinessStatus(normalize(mediaCounts.photos, 10, 38)),
      reason: mediaCounts.photos >= 24 ? "Photo volume supports launch coverage." : `Only ${mediaCounts.photos} photos available; target is 24+.`
    },
    {
      key: "hero-image",
      label: "Hero Image",
      weight: 0.12,
      score: topHero?.heroScore ?? 0,
      status: classifyReadinessStatus(topHero?.heroScore ?? 0),
      reason: topHero ? `${topHero.fileName} currently leads hero ranking.` : "No viable hero image selected yet."
    },
    {
      key: "raw-availability",
      label: "RAW Availability",
      weight: 0.07,
      score: rawCount > 0 ? 95 : 25,
      status: classifyReadinessStatus(rawCount > 0 ? 95 : 25),
      reason: rawCount > 0 ? `${rawCount} RAW files available for fallback edits.` : "No RAW files detected."
    },
    {
      key: "edited-availability",
      label: "Edited Availability",
      weight: 0.1,
      score: editedCount > 0 ? normalize(editedCount, 8, 28) : 15,
      status: classifyReadinessStatus(editedCount > 0 ? normalize(editedCount, 8, 28) : 15),
      reason: editedCount > 0 ? `${editedCount} edited assets available for publish.` : "No edited files detected for publish set."
    },
    {
      key: "drone",
      label: "Drone",
      weight: 0.06,
      score: context.droneCount && context.droneCount > 0 ? 92 : price >= 900000 ? 30 : 70,
      status: classifyReadinessStatus(context.droneCount && context.droneCount > 0 ? 92 : price >= 900000 ? 30 : 70),
      reason:
        context.droneCount && context.droneCount > 0
          ? `${context.droneCount} drone assets detected.`
          : price >= 900000
            ? "Luxury listing without drone coverage is a critical gap."
            : "Drone is optional for this listing profile."
    },
    {
      key: "video",
      label: "Video",
      weight: 0.08,
      score: mediaCounts.videos > 0 ? 90 : 35,
      status: classifyReadinessStatus(mediaCounts.videos > 0 ? 90 : 35),
      reason: mediaCounts.videos > 0 ? "Video walkthrough/teaser is present." : "Missing video teaser/walkthrough."
    },
    {
      key: "floor-plans",
      label: "Floor Plans",
      weight: 0.06,
      score: context.floorPlanCount && context.floorPlanCount > 0 ? 94 : 42,
      status: classifyReadinessStatus(context.floorPlanCount && context.floorPlanCount > 0 ? 94 : 42),
      reason: context.floorPlanCount && context.floorPlanCount > 0 ? "Floor plans are available." : "No floor plans detected."
    },
    {
      key: "matterport",
      label: "Matterport",
      weight: 0.06,
      score: context.matterportCount && context.matterportCount > 0 ? 92 : 55,
      status: classifyReadinessStatus(context.matterportCount && context.matterportCount > 0 ? 92 : 55),
      reason: context.matterportCount && context.matterportCount > 0 ? "3D tour coverage is available." : "Matterport/3D tour not provided yet."
    },
    {
      key: "walkthrough",
      label: "Walkthrough",
      weight: 0.07,
      score: context.walkthroughCount && context.walkthroughCount > 0 ? 90 : 40,
      status: classifyReadinessStatus(context.walkthroughCount && context.walkthroughCount > 0 ? 90 : 40),
      reason: context.walkthroughCount && context.walkthroughCount > 0 ? "Walkthrough transcript captured." : "Walkthrough not captured yet."
    },
    {
      key: "seller-facts",
      label: "Seller Facts",
      weight: 0.08,
      score: context.sellerFactsCount ? normalize(context.sellerFactsCount, 4, 20) : 30,
      status: classifyReadinessStatus(context.sellerFactsCount ? normalize(context.sellerFactsCount, 4, 20) : 30),
      reason:
        context.sellerFactsCount && context.sellerFactsCount > 0
          ? `${context.sellerFactsCount} seller facts extracted from walkthrough.`
          : "No validated seller facts available yet."
    },
    {
      key: "mls-completion",
      label: "MLS Completion",
      weight: 0.07,
      score: Math.round(Math.max(0, Math.min(100, (context.mlsCompletion ?? 0) * 100))),
      status: classifyReadinessStatus(Math.round(Math.max(0, Math.min(100, (context.mlsCompletion ?? 0) * 100)))),
      reason: `MLS readiness coverage is ${Math.round((context.mlsCompletion ?? 0) * 100)}%.`
    },
    {
      key: "marketing-completion",
      label: "Marketing Completion",
      weight: 0.07,
      score: Math.round(Math.max(0, Math.min(100, (context.marketingCompletion ?? 0) * 100))),
      status: classifyReadinessStatus(Math.round(Math.max(0, Math.min(100, (context.marketingCompletion ?? 0) * 100)))),
      reason: `Marketing completion is ${Math.round((context.marketingCompletion ?? 0) * 100)}%.`
    }
  ];

  const weightedReadiness = Math.round(
    readinessBreakdown.reduce((total, item) => total + item.score * item.weight, 0)
  );
  const listingReadinessLabel = classifyReadinessStatus(weightedReadiness);
  const readinessDeductions = readinessBreakdown
    .filter((item) => item.score < 82)
    .sort((a, b) => a.score - b.score)
    .map((item) => `${item.label}: ${item.reason}`);

  const actionableRecommendations: DirectorReview["actionableRecommendations"] = [
    {
      id: "hero-priority",
      title: "Promote strongest hero image",
      explanation: topHero
        ? `${topHero.fileName} should be placed first because it has the highest hero score.`
        : "No hero image is currently strong enough for lead placement.",
      affectedPhotoPaths: topHero ? [topHero.filePath] : [],
      priority: topHero ? "medium" : "high"
    },
    {
      id: "remove-duplicates",
      title: "Remove duplicate or weak assets",
      explanation: unusedAssets > 0
        ? `${unusedAssets} assets are currently marked remove and should be excluded from MLS export.`
        : "No duplicate removals are pending.",
      affectedPhotoPaths: photos.filter((item) => item.decision === "remove").slice(0, 8).map((item) => item.filePath),
      priority: unusedAssets > 0 ? "high" : "low"
    },
    {
      id: "complete-missing-shots",
      title: "Close missing shot checklist",
      explanation: `There are ${createMissingShotChecklist(summary).length} missing-shot recommendations to resolve before launch.`,
      affectedPhotoPaths: [],
      priority: createMissingShotChecklist(summary).length > 3 ? "high" : "medium"
    }
  ];

  return {
    storyAngle,
    buyerAngle,
    missingMedia,
    missingShotChecklist: createMissingShotChecklist(summary),
    actionItems,
    launchReadinessScore: weightedReadiness,
    launchReadinessLabel,
    listingReadinessLabel,
    readinessBreakdown,
    readinessDeductions,
    actionableRecommendations,
    mediaHealth: {
      duplicateCount,
      rawCount,
      editedCount,
      uneditedCount,
      missingEdits,
      missingHero,
      unusedAssets,
      stagedAssets,
      twilightCandidates
    },
    executiveSummary: buildExecutiveSummary(summary)
  };
}

export function createTextReport(summary: IntakeSummary, review: DirectorReview): string {
  const topCandidates = topHeroCandidates(summary.photos);

  const lines: string[] = [
    "Director Intake Report",
    "====================",
    `Generated: ${summary.generatedAt}`,
    `Address: ${summary.address}`,
    `List Price: ${summary.listPrice}`,
    `Files Analyzed: ${summary.fileCount}`,
    "",
    "Media Inventory",
    "---------------",
    `Photos: ${summary.mediaCounts.photos}`,
    `Videos: ${summary.mediaCounts.videos}`,
    `PDFs: ${summary.mediaCounts.pdfs}`,
    `Documents: ${summary.mediaCounts.documents}`,
    `Other: ${summary.mediaCounts.other}`,
    "",
    "Launch Readiness",
    "----------------",
    `Score: ${review.launchReadinessScore}/100 (${review.listingReadinessLabel})`,
    "Deductions:",
    ...(review.readinessDeductions.length > 0 ? review.readinessDeductions.map((item, index) => `${index + 1}. ${item}`) : ["None"]),
    "",
    "Executive Summary",
    "-----------------",
    "Strengths:",
    ...review.executiveSummary.strengths.map((item, index) => `${index + 1}. ${item}`),
    "Weaknesses:",
    ...review.executiveSummary.weaknesses.map((item, index) => `${index + 1}. ${item}`),
    "Missing shots:",
    ...review.executiveSummary.missingShots.map((item, index) => `${index + 1}. ${item}`),
    `Hero recommendation: ${review.executiveSummary.heroImageRecommendation}`,
    `Estimated MLS readiness: ${review.executiveSummary.estimatedMlsReadiness}`,
    "",
    "Director Review",
    "---------------",
    `Story Angle: ${review.storyAngle}`,
    `Likely Buyer Angle: ${review.buyerAngle}`,
    "",
    "Missing Media",
    "-------------"
  ];

  if (review.missingMedia.length === 0) {
    lines.push("None");
  } else {
    lines.push(...review.missingMedia.map((item, index) => `${index + 1}. ${item}`));
  }

  lines.push("", "Missing Shot Checklist", "----------------------");
  if (review.missingShotChecklist.length === 0) {
    lines.push("No critical missing shots detected.");
  } else {
    lines.push(...review.missingShotChecklist.map((item, index) => `${index + 1}. ${item}`));
  }

  lines.push("", "Action Items", "------------", ...review.actionItems.map((item, index) => `${index + 1}. ${item}`));
  lines.push("", "Top Hero Candidates", "-------------------");

  if (topCandidates.length === 0) {
    lines.push("No photo candidates analyzed.");
  } else {
    lines.push(
      ...topCandidates.map(
        (candidate, index) =>
          `${index + 1}. ${candidate.fileName} | Score ${candidate.heroScore} | ${candidate.sceneTag} | ${candidate.recommendationReasons.join(" ")}`
      )
    );
  }

  lines.push("", "Recommended MLS Order", "---------------------");
  lines.push(
    ...summary.photos.map(
      (photo) => `${photo.recommendedMlsOrder}. ${photo.fileName} [${photo.decision}] - ${photo.recommendationReasons.join(" ")}`
    )
  );

  return `${lines.join("\n")}\n`;
}
