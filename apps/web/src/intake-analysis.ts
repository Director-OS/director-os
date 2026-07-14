import {
  runDirectorVisionEngineV1,
  SCENE_TAGS,
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
  executiveSummary: ExecutiveSummary;
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
  const scenePriority = new Map<SceneTag, number>(SCENE_TAGS.map((tag, index) => [tag, index]));

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
      const hashDistance = hammingDistance(photos[i]?.perceptualHash ?? "", photos[j]?.perceptualHash ?? "");
      const histDistance = histogramDistance(photos[i]?.colorHistogram ?? [], photos[j]?.colorHistogram ?? []);
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

  const ordered = [...initial].sort(compareForMlsOrder);
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

  if (summary.mediaCounts.videos < 1) {
    checklist.push("Record one vertical teaser or walkthrough clip under 60 seconds.");
  }
  if (summary.mediaCounts.pdfs < 1) {
    checklist.push("Create a one-page feature PDF for buyer handoff and agent follow-up.");
  }

  return checklist;
}

function topHeroCandidates(photos: PhotoAssessment[]): PhotoAssessment[] {
  return photos
    .filter((item) => item.decision !== "remove")
    .sort((a, b) => b.heroScore - a.heroScore)
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

export function buildDirectorReview(summary: IntakeSummary): DirectorReview {
  const { mediaCounts, photos } = summary;
  const price = parsePrice(summary.listPrice);

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

  return {
    storyAngle,
    buyerAngle,
    missingMedia,
    missingShotChecklist: createMissingShotChecklist(summary),
    actionItems,
    launchReadinessScore,
    launchReadinessLabel,
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
    `Score: ${review.launchReadinessScore}/100 (${review.launchReadinessLabel})`,
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
