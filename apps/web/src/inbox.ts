export type InboxKind =
  | "raw"
  | "edited"
  | "drone"
  | "video"
  | "floor-plan"
  | "matterport"
  | "brochure"
  | "contract"
  | "document"
  | "unknown";

export type InboxDecision = "accept" | "reject" | "ignore";

export interface InboxItem {
  id: string;
  fileName: string;
  filePath: string;
  size: number;
  type: string;
  kind: InboxKind;
  decision: InboxDecision;
  confidence: number;
  reasons: string[];
  recommendation: string;
  alreadyAnalyzed: boolean;
  locked: boolean;
  autoEditCandidate: boolean;
}

const RAW_EXTENSIONS = new Set(["cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2"]);
const EDITED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tiff", "tif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm"]);
const FLOOR_PLAN_KEYWORDS = ["floorplan", "floor-plan", "fp", "plan"];
const MATTERPORT_KEYWORDS = ["matterport", "3d", "virtual-tour", "tour"];
const DRONE_KEYWORDS = ["drone", "aerial", "birdseye", "bird-eye"];
const BROCHURE_KEYWORDS = ["brochure", "flyer", "feature-sheet", "features"];
const CONTRACT_KEYWORDS = [
  "contract",
  "purchase-agreement",
  "agreement",
  "escrow",
  "disclosure",
  "lease",
  "inspection",
  "appraisal",
  "invoice",
  "title",
  "hud",
  "closing"
];

function extension(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  if (parts.length < 2) {
    return "";
  }
  return parts[parts.length - 1] ?? "";
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function isDocumentLike(ext: string): boolean {
  return ["pdf", "doc", "docx", "txt", "rtf", "xlsx", "csv", "ppt", "pptx"].includes(ext);
}

function classifyKind(file: File): { kind: InboxKind; confidence: number; reasons: string[] } {
  const name = normalizeName(file.name);
  const ext = extension(file.name);
  const reasons: string[] = [];

  if (RAW_EXTENSIONS.has(ext)) {
    reasons.push(`RAW extension .${ext}`);
    return { kind: "raw", confidence: 0.96, reasons };
  }

  if (VIDEO_EXTENSIONS.has(ext) || file.type.startsWith("video/")) {
    reasons.push("Video media type/extension");
    return { kind: "video", confidence: 0.95, reasons };
  }

  if (MATTERPORT_KEYWORDS.some((keyword) => name.includes(keyword))) {
    reasons.push("Matterport keyword match");
    return { kind: "matterport", confidence: 0.92, reasons };
  }

  if (FLOOR_PLAN_KEYWORDS.some((keyword) => name.includes(keyword)) && (ext === "pdf" || EDITED_EXTENSIONS.has(ext))) {
    reasons.push("Floor plan keyword match");
    return { kind: "floor-plan", confidence: 0.9, reasons };
  }

  if (DRONE_KEYWORDS.some((keyword) => name.includes(keyword))) {
    reasons.push("Drone keyword match");
    return { kind: "drone", confidence: 0.88, reasons };
  }

  if (BROCHURE_KEYWORDS.some((keyword) => name.includes(keyword)) && ext === "pdf") {
    reasons.push("Brochure keyword match");
    return { kind: "brochure", confidence: 0.9, reasons };
  }

  if (CONTRACT_KEYWORDS.some((keyword) => name.includes(keyword)) && isDocumentLike(ext)) {
    reasons.push("Contract/document keyword match");
    return { kind: "contract", confidence: 0.93, reasons };
  }

  if (EDITED_EXTENSIONS.has(ext) || file.type.startsWith("image/")) {
    reasons.push("Edited image extension/type");
    return { kind: "edited", confidence: 0.87, reasons };
  }

  if (isDocumentLike(ext)) {
    reasons.push("Generic document extension");
    return { kind: "document", confidence: 0.65, reasons };
  }

  reasons.push("No strong signals");
  return { kind: "unknown", confidence: 0.4, reasons };
}

function normalizeStem(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  return normalizeName(base)
    .replace(/-(raw|edited|final|retouched|drone|aerial)\b/g, "")
    .replace(/-\d+\b/g, "");
}

export function buildInbox(files: File[], alreadyAnalyzedPaths: Set<string>): InboxItem[] {
  const initial = files.map((file) => {
    const filePath = file.webkitRelativePath || file.name;
    const cls = classifyKind(file);
    let decision: InboxDecision = "accept";
    let recommendation = "Ready to import into the project.";
    let locked = false;

    if (cls.kind === "contract" || cls.kind === "document") {
      decision = "ignore";
      recommendation = "Ignored automatically: likely contract or unrelated document.";
      locked = true;
    } else if (cls.kind === "unknown") {
      decision = "reject";
      recommendation = "Unknown file type. Review before importing.";
    } else if (cls.kind === "raw") {
      decision = "accept";
      recommendation = "RAW detected. Keep for future automatic editing workflows.";
    }

    if (alreadyAnalyzedPaths.has(filePath)) {
      recommendation = "Already analyzed in this project. Safe to skip or keep as unchanged.";
      decision = "reject";
    }

    return {
      id: `${filePath}::${file.size}::${file.lastModified}`,
      fileName: file.name,
      filePath,
      size: file.size,
      type: file.type,
      kind: cls.kind,
      decision,
      confidence: cls.confidence,
      reasons: cls.reasons,
      recommendation,
      alreadyAnalyzed: alreadyAnalyzedPaths.has(filePath),
      locked,
      autoEditCandidate: cls.kind === "raw"
    } satisfies InboxItem;
  });

  const byStem = new Map<string, InboxItem[]>();
  for (const item of initial) {
    const stem = normalizeStem(item.filePath);
    const list = byStem.get(stem) ?? [];
    list.push(item);
    byStem.set(stem, list);
  }

  for (const [, group] of byStem) {
    const hasRaw = group.some((item) => item.kind === "raw");
    const edited = group.filter((item) => item.kind === "edited");

    if (hasRaw && edited.length > 0) {
      for (const item of group) {
        if (item.kind === "raw") {
          item.recommendation = "RAW + edited pair found. Keep RAW for future auto-editing, but prioritize edited for publish.";
          item.autoEditCandidate = true;
        }

        if (item.kind === "edited") {
          item.recommendation = "RAW + edited pair found. Prefer edited version for immediate analysis and launch.";
          item.decision = "accept";
        }
      }
    }
  }

  return initial;
}

export function classifyCounts(items: InboxItem[]): Record<InboxKind, number> {
  return items.reduce(
    (acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    },
    {
      raw: 0,
      edited: 0,
      drone: 0,
      video: 0,
      "floor-plan": 0,
      matterport: 0,
      brochure: 0,
      contract: 0,
      document: 0,
      unknown: 0
    } as Record<InboxKind, number>
  );
}

export function acceptedFiles(items: InboxItem[], files: File[]): File[] {
  const acceptedIds = new Set(items.filter((item) => item.decision === "accept").map((item) => item.id));
  return files.filter((file) => {
    const filePath = file.webkitRelativePath || file.name;
    const id = `${filePath}::${file.size}::${file.lastModified}`;
    return acceptedIds.has(id);
  });
}
