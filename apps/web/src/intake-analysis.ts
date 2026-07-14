export interface FileDescriptor {
  name: string;
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

export interface PhotoMetrics {
  fileName: string;
  width: number;
  height: number;
  brightness: number;
  contrast: number;
  saturation: number;
  sharpness: number;
}

export interface HeroCandidate extends PhotoMetrics {
  orientation: "landscape" | "portrait" | "square";
  heroScore: number;
  notes: string[];
}

export interface DirectorReview {
  storyAngle: string;
  buyerAngle: string;
  missingMedia: string[];
  actionItems: string[];
  launchReadinessScore: number;
  launchReadinessLabel: "Not Ready" | "Needs Work" | "Almost Ready" | "Launch Ready";
}

export interface IntakeSummary {
  address: string;
  listPrice: string;
  mediaCounts: MediaCounts;
  heroCandidates: HeroCandidate[];
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

function scoreBrightness(brightness: number): number {
  const target = 0.56;
  const distance = Math.min(Math.abs(brightness - target), 0.56);
  return Math.round((1 - distance / 0.56) * 100);
}

export function rankHeroCandidates(metrics: PhotoMetrics[]): HeroCandidate[] {
  return metrics
    .map((photo) => {
      const orientation: HeroCandidate["orientation"] =
        photo.width > photo.height ? "landscape" : photo.width < photo.height ? "portrait" : "square";

      const resolutionScore = normalize(photo.width * photo.height, 1000 * 700, 4200 * 2800);
      const sharpnessScore = normalize(photo.sharpness, 8, 60);
      const contrastScore = normalize(photo.contrast, 0.06, 0.24);
      const brightnessScore = scoreBrightness(photo.brightness);
      const saturationScore = normalize(photo.saturation, 0.12, 0.5);
      const orientationBonus = orientation === "landscape" ? 8 : orientation === "square" ? 3 : 0;

      const heroScore = Math.round(
        resolutionScore * 0.3 +
          sharpnessScore * 0.2 +
          contrastScore * 0.18 +
          brightnessScore * 0.2 +
          saturationScore * 0.12 +
          orientationBonus
      );

      const notes: string[] = [];
      if (heroScore >= 85) {
        notes.push("Strong hero candidate");
      }
      if (resolutionScore < 50) {
        notes.push("Low resolution");
      }
      if (sharpnessScore < 45) {
        notes.push("Soft focus");
      }
      if (brightnessScore < 45) {
        notes.push("Exposure imbalance");
      }
      if (saturationScore < 35) {
        notes.push("Muted color depth");
      }
      if (notes.length === 0) {
        notes.push("Balanced composition and clarity");
      }

      return {
        ...photo,
        orientation,
        heroScore: Math.max(1, Math.min(100, heroScore)),
        notes
      };
    })
    .sort((a, b) => b.heroScore - a.heroScore);
}

function parsePrice(listPrice: string): number {
  const parsed = Number(listPrice.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

export function buildDirectorReview(summary: IntakeSummary): DirectorReview {
  const { mediaCounts, heroCandidates } = summary;
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

  const photoDepthScore = normalize(mediaCounts.photos, 8, 36);
  const videoScore = mediaCounts.videos > 0 ? 100 : 35;
  const pdfScore = mediaCounts.pdfs > 0 ? 100 : 40;
  const docsScore = mediaCounts.documents > 0 ? 85 : 55;
  const topThree = heroCandidates.slice(0, 3);
  const heroDepth =
    topThree.length > 0 ? Math.round(topThree.reduce((total, item) => total + item.heroScore, 0) / topThree.length) : 0;

  const launchReadinessScore = Math.round(
    photoDepthScore * 0.35 + videoScore * 0.2 + pdfScore * 0.15 + docsScore * 0.1 + heroDepth * 0.2
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
    ? `Lead with ${summary.address} as a ${topHero.orientation} visual-first story emphasizing light, flow, and room-to-room continuity.`
    : `Position ${summary.address} as a practical, move-in ready opportunity with clear lifestyle benefits.`;

  const actionItems: string[] = [];
  if (heroCandidates.length > 0) {
    const leadCandidate = heroCandidates[0];
    if (leadCandidate) {
      actionItems.push(`Use ${leadCandidate.fileName} as primary hero candidate in launch package.`);
    }
  } else {
    actionItems.push("Capture bright, high-resolution exterior and main living-room images for hero selection.");
  }
  actionItems.push("Sequence gallery to tell a front-to-back home narrative in under 20 images.");
  if (mediaCounts.videos < 1) {
    actionItems.push("Record a 30-60 second walkthrough emphasizing kitchen, living, and primary suite.");
  }
  if (mediaCounts.pdfs < 1) {
    actionItems.push("Produce a one-page PDF feature sheet with upgrades, utilities, and school highlights.");
  }
  if (mediaCounts.documents < 1) {
    actionItems.push("Add property disclosures and room dimensions to strengthen buyer confidence.");
  }

  return {
    storyAngle,
    buyerAngle,
    missingMedia,
    actionItems,
    launchReadinessScore,
    launchReadinessLabel
  };
}

export function createTextReport(summary: IntakeSummary, review: DirectorReview): string {
  const topCandidates = summary.heroCandidates.slice(0, 5);

  const lines: string[] = [
    "Director Intake Report",
    "====================",
    `Generated: ${summary.generatedAt}`,
    `Address: ${summary.address}`,
    `List Price: ${summary.listPrice}`,
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

  lines.push("", "Action Items", "------------", ...review.actionItems.map((item, index) => `${index + 1}. ${item}`));

  lines.push("", "Top Hero Candidates", "-------------------");
  if (topCandidates.length === 0) {
    lines.push("No photo candidates analyzed.");
  } else {
    lines.push(
      ...topCandidates.map(
        (candidate, index) =>
          `${index + 1}. ${candidate.fileName} | Score ${candidate.heroScore} | ${candidate.orientation} | ${candidate.notes.join("; ")}`
      )
    );
  }

  return `${lines.join("\n")}\n`;
}
