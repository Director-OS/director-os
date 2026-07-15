import {
  assessPhotos,
  buildDirectorReview,
  classifyMedia,
  createTextReport,
  isImageDescriptor,
  type DirectorReview,
  type DecisionTag,
  type FileDescriptor,
  type IntakeSummary,
  type PhotoAssessment,
  type PhotoMetrics,
  type SceneTag
} from "./intake-analysis.js";
import { PROBLEM_LABELS, SCENE_TAGS } from "./vision-engine.js";
import {
  activeMedia,
  applyProjectStatus,
  attachAssessments,
  deleteProjectMedia,
  getOrCreateProject,
  listProjects,
  loadProject,
  mergeAssessmentsWithHistory,
  projectFacts,
  projectSummaryFromStored,
  pushProjectActivity,
  saveProject,
  syncUploadIntoProject,
  upsertProjectWalkthrough,
  updateMediaMetrics,
  walkthroughIndicators,
  type DirectorProject
} from "./projects.js";
import {
  acceptedFiles,
  buildInbox,
  classifyCounts,
  type InboxDecision,
  type InboxItem
} from "./inbox.js";
import { getTranscriptionProvider } from "./transcription.js";
import {
  addManualFact,
  applyFactDecisionToWalkthrough,
  createWalkthroughRecord,
  detectFactConflicts,
  formatTimestamp,
  parseTranscriptImport,
  searchWalkthrough,
  transitionRecorderState,
  updateWalkthroughTranscript,
  type FactDecision,
  type FactStatus,
  type RecorderStatus,
  type WalkthroughRecord,
  type WalkthroughSearchResult
} from "./walkthrough.js";

type FilterTag = "all" | "recommended" | "needs-work" | "remove";
type WorkspaceView =
  | "overview"
  | "walkthrough"
  | "inbox"
  | "photos"
  | "drone"
  | "video"
  | "floor-plans"
  | "tour"
  | "documents"
  | "marketing"
  | "mls"
  | "activity"
  | "director-review";

const WORKSPACE_VIEWS: WorkspaceView[] = [
  "overview",
  "walkthrough",
  "inbox",
  "photos",
  "drone",
  "video",
  "floor-plans",
  "tour",
  "documents",
  "marketing",
  "mls",
  "activity",
  "director-review"
];

type PhotoFlagKey = "rankLocked" | "favorite" | "hero" | "needsEditing" | "readyForMls";

interface PhotoOverride {
  sceneTag?: SceneTag;
  decision?: DecisionTag;
  rank?: number;
  rankLocked?: boolean;
  favorite?: boolean;
  hero?: boolean;
  needsEditing?: boolean;
  readyForMls?: boolean;
}

interface AppState {
  files: File[];
  inboxItems: InboxItem[];
  summary: IntakeSummary | null;
  photoAssessments: PhotoAssessment[];
  filter: FilterTag;
  overrides: Record<string, PhotoOverride>;
  currentProjectId: string | null;
  projects: DirectorProject[];
  pendingReplacePath: string | null;
  currentView: WorkspaceView;
  inboxSearch: string;
  inboxKindFilter: string;
  inboxDecisionFilter: string;
  selectedPhotoPath: string | null;
  selectedWalkthroughId: string | null;
  walkthroughTranscriptQuery: string;
  walkthroughProjectQuery: string;
  recordingStatus: RecorderStatus;
  recordingElapsedMs: number;
  pendingAudioBlob: Blob | null;
  pendingAudioMimeType: string | null;
  recordingChunks: Blob[];
  recordingStartedAtMs: number | null;
  recordingTimerId: number | null;
  recorder: MediaRecorder | null;
  recordingStream: MediaStream | null;
  transcriptionMode: string;
  previewZoom: number;
  recommendationDecisions: Record<string, "accept" | "reject" | "ignore">;
  showInboxDetails: boolean;
  sourceUrlsByPath: Record<string, string>;
}

const state: AppState = {
  files: [],
  inboxItems: [],
  summary: null,
  photoAssessments: [],
  filter: "all",
  overrides: {},
  currentProjectId: null,
  projects: [],
  pendingReplacePath: null,
  currentView: "overview",
  inboxSearch: "",
  inboxKindFilter: "all",
  inboxDecisionFilter: "all",
  selectedPhotoPath: null,
  selectedWalkthroughId: null,
  walkthroughTranscriptQuery: "",
  walkthroughProjectQuery: "",
  recordingStatus: "idle",
  recordingElapsedMs: 0,
  pendingAudioBlob: null,
  pendingAudioMimeType: null,
  recordingChunks: [],
  recordingStartedAtMs: null,
  recordingTimerId: null,
  recorder: null,
  recordingStream: null,
  transcriptionMode: "mock-local",
  previewZoom: 1,
  recommendationDecisions: {},
  showInboxDetails: false,
  sourceUrlsByPath: {}
};

const photoMetricsCache = new Map<string, PhotoMetrics>();

function toMetricClass(value: number): "good" | "warn" | "bad" {
  if (value >= 75) {
    return "good";
  }
  if (value >= 50) {
    return "warn";
  }
  return "bad";
}

function prettySceneTag(tag: SceneTag): string {
  if (tag === "miscellaneous") {
    return "Unknown / Needs Review";
  }
  return tag.replace(/-/g, " ");
}

function sceneLabelFromDetection(sceneTag: SceneTag, confidence: number): string {
  if (sceneTag === "miscellaneous" || confidence < 0.66) {
    return "Unknown / Needs Review";
  }
  return prettySceneTag(sceneTag);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function prettyFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  const cleaned = base
    .replace(/[_-]+/g, " ")
    .replace(/\b(img|dsc|photo|edit|edited|final|retouched)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.replace(/\b\w/g, (match) => match.toUpperCase()) : fileName;
}

function mediaPath(filePath: string, fileName: string): string {
  return `${filePath} ${fileName}`.toLowerCase();
}

function buildReviewContext(project: DirectorProject, summary: IntakeSummary): Parameters<typeof buildDirectorReview>[1] {
  const media = activeMedia(project);
  const photos = summary.photos;
  const rawCount = media.filter((item) => /\.(cr2|cr3|nef|arw|dng|raf|orf|rw2)$/i.test(item.fileName)).length;
  const editedCount = media.filter((item) => /\.(jpg|jpeg|png|webp|heic|heif|avif|tif|tiff)$/i.test(item.fileName)).length;
  const droneCount = media.filter((item) => mediaPath(item.filePath, item.fileName).includes("drone") || mediaPath(item.filePath, item.fileName).includes("aerial")).length;
  const floorPlanCount = media.filter((item) => isFloorPlanPath(item.filePath)).length;
  const matterportCount = media.filter((item) => mediaPath(item.filePath, item.fileName).includes("matterport") || mediaPath(item.filePath, item.fileName).includes("tour")).length;
  const walkthroughCount = project.walkthroughs.length;
  const sellerFactsCount = projectFacts(project).filter((fact) => /seller|price|timing|possession|priority|showing|closing|pet/i.test(fact.category)).length;
  const readyForMls = Object.entries(state.overrides).filter(([, value]) => Boolean(value.readyForMls)).length;
  const mlsCompletion = photos.length > 0 ? readyForMls / photos.length : 0;
  const marketingCompletion = photos.length > 0 ? photos.filter((item) => item.decision === "recommended").length / photos.length : 0;

  return {
    rawCount,
    editedCount,
    droneCount,
    floorPlanCount,
    matterportCount: matterportCount + (project.tourLinks.matterportUrl ? 1 : 0),
    walkthroughCount,
    sellerFactsCount,
    mlsCompletion,
    marketingCompletion
  };
}

function isFloorPlanPath(path: string): boolean {
  const normalized = path.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return ["floorplan", "floor-plan", "floor_plan", "fp", "plan"].some((keyword) => normalized.includes(keyword));
}

function validateTourUrl(value: string): { valid: boolean; reason: string } {
  if (!value.trim()) {
    return { valid: true, reason: "" };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { valid: false, reason: "Only http/https URLs are supported." };
    }
    return { valid: true, reason: "" };
  } catch {
    return { valid: false, reason: "Invalid URL format." };
  }
}

async function collectDroppedFiles(dataTransfer: DataTransfer | null): Promise<File[]> {
  if (!dataTransfer) {
    return [];
  }

  const direct = Array.from(dataTransfer.files ?? []);
  const items = Array.from(dataTransfer.items ?? []);
  const hasEntries = items.some((item) => typeof (item as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry === "function");

  if (!hasEntries) {
    return direct;
  }

  const collected: File[] = [];

  const readFileEntry = async (entry: FileSystemFileEntry): Promise<void> => {
    await new Promise<void>((resolve) => {
      entry.file(
        (file) => {
          collected.push(file);
          resolve();
        },
        () => resolve()
      );
    });
  };

  const readDirectoryEntry = async (entry: FileSystemDirectoryEntry): Promise<void> => {
    const reader = entry.createReader();
    const readEntries = async (): Promise<FileSystemEntry[]> => {
      return await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries((entries) => resolve(entries), () => resolve([]));
      });
    };

    while (true) {
      const entries = await readEntries();
      if (entries.length === 0) {
        break;
      }
      for (const child of entries) {
        if (child.isFile) {
          await readFileEntry(child as FileSystemFileEntry);
        } else if (child.isDirectory) {
          await readDirectoryEntry(child as FileSystemDirectoryEntry);
        }
      }
    }
  };

  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (!entry) {
      continue;
    }
    if (entry.isFile) {
      await readFileEntry(entry as FileSystemFileEntry);
    } else if (entry.isDirectory) {
      await readDirectoryEntry(entry as FileSystemDirectoryEntry);
    }
  }

  return collected.length > 0 ? collected : direct;
}

function extractChannelMetrics(pixels: Uint8ClampedArray): {
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
} {
  const channelCount = Math.floor(pixels.length / 4);
  if (channelCount === 0) {
    return {
      brightness: 0.5,
      contrast: 0,
      saturation: 0,
      sharpness: 0,
      edgeDensity: 0,
      blueRatio: 0,
      greenRatio: 0,
      warmRatio: 0,
      brightPixelRatio: 0,
      darkPixelRatio: 0,
      perceptualHash: "",
      colorHistogram: []
    };
  }

  let lumaSum = 0;
  let lumaSquaredSum = 0;
  let saturationSum = 0;
  let blueCount = 0;
  let greenCount = 0;
  let warmCount = 0;
  let brightCount = 0;
  let darkCount = 0;

  const luminanceValues = new Float32Array(channelCount);
  const colorHistogram = new Array<number>(12).fill(0);

  for (let index = 0, pixelIndex = 0; pixelIndex < pixels.length; index += 1, pixelIndex += 4) {
    const r = (pixels[pixelIndex] ?? 0) / 255;
    const g = (pixels[pixelIndex + 1] ?? 0) / 255;
    const b = (pixels[pixelIndex + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    if (b > r + 0.06 && b > g + 0.04) {
      blueCount += 1;
    }
    if (g > r + 0.03 && g > b + 0.03) {
      greenCount += 1;
    }
    if (r > b + 0.04 && r > g * 0.8) {
      warmCount += 1;
    }
    if (luma > 0.82) {
      brightCount += 1;
    }
    if (luma < 0.18) {
      darkCount += 1;
    }

    const redBin = Math.min(3, Math.floor(r * 4));
    const greenBin = Math.min(3, Math.floor(g * 4));
    const blueBin = Math.min(3, Math.floor(b * 4));
    colorHistogram[redBin] = (colorHistogram[redBin] ?? 0) + 1;
    colorHistogram[4 + greenBin] = (colorHistogram[4 + greenBin] ?? 0) + 1;
    colorHistogram[8 + blueBin] = (colorHistogram[8 + blueBin] ?? 0) + 1;

    luminanceValues[index] = luma;
    saturationSum += sat;
    lumaSum += luma;
    lumaSquaredSum += luma * luma;
  }

  const meanLuma = lumaSum / channelCount;
  const variance = Math.max(lumaSquaredSum / channelCount - meanLuma * meanLuma, 0);
  const contrast = Math.sqrt(variance);
  const saturation = saturationSum / channelCount;

  let sharpnessSum = 0;
  let edgeCount = 0;
  for (let index = 1; index < luminanceValues.length - 1; index += 1) {
    const previous = luminanceValues[index - 1] ?? 0;
    const current = luminanceValues[index] ?? 0;
    const next = luminanceValues[index + 1] ?? 0;
    const edgeValue = Math.abs(previous - 2 * current + next);
    sharpnessSum += edgeValue;
    if (edgeValue > 0.14) {
      edgeCount += 1;
    }
  }

  const sharpness = (sharpnessSum / Math.max(luminanceValues.length - 2, 1)) * 255;
  const edgeDensity = edgeCount / Math.max(luminanceValues.length - 2, 1);

  const hashSize = 8;
  const hashBits: string[] = [];
  const sampleStep = Math.max(1, Math.floor(luminanceValues.length / (hashSize * hashSize)));
  const samples: number[] = [];
  for (let index = 0; index < hashSize * hashSize; index += 1) {
    const sampleValue = luminanceValues[Math.min(luminanceValues.length - 1, index * sampleStep)] ?? 0;
    samples.push(sampleValue);
  }
  const sampleMean = samples.reduce((total, value) => total + value, 0) / Math.max(samples.length, 1);
  for (const sample of samples) {
    hashBits.push(sample >= sampleMean ? "1" : "0");
  }

  const normalizedHistogram = colorHistogram.map((value) => value / (channelCount * 3));

  return {
    brightness: meanLuma,
    contrast,
    saturation,
    sharpness,
    edgeDensity,
    blueRatio: blueCount / channelCount,
    greenRatio: greenCount / channelCount,
    warmRatio: warmCount / channelCount,
    brightPixelRatio: brightCount / channelCount,
    darkPixelRatio: darkCount / channelCount,
    perceptualHash: hashBits.join(""),
    colorHistogram: normalizedHistogram
  };
}

async function analyzePhoto(file: File, forcedPath?: string): Promise<PhotoMetrics> {
  const cacheKey = `${forcedPath ?? file.webkitRelativePath ?? file.name}::${file.size}::${file.lastModified}`;
  const cached = photoMetricsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const bitmap = await createImageBitmap(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  const maxDimension = 360;
  const scale = Math.min(maxDimension / bitmap.width, maxDimension / bitmap.height, 1);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Unable to initialize image analysis context");
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const pixels = context.getImageData(0, 0, width, height).data;
  const channelMetrics = extractChannelMetrics(pixels);

  const result: PhotoMetrics = {
    fileName: file.name,
    filePath: forcedPath ?? file.webkitRelativePath ?? file.name,
    thumbnailUrl: URL.createObjectURL(file),
    width: originalWidth,
    height: originalHeight,
    brightness: channelMetrics.brightness,
    contrast: channelMetrics.contrast,
    saturation: channelMetrics.saturation,
    sharpness: channelMetrics.sharpness,
    edgeDensity: channelMetrics.edgeDensity,
    blueRatio: channelMetrics.blueRatio,
    greenRatio: channelMetrics.greenRatio,
    warmRatio: channelMetrics.warmRatio,
    brightPixelRatio: channelMetrics.brightPixelRatio,
    darkPixelRatio: channelMetrics.darkPixelRatio,
    perceptualHash: channelMetrics.perceptualHash,
    colorHistogram: channelMetrics.colorHistogram
  };

  photoMetricsCache.set(cacheKey, result);
  return result;
}

function setProgress(percent: number, text: string): void {
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");

  if (progressBar) {
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  if (progressText) {
    progressText.textContent = text;
  }
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function photoByPath(path: string): PhotoAssessment | null {
  return effectivePhotos().find((photo) => photo.filePath === path) ?? null;
}

function focusPhoto(path: string): void {
  state.selectedPhotoPath = path;
  setWorkspaceView("photos");
  renderPhotoWorkspace();
}

function openImagePreview(photo: PhotoAssessment): void {
  const modal = document.getElementById("photoPreviewModal");
  const image = document.getElementById("photoPreviewImage") as HTMLImageElement | null;
  const title = document.getElementById("photoPreviewTitle");
  const zoomValue = document.getElementById("photoPreviewZoom");
  if (!modal || !image || !title) {
    return;
  }
  state.selectedPhotoPath = photo.filePath;
  state.previewZoom = 1;
  image.src = photo.thumbnailUrl;
  image.alt = prettyFileName(photo.fileName);
  image.style.transform = `scale(${state.previewZoom})`;
  title.textContent = `${prettyFileName(photo.fileName)} | ${photo.width}x${photo.height}`;
  if (zoomValue) {
    zoomValue.textContent = `${Math.round(state.previewZoom * 100)}%`;
  }
  modal.classList.remove("hidden");
}

function updatePreviewFromSelected(): void {
  const selected = state.selectedPhotoPath ? photoByPath(state.selectedPhotoPath) : null;
  if (!selected) {
    return;
  }
  const image = document.getElementById("photoPreviewImage") as HTMLImageElement | null;
  const title = document.getElementById("photoPreviewTitle");
  const zoomValue = document.getElementById("photoPreviewZoom");
  if (!image || !title) {
    return;
  }
  image.src = selected.thumbnailUrl;
  image.alt = prettyFileName(selected.fileName);
  image.style.transform = `scale(${state.previewZoom})`;
  title.textContent = `${prettyFileName(selected.fileName)} | ${selected.width}x${selected.height}`;
  if (zoomValue) {
    zoomValue.textContent = `${Math.round(state.previewZoom * 100)}%`;
  }
}

function stepPreview(direction: 1 | -1): void {
  const photos = [...effectivePhotos()].sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);
  if (photos.length === 0) {
    return;
  }
  const currentIndex = state.selectedPhotoPath ? photos.findIndex((item) => item.filePath === state.selectedPhotoPath) : -1;
  const nextIndex = currentIndex >= 0 ? (currentIndex + direction + photos.length) % photos.length : 0;
  state.selectedPhotoPath = photos[nextIndex]?.filePath ?? photos[0]?.filePath ?? null;
  updatePreviewFromSelected();
}

function adjustPreviewZoom(delta: number): void {
  state.previewZoom = Math.max(0.5, Math.min(3, state.previewZoom + delta));
  updatePreviewFromSelected();
}

function closeImagePreview(): void {
  const modal = document.getElementById("photoPreviewModal");
  const image = document.getElementById("photoPreviewImage") as HTMLImageElement | null;
  if (!modal || !image) {
    return;
  }
  modal.classList.add("hidden");
  image.src = "";
  state.previewZoom = 1;
}

function currentProject(): DirectorProject | null {
  if (!state.currentProjectId) {
    return null;
  }
  return loadProject(state.currentProjectId);
}

function ensureCurrentProject(): DirectorProject | null {
  const existing = currentProject();
  if (existing) {
    return existing;
  }

  const addressInput = document.getElementById("address") as HTMLInputElement | null;
  const priceInput = document.getElementById("price") as HTMLInputElement | null;
  const address = addressInput?.value.trim() ?? "";
  const price = priceInput?.value.trim() ?? "";
  if (!address) {
    const msg = "Property address is required before creating a project.";
    setText("inboxSummary", msg);
    return null;
  }

  const created = getOrCreateProject(address, price);
  state.currentProjectId = created.id;
  state.selectedWalkthroughId = created.walkthroughs[0]?.id ?? null;
  renderProjectDashboard();
  renderProjectStatus();
  return created;
}

function refreshProjects(): void {
  state.projects = listProjects();
}

function currentWalkthrough(): WalkthroughRecord | null {
  const project = currentProject();
  if (!project) {
    return null;
  }
  if (!state.selectedWalkthroughId) {
    return project.walkthroughs[0] ?? null;
  }
  return project.walkthroughs.find((item) => item.id === state.selectedWalkthroughId) ?? project.walkthroughs[0] ?? null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function setRecordingStatusMessage(message: string): void {
  setText("walkthroughStatusMessage", message);
}

function isMediaRecorderSupported(): boolean {
  return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && typeof navigator?.mediaDevices?.getUserMedia === "function";
}

function setRecordingStatus(next: RecorderStatus): void {
  state.recordingStatus = next;
  setText("walkthroughRecordingStatus", next.replace(/^[a-z]/, (match) => match.toUpperCase()));

  const start = document.getElementById("walkthroughStartBtn") as HTMLButtonElement | null;
  const pause = document.getElementById("walkthroughPauseBtn") as HTMLButtonElement | null;
  const resume = document.getElementById("walkthroughResumeBtn") as HTMLButtonElement | null;
  const stop = document.getElementById("walkthroughStopBtn") as HTMLButtonElement | null;
  const save = document.getElementById("walkthroughSaveBtn") as HTMLButtonElement | null;
  if (!start || !pause || !resume || !stop || !save) {
    return;
  }

  const isRecording = next === "recording";
  const isPaused = next === "paused";
  const canSave = next === "stopped" && state.pendingAudioBlob !== null;

  start.disabled = isRecording || isPaused;
  pause.disabled = !isRecording;
  resume.disabled = !isPaused;
  stop.disabled = !(isRecording || isPaused);
  save.disabled = !canSave;
}

function stopRecordingTicker(): void {
  if (state.recordingTimerId !== null) {
    window.clearInterval(state.recordingTimerId);
    state.recordingTimerId = null;
  }
}

function startRecordingTicker(): void {
  stopRecordingTicker();
  state.recordingStartedAtMs = Date.now() - state.recordingElapsedMs;
  state.recordingTimerId = window.setInterval(() => {
    if (state.recordingStartedAtMs === null) {
      return;
    }
    state.recordingElapsedMs = Date.now() - state.recordingStartedAtMs;
    setText("walkthroughElapsed", formatElapsed(state.recordingElapsedMs));
  }, 250);
}

function updateWalkthroughIndicators(): void {
  const project = currentProject();
  const indicators = project ? walkthroughIndicators(project) : { newFacts: 0, needsVerification: 0 };
  setText("walkthroughNewFactsIndicator", `${indicators.newFacts} new facts`);
  setText("walkthroughNeedsVerificationIndicator", `${indicators.needsVerification} needs verification`);
}

function saveWalkthroughToProject(walkthrough: WalkthroughRecord, activityMessage: string): void {
  const project = currentProject();
  if (!project) {
    return;
  }

  const existingFacts = projectFacts(project).filter((fact) => fact.sourceWalkthroughId !== walkthrough.id);
  const withConflicts = {
    ...walkthrough,
    conflicts: detectFactConflicts(walkthrough.facts, existingFacts)
  };

  let updated = upsertProjectWalkthrough(project, withConflicts);
  updated = pushProjectActivity(updated, {
    type: "walkthrough",
    message: activityMessage
  });
  saveProject(updated);
  state.selectedWalkthroughId = withConflicts.id;
  renderProjectDashboard();
  renderProjectStatus();
  renderActivityFeed();
  updateWalkthroughIndicators();
}

function walkthroughSearchAcrossProject(project: DirectorProject, query: string): WalkthroughSearchResult {
  const aggregate: WalkthroughSearchResult = {
    transcriptMatches: [],
    factMatches: [],
    relatedTasks: [],
    relatedRisks: []
  };

  for (const walkthrough of project.walkthroughs) {
    const result = searchWalkthrough(walkthrough, query);
    aggregate.transcriptMatches.push(...result.transcriptMatches);
    aggregate.factMatches.push(...result.factMatches);
    aggregate.relatedTasks.push(...result.relatedTasks);
    aggregate.relatedRisks.push(...result.relatedRisks);
  }

  return {
    transcriptMatches: aggregate.transcriptMatches.slice(0, 20),
    factMatches: aggregate.factMatches.slice(0, 20),
    relatedTasks: aggregate.relatedTasks.slice(0, 20),
    relatedRisks: aggregate.relatedRisks.slice(0, 20)
  };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = reader.result;
      if (typeof value === "string") {
        resolve(value);
      } else {
        reject(new Error("Failed to convert blob to data URL"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

function renderProjectDashboard(): void {
  const list = document.getElementById("projectList");
  if (!list) {
    return;
  }

  refreshProjects();
  list.innerHTML = "";

  if (state.projects.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No projects yet. Analyze a property to create one.";
    list.appendChild(li);
    return;
  }

  for (const project of state.projects) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary project-link";
    if (project.id === state.currentProjectId) {
      button.classList.add("active-project");
    }
    const analyzed = project.lastAnalyzedAt ? new Date(project.lastAnalyzedAt).toLocaleString() : "never";
    button.textContent = `${project.address} | Updated ${new Date(project.updatedAt).toLocaleDateString()} | Last analyzed ${analyzed}`;
    button.dataset.projectId = project.id;
    li.appendChild(button);
    list.appendChild(li);
  }
}

function renderProjectStatus(): void {
  const project = currentProject();
  if (!project) {
    setText("statusMediaComplete", "No");
    setText("statusMarketingComplete", "No");
    setText("statusMlsReady", "No");
    setText("statusLaunchReady", "No");
    setText("newSinceLastAnalysis", "0");
    setText("lastUploadAt", "-");
    updateList("uploadHistory", [], "No uploads yet.");
    return;
  }

  setText("statusMediaComplete", project.status.mediaComplete ? "Yes" : "No");
  setText("statusMarketingComplete", project.status.marketingComplete ? "Yes" : "No");
  setText("statusMlsReady", project.status.mlsReady ? "Yes" : "No");
  setText("statusLaunchReady", project.status.launchReady ? "Yes" : "No");
  setText("newSinceLastAnalysis", `${project.newSinceLastAnalysis}`);
  setText("lastUploadAt", project.lastUploadAt ? new Date(project.lastUploadAt).toLocaleString() : "-");
  updateList(
    "uploadHistory",
    project.uploadHistory.slice(0, 8).map(
      (item) =>
        `${new Date(item.uploadedAt).toLocaleString()} | files ${item.fileCount} | new ${item.newCount} | existing ${item.existingCount}${item.note ? ` | ${item.note}` : ""}`
    ),
    "No uploads yet."
  );
}

function directorConfidence(summary: IntakeSummary | null): number {
  if (!summary || summary.photos.length === 0) {
    return 0;
  }
  const avg = Math.round(summary.photos.reduce((total, photo) => total + photo.heroScore, 0) / summary.photos.length);
  return Math.max(0, Math.min(100, Math.round(avg * 0.8 + summary.mediaCounts.photos * 0.5)));
}

function projectLastActivity(project: DirectorProject | null): string {
  if (!project || project.activity.length === 0) {
    return "No activity yet.";
  }
  const latest = project.activity[0];
  return `${new Date(latest?.at ?? "").toLocaleString()} - ${latest?.message ?? ""}`;
}

function renderOverviewWorkspace(): void {
  const project = currentProject();
  const summary = state.summary;
  const review = summary && project ? buildDirectorReview(summary, buildReviewContext(project, summary)) : null;

  setText("overviewAddress", project?.address ?? "-");
  setText("overviewPrice", project?.listPrice ?? "-");
  setText("overviewLaunch", review ? `${review.launchReadinessScore}/100 (${review.launchReadinessLabel})` : "-");
  setText("overviewConfidence", `${directorConfidence(summary)}%`);
  setText("overviewLastActivity", projectLastActivity(project));

  const missingItems: string[] = [];
  if (review) {
    missingItems.push(...review.missingMedia.slice(0, 4));
    missingItems.push(...review.missingShotChecklist.slice(0, 4));
  }
  updateList("overviewMissing", missingItems, "No missing items detected.");

  const nextAction =
    review?.actionItems[0] ??
    (state.inboxItems.some((item) => item.decision === "accept")
      ? "Import accepted Inbox files into this workspace."
      : "Import media into Inbox to continue workspace analysis.");
  setText("overviewNextAction", nextAction);
}

function renderActivityFeed(): void {
  const project = currentProject();
  const list = document.getElementById("activityFeed");
  if (!list) {
    return;
  }

  const items = project?.activity ?? [];
  list.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No activity yet.";
    list.appendChild(li);
    return;
  }

  for (const item of items.slice(0, 50)) {
    const li = document.createElement("li");
    li.textContent = `${new Date(item.at).toLocaleString()} | ${item.type} | ${item.message}`;
    list.appendChild(li);
  }
}

function renderAssetPanels(): void {
  const project = currentProject();
  if (!project) {
    setText("droneCount", "0");
    setText("videoWorkspaceCount", "0");
    setText("floorPlanCount", "0");
    setText("tourCount", "0");
    setText("documentWorkspaceCount", "0");
    setText("mlsReadyPhotos", "0");
    return;
  }

  const media = activeMedia(project);
  const byName = (needle: string) => media.filter((item) => `${item.fileName} ${item.filePath}`.toLowerCase().includes(needle));
  const drone = byName("drone").length + byName("aerial").length;
  const floorPlans = media.filter((item) => isFloorPlanPath(item.filePath)).length;
  const linkedTours = [project.tourLinks.matterportUrl, project.tourLinks.zillow3dUrl, project.tourLinks.virtualTourUrl].filter(Boolean).length;
  const tours = byName("matterport").length + byName("tour").length + linkedTours;
  const docs = media.filter((item) => ["pdf", "doc", "docx", "txt", "rtf"].some((ext) => item.fileName.toLowerCase().endsWith(`.${ext}`))).length;
  const videos = media.filter((item) => ["mp4", "mov", "m4v", "avi", "mkv", "webm"].some((ext) => item.fileName.toLowerCase().endsWith(`.${ext}`))).length;
  const readyForMls = Object.entries(state.overrides).filter(([, value]) => Boolean(value.readyForMls)).length;

  setText("droneCount", `${drone}`);
  setText("videoWorkspaceCount", `${videos}`);
  setText("floorPlanCount", `${floorPlans}`);
  setText("tourCount", `${tours}`);
  setText("documentWorkspaceCount", `${docs}`);
  setText("mlsReadyPhotos", `${readyForMls}`);
}

function isImagePath(path: string): boolean {
  return /\.(jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tif|tiff)$/i.test(path);
}

function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function renderFloorPlanWorkspace(): void {
  const gallery = document.getElementById("floorPlanGallery");
  if (!gallery) {
    return;
  }

  const project = currentProject();
  if (!project) {
    gallery.innerHTML = "<p>Open or create a project to review floor plans.</p>";
    return;
  }

  const floorPlans = activeMedia(project).filter((item) => isFloorPlanPath(item.filePath));
  if (floorPlans.length === 0) {
    gallery.innerHTML = "<p>No floor plans detected yet.</p>";
    return;
  }

  gallery.innerHTML = floorPlans
    .map((item) => {
      const sourceUrl = state.sourceUrlsByPath[item.filePath];
      const canImagePreview = Boolean(sourceUrl && isImagePath(item.fileName));
      const canPdfOpen = Boolean(sourceUrl && isPdfPath(item.fileName));
      const previewButton = canImagePreview
        ? `<button type="button" class="secondary floor-plan-preview" data-path="${item.filePath}">Preview</button>`
        : canPdfOpen
          ? `<a class="secondary floor-plan-open" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">Open PDF</a>`
          : `<button type="button" class="secondary" disabled>No local preview</button>`;
      const downloadButton = sourceUrl
        ? `<a class="secondary floor-plan-open" href="${sourceUrl}" download="${item.fileName}">Download</a>`
        : `<button type="button" class="secondary" disabled>Download unavailable</button>`;
      const thumb = canImagePreview
        ? `<img loading="lazy" src="${sourceUrl}" alt="${item.fileName}" class="thumb" />`
        : `<div class="thumb floor-plan-thumb">${isPdfPath(item.fileName) ? "PDF" : "FILE"}</div>`;
      return `<article class="floor-plan-item">${thumb}<div><strong>${prettyFileName(item.fileName)}</strong><small>Source: ${item.filePath}</small><div class="button-row">${previewButton}${downloadButton}</div></div></article>`;
    })
    .join("");
}

function renderTourWorkspace(): void {
  const project = currentProject();
  const matterportInput = document.getElementById("matterportUrl") as HTMLInputElement | null;
  const zillowInput = document.getElementById("zillow3dUrl") as HTMLInputElement | null;
  const virtualTourInput = document.getElementById("virtualTourUrl") as HTMLInputElement | null;
  const status = document.getElementById("tourLinkStatus");
  if (!matterportInput || !zillowInput || !virtualTourInput || !status) {
    return;
  }

  matterportInput.value = project?.tourLinks.matterportUrl ?? "";
  zillowInput.value = project?.tourLinks.zillow3dUrl ?? "";
  virtualTourInput.value = project?.tourLinks.virtualTourUrl ?? "";

  if (!project) {
    status.textContent = "Open or create a project to save tour links.";
    return;
  }

  const values = [project.tourLinks.matterportUrl, project.tourLinks.zillow3dUrl, project.tourLinks.virtualTourUrl].filter(Boolean);
  status.textContent = values.length > 0
    ? `Stored ${values.length} tour link(s). Architecture ready for future AI tour evaluation.`
    : "No tour links saved yet.";
}

function renderWalkthroughWorkspace(): void {
  const project = currentProject();
  const history = document.getElementById("walkthroughHistory");
  const original = document.getElementById("walkthroughOriginalTranscript");
  const edited = document.getElementById("walkthroughEditedTranscript") as HTMLTextAreaElement | null;
  const factsEl = document.getElementById("walkthroughFacts");
  const debriefEl = document.getElementById("walkthroughDebrief");
  const conflictsEl = document.getElementById("walkthroughConflicts");
  const matchesEl = document.getElementById("walkthroughTranscriptMatches");
  const projectSearchEl = document.getElementById("walkthroughProjectSearchResults");
  const support = document.getElementById("walkthroughSupport");
  const timelineEl = document.getElementById("walkthroughTimeline");
  const propertyFactsEl = document.getElementById("walkthroughPropertyFacts");
  const sellerSummaryEl = document.getElementById("walkthroughSellerSummary");
  const followUpEl = document.getElementById("walkthroughFollowUpQuestions");
  const listingNotesEl = document.getElementById("walkthroughListingNotes") as HTMLTextAreaElement | null;
  if (
    !history ||
    !original ||
    !edited ||
    !factsEl ||
    !debriefEl ||
    !conflictsEl ||
    !matchesEl ||
    !projectSearchEl ||
    !support ||
    !timelineEl ||
    !propertyFactsEl ||
    !sellerSummaryEl ||
    !followUpEl ||
    !listingNotesEl
  ) {
    return;
  }

  support.textContent = isMediaRecorderSupported() ? "MediaRecorder supported" : "MediaRecorder unavailable";
  setText("walkthroughElapsed", formatElapsed(state.recordingElapsedMs));
  setRecordingStatus(state.recordingStatus);

  const walkthroughs = project?.walkthroughs ?? [];
  history.innerHTML = "";
  if (walkthroughs.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No walkthroughs saved yet.";
    history.appendChild(li);
  } else {
    for (const walkthrough of walkthroughs) {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="secondary ${state.selectedWalkthroughId === walkthrough.id ? "active-project" : ""}" data-walkthrough-select="${walkthrough.id}">${walkthrough.title} | ${new Date(walkthrough.updatedAt).toLocaleString()}</button>`;
      history.appendChild(li);
    }
  }

  const selected = currentWalkthrough();
  if (!selected) {
    original.textContent = "No transcript selected.";
    edited.value = "";
    factsEl.innerHTML = "<p>No extracted facts yet.</p>";
    debriefEl.innerHTML = "<p>No debrief available.</p>";
    conflictsEl.innerHTML = "<li>No conflicts detected.</li>";
    matchesEl.innerHTML = "";
    projectSearchEl.innerHTML = "";
    timelineEl.innerHTML = "<p>No timeline available.</p>";
    propertyFactsEl.innerHTML = "<p>No property facts extracted yet.</p>";
    sellerSummaryEl.innerHTML = "<p>No seller summary available.</p>";
    followUpEl.innerHTML = "<p>No follow-up questions yet.</p>";
    listingNotesEl.value = project?.listingNotes ?? "";
    updateWalkthroughIndicators();
    return;
  }

  state.selectedWalkthroughId = selected.id;
  original.textContent = selected.transcript.originalText || "No original transcript.";
  if (document.activeElement !== edited) {
    edited.value = selected.transcript.editedText;
  }
  if (document.activeElement !== listingNotesEl) {
    listingNotesEl.value = project?.listingNotes ?? "";
  }

  const factRows = selected.facts
    .map((fact) => {
      const timestamp = formatTimestamp(fact.transcriptTimestampMs);
      return `<article class="fact-item" data-fact-id="${fact.id}">
        <strong>${fact.category}</strong>
        <p><strong>Value:</strong> ${fact.correctedValue ?? fact.value}</p>
        <p><strong>Quote:</strong> ${fact.quote}</p>
        <small>Time ${timestamp} | Confidence ${Math.round(fact.confidence * 100)}% | Status ${fact.status} | Decision ${fact.decision}</small>
        <div class="fact-actions">
          <button type="button" class="secondary" data-fact-action="confirmed" data-fact-id="${fact.id}">Confirm</button>
          <button type="button" class="secondary" data-fact-action="rejected" data-fact-id="${fact.id}">Reject</button>
          <button type="button" class="secondary" data-fact-action="follow-up" data-fact-id="${fact.id}">Follow-up</button>
          <input type="text" placeholder="Corrected value" data-corrected-value="${fact.id}" />
          <button type="button" class="secondary" data-fact-action="corrected" data-fact-id="${fact.id}">Correct</button>
        </div>
      </article>`;
    })
    .join("");
  factsEl.innerHTML = factRows || "<p>No extracted facts yet.</p>";

  debriefEl.innerHTML = selected.debrief
    .map(
      (section) => `<article class="fact-item"><strong>${section.title}</strong><ul>${section.lines
        .map((line) => `<li>${line.text}${line.factId ? ` <small>(fact ${line.factId})</small>` : ""}</li>`)
        .join("")}</ul></article>`
    )
    .join("");

  conflictsEl.innerHTML =
    selected.conflicts.length === 0
      ? "<li>No conflicts detected.</li>"
      : selected.conflicts
          .map((conflict) => `<li>${conflict.message}</li>`)
          .join("");

  const transcriptQuery = state.walkthroughTranscriptQuery.trim();
  const transcriptResult = transcriptQuery ? searchWalkthrough(selected, transcriptQuery) : null;
  matchesEl.innerHTML = transcriptResult
    ? transcriptResult.transcriptMatches
        .map((item) => `<article class="match-item"><small>${formatTimestamp(item.startMs)}</small><p>${item.text}</p></article>`)
        .join("") || "<p>No transcript matches.</p>"
    : "";

  const projectQuery = state.walkthroughProjectQuery.trim();
  if (!project || !projectQuery) {
    projectSearchEl.innerHTML = "";
  } else {
    const result = walkthroughSearchAcrossProject(project, projectQuery);
    projectSearchEl.innerHTML = `<div class="match-list">
      <article class="match-item"><strong>Transcript Matches</strong><p>${result.transcriptMatches.length}</p></article>
      <article class="match-item"><strong>Fact Matches</strong><p>${result.factMatches.length}</p></article>
      <article class="match-item"><strong>Related Tasks</strong><p>${result.relatedTasks.join(" | ") || "None"}</p></article>
      <article class="match-item"><strong>Related Risks</strong><p>${result.relatedRisks.join(" | ") || "None"}</p></article>
    </div>`;
  }

  timelineEl.innerHTML = selected.transcript.segments
    .map(
      (segment) =>
        `<article class="match-item"><small>${formatTimestamp(segment.startMs)}</small><p>${segment.text}</p></article>`
    )
    .join("") || "<p>No timeline available.</p>";

  const facts = project ? projectFacts(project) : [];
  const preferredCategories = [
    "Roof",
    "HVAC",
    "Water Heater",
    "Windows and Doors",
    "Flooring",
    "Kitchen Updates",
    "Bath Updates",
    "HOA",
    "Utility Information",
    "Seller Priorities",
    "Pets",
    "Showing Instructions",
    "Closing Preferences"
  ];
  const prioritizedFacts = facts
    .slice()
    .sort((a, b) => {
      const aIndex = preferredCategories.indexOf(a.category);
      const bIndex = preferredCategories.indexOf(b.category);
      const aRank = aIndex >= 0 ? aIndex : 999;
      const bRank = bIndex >= 0 ? bIndex : 999;
      return aRank - bRank;
    });

  propertyFactsEl.innerHTML = prioritizedFacts
    .slice(0, 24)
    .map(
      (fact) =>
        `<article class="match-item"><strong>${fact.category}</strong><p>${fact.correctedValue ?? fact.value}</p><small>${fact.status} | ${Math.round(fact.confidence * 100)}%</small></article>`
    )
    .join("") || "<p>No property facts extracted yet.</p>";

  const sellerFacts = selected.facts.filter((fact) => /seller|timing|price|possession|motivation/i.test(fact.category));
  sellerSummaryEl.innerHTML = sellerFacts
    .slice(0, 8)
    .map((fact) => `<li>${fact.correctedValue ?? fact.value}</li>`)
    .join("") || "<li>No seller discussion summary yet.</li>";

  const followUps = selected.tasks.openQuestions.length > 0 ? selected.tasks.openQuestions : ["Confirm unresolved pricing, timing, and inclusion details."];
  followUpEl.innerHTML = followUps.map((item) => `<li>${item}</li>`).join("");

  updateWalkthroughIndicators();
}

function saveOverrideAndActivity(path: string, patch: PhotoOverride, message: string): void {
  const current = state.overrides[path] ?? {};
  state.overrides[path] = {
    ...current,
    ...patch
  };

  const project = currentProject();
  if (project) {
    let nextProject = {
      ...project,
      overrides: {
        ...project.overrides,
        [path]: state.overrides[path]
      }
    };
    nextProject = pushProjectActivity(nextProject, {
      type: "override",
      message
    });
    saveProject(nextProject);
    renderProjectDashboard();
  }
}

function setWorkspaceView(view: WorkspaceView): void {
  state.currentView = view;
  const sections = document.querySelectorAll<HTMLElement>("[data-workspace-panel]");
  sections.forEach((panel) => {
    if (panel.dataset.workspacePanel === view) {
      panel.classList.remove("hidden");
    } else {
      panel.classList.add("hidden");
    }
  });

  const navButtons = document.querySelectorAll<HTMLButtonElement>("[data-workspace-view]");
  navButtons.forEach((button) => {
    button.classList.toggle("active-project", button.dataset.workspaceView === view);
  });

  if (view === "floor-plans") {
    renderFloorPlanWorkspace();
  }
  if (view === "tour") {
    renderTourWorkspace();
    renderAssetPanels();
  }
}

function photoOverride(path: string): PhotoOverride {
  return state.overrides[path] ?? {};
}

function renderPhotoWorkspace(): void {
  const grid = document.getElementById("photoGrid");
  const detail = document.getElementById("photoDetail");
  const rankList = document.getElementById("rankList");
  if (!grid || !detail || !rankList) {
    return;
  }

  const photos = [...effectivePhotos()].sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);
  if (photos.length === 0) {
    grid.innerHTML = "<p>No photos in this workspace yet.</p>";
    detail.innerHTML = "<p>Select a photo to see details.</p>";
    rankList.innerHTML = "";
    return;
  }

  if (!state.selectedPhotoPath || !photos.some((photo) => photo.filePath === state.selectedPhotoPath)) {
    state.selectedPhotoPath = photos[0]?.filePath ?? null;
  }

  grid.innerHTML = photos
    .map((photo) => {
      const meta = photoOverride(photo.filePath);
      const badges = [
        meta.favorite ? "favorite" : "",
        meta.hero ? "hero" : "",
        meta.needsEditing ? "needs editing" : "",
        meta.readyForMls ? "ready for mls" : ""
      ]
        .filter(Boolean)
        .join(" | ");
      return `<button type="button" class="photo-tile ${state.selectedPhotoPath === photo.filePath ? "active-project" : ""}" data-photo-select="${photo.filePath}">
        <img loading="lazy" src="${photo.thumbnailUrl}" alt="${photo.fileName}" />
        <strong>${prettyFileName(photo.fileName)}</strong>
        <small>#${photo.recommendedMlsOrder} | score ${photo.heroScore}</small>
        <small>${badges || "no tags"}</small>
      </button>`;
    })
    .join("");

  const selected = photos.find((photo) => photo.filePath === state.selectedPhotoPath) ?? photos[0];
  if (!selected) {
    return;
  }

  const selectedMeta = photoOverride(selected.filePath);
  detail.innerHTML = `<div class="photo-detail-card">
    <img loading="lazy" src="${selected.thumbnailUrl}" alt="${selected.fileName}" />
    <h3>${prettyFileName(selected.fileName)}</h3>
    <p>Current ranking: #${selected.recommendedMlsOrder}</p>
    <p>Scene: ${prettySceneTag(selected.sceneTag)} | Decision: ${selected.decision}</p>
    <button type="button" class="secondary preview-photo" data-preview-photo="${selected.filePath}">Open larger preview</button>
    <div class="toggle-grid">
      <label><input type="checkbox" data-photo-flag="rankLocked" ${selectedMeta.rankLocked ? "checked" : ""} data-path="${selected.filePath}" /> Lock ranking</label>
      <label><input type="checkbox" data-photo-flag="favorite" ${selectedMeta.favorite ? "checked" : ""} data-path="${selected.filePath}" /> Favorite</label>
      <label><input type="checkbox" data-photo-flag="hero" ${selectedMeta.hero ? "checked" : ""} data-path="${selected.filePath}" /> Hero designation</label>
      <label><input type="checkbox" data-photo-flag="needsEditing" ${selectedMeta.needsEditing ? "checked" : ""} data-path="${selected.filePath}" /> Needs Editing</label>
      <label><input type="checkbox" data-photo-flag="readyForMls" ${selectedMeta.readyForMls ? "checked" : ""} data-path="${selected.filePath}" /> Ready for MLS</label>
    </div>
  </div>`;

  rankList.innerHTML = photos
    .map((photo) => {
      const meta = photoOverride(photo.filePath);
      const lock = meta.rankLocked ? "locked" : "";
      const draggable = meta.rankLocked ? "false" : "true";
      return `<li class="rank-item ${lock}" draggable="${draggable}" data-rank-path="${photo.filePath}">#${photo.recommendedMlsOrder} ${prettyFileName(photo.fileName)}</li>`;
    })
    .join("");
}

function triggerDownload(fileName: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function prettyInboxKind(kind: string): string {
  return kind.replace(/-/g, " ");
}

function isWorkspaceView(value: string): value is WorkspaceView {
  return WORKSPACE_VIEWS.includes(value as WorkspaceView);
}

function isPhotoFlagKey(value: string): value is PhotoFlagKey {
  return value === "rankLocked" || value === "favorite" || value === "hero" || value === "needsEditing" || value === "readyForMls";
}

function visibleInboxItems(): InboxItem[] {
  const query = state.inboxSearch.trim().toLowerCase();
  return state.inboxItems.filter((item) => {
    if (state.inboxKindFilter !== "all" && item.kind !== state.inboxKindFilter) {
      return false;
    }
    if (state.inboxDecisionFilter !== "all" && item.decision !== state.inboxDecisionFilter) {
      return false;
    }
    if (!query) {
      return true;
    }
    return item.fileName.toLowerCase().includes(query) || item.filePath.toLowerCase().includes(query);
  });
}

function applyBatchInboxDecision(decision: InboxDecision): void {
  const visibleIds = new Set(visibleInboxItems().map((item) => item.id));
  state.inboxItems = state.inboxItems.map((item) => {
    if (!visibleIds.has(item.id) || item.locked) {
      return item;
    }
    return {
      ...item,
      decision
    };
  });
  renderInbox();
}

function toggleInboxDetails(force?: boolean): void {
  state.showInboxDetails = typeof force === "boolean" ? force : !state.showInboxDetails;
  renderInbox();
}

function renderInbox(): void {
  const card = document.getElementById("inboxCard");
  const table = document.getElementById("inboxTable");
  const details = document.getElementById("inboxDetails");
  const toggle = document.getElementById("toggleInboxDetailsBtn") as HTMLButtonElement | null;
  const importBtn = document.getElementById("analyzeBtn") as HTMLButtonElement | null;

  if (!card || !table || !details || !importBtn || !toggle) {
    return;
  }

  if (state.inboxItems.length === 0) {
    card.classList.add("hidden");
    table.innerHTML = "";
    importBtn.disabled = true;
    importBtn.textContent = "Import Listing";
    toggle.textContent = "Review Import Details";
    details.classList.add("hidden");
    state.showInboxDetails = false;
    setText("inboxSummary", "No files queued");
    return;
  }

  card.classList.remove("hidden");

  const acceptedCount = state.inboxItems.filter((item) => item.decision === "accept").length;
  const rejectedCount = state.inboxItems.filter((item) => item.decision === "reject").length;
  const ignoredCount = state.inboxItems.filter((item) => item.decision === "ignore").length;
  const counts = classifyCounts(state.inboxItems);
  const visible = visibleInboxItems();

  setText(
    "inboxSummary",
    `Ready to import ${acceptedCount} of ${state.inboxItems.length} files | RAW ${counts.raw} | Edited ${counts.edited} | Drone ${counts.drone} | Video ${counts.video} | Floor plans ${counts["floor-plan"]} | Matterport ${counts.matterport} | Brochures ${counts.brochure} | Ignored ${ignoredCount} | Rejected ${rejectedCount}`
  );

  toggle.textContent = state.showInboxDetails ? "Hide Import Details" : "Review Import Details";
  details.classList.toggle("hidden", !state.showInboxDetails);

  const rows = visible
    .map((item) => {
      const lock = item.locked ? "disabled" : "";
      const already = item.alreadyAnalyzed ? "already analyzed" : "new";
      return `<div class="inbox-row" data-id="${item.id}">
        <div>
          <strong>${item.fileName}</strong>
          <small>${item.filePath}</small>
          <small>kind: ${prettyInboxKind(item.kind)} | confidence ${Math.round(item.confidence * 100)}% | ${already}</small>
          <small>${item.recommendation}</small>
        </div>
        <div class="inbox-actions">
          <button type="button" class="secondary inbox-decision ${item.decision === "accept" ? "active-pill" : ""}" data-id="${item.id}" data-decision="accept" ${lock}>Accept</button>
          <button type="button" class="secondary inbox-decision ${item.decision === "reject" ? "active-pill" : ""}" data-id="${item.id}" data-decision="reject" ${lock}>Reject</button>
          <button type="button" class="secondary inbox-decision ${item.decision === "ignore" ? "active-pill" : ""}" data-id="${item.id}" data-decision="ignore" ${lock}>Ignore</button>
        </div>
      </div>`;
    })
    .join("");

  table.innerHTML = rows;
  importBtn.disabled = acceptedCount === 0;
  importBtn.textContent = `Import Listing (${acceptedCount})`;
}

function setInboxDecision(itemId: string, decision: InboxDecision): void {
  state.inboxItems = state.inboxItems.map((item) => {
    if (item.id !== itemId || item.locked) {
      return item;
    }
    return {
      ...item,
      decision
    };
  });
  renderInbox();
}

function overrideFor(path: string): PhotoOverride {
  return state.overrides[path] ?? {};
}

function withOverrides(photo: PhotoAssessment): PhotoAssessment {
  const override = overrideFor(photo.filePath);
  const decision = override.decision ?? photo.decision;
  const sceneTag = override.sceneTag ?? photo.sceneTag;
  let recommendationReasons = photo.recommendationReasons;

  if (override.decision) {
    if (decision === "recommended") {
      recommendationReasons = ["Promoted by manual override for MLS inclusion."];
    } else if (decision === "needs-work") {
      recommendationReasons = ["Marked needs-work by manual override."];
    } else {
      recommendationReasons = ["Marked remove by manual override."];
    }
  }

  return {
    ...photo,
    sceneTag,
    decision,
    recommendationReasons,
    recommendedMlsOrder: override.rank ?? photo.recommendedMlsOrder
  };
}

function effectivePhotos(): PhotoAssessment[] {
  return state.photoAssessments.map((item) => withOverrides(item));
}

function filteredPhotos(): PhotoAssessment[] {
  const photos = [...effectivePhotos()].sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);
  if (state.filter === "all") {
    return photos;
  }
  return photos.filter((photo) => photo.decision === state.filter);
}

function updateList(id: string, values: string[], emptyState: string): void {
  const list = document.getElementById(id);
  if (!list) {
    return;
  }

  list.innerHTML = "";
  const items = values.length > 0 ? values : [emptyState];

  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  }
}

function renderTopFive(photos: PhotoAssessment[]): void {
  const list = document.getElementById("heroTop5");
  if (!list) {
    return;
  }

  const top = [...photos]
    .filter((photo) => photo.decision !== "remove")
    .sort((a, b) => {
      const aHero = photoOverride(a.filePath).hero ? 1 : 0;
      const bHero = photoOverride(b.filePath).hero ? 1 : 0;
      if (aHero !== bHero) {
        return bHero - aHero;
      }
      return b.heroScore - a.heroScore;
    })
    .slice(0, 5);

  list.innerHTML = "";
  if (top.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No hero candidates yet.";
    list.appendChild(li);
    return;
  }

  top.forEach((photo) => {
    const li = document.createElement("li");
    li.textContent = `${prettyFileName(photo.fileName)} (${photo.heroScore}/100, ${prettySceneTag(photo.sceneTag)}): ${photo.recommendationReasons.join(" ")}`;
    list.appendChild(li);
  });
}

function selectOptions<T extends string>(options: T[], selected: T): string {
  return options
    .map((option) => `<option value="${option}" ${selected === option ? "selected" : ""}>${option}</option>`)
    .join("");
}

function renderPhotoTable(photos: PhotoAssessment[]): void {
  const table = document.getElementById("photoTable");
  if (!table) {
    return;
  }

  if (photos.length === 0) {
    table.innerHTML = "<p>No photos available for this filter.</p>";
    return;
  }

  const rows = photos
    .map((photo) => {
      const scoreClass = toMetricClass(photo.heroScore);
      const issues = photo.issues.length > 0 ? photo.issues.join(", ") : "none";
      const duplicate = photo.duplicateGroupId ? `D${photo.duplicateGroupId}` : "-";
      const similar = photo.similarGroupId ? `S${photo.similarGroupId}` : "-";
      const detectedProblems = photo.vision.problems.filter((item) => item.detected);

      const qualityRows = [
        ["Sharpness", photo.vision.quality.sharpness],
        ["Noise", photo.vision.quality.noise],
        ["Brightness", photo.vision.quality.brightness],
        ["Exposure", photo.vision.quality.exposure],
        ["White balance", photo.vision.quality.whiteBalance],
        ["Contrast", photo.vision.quality.contrast],
        ["Dynamic range", photo.vision.quality.dynamicRange],
        ["Resolution", photo.vision.quality.resolution],
        ["Horizon level", photo.vision.quality.horizonLevel],
        ["Lens distortion", photo.vision.quality.lensDistortion],
        ["Vertical correction", photo.vision.quality.verticalCorrection],
        ["Composition", photo.vision.quality.composition]
      ]
        .map(([label, score]) => `<li><span>${label}</span><strong>${score}/100</strong></li>`)
        .join("");

      const marketingRows = [
        ["Hero image", photo.vision.marketing.heroImageScore],
        ["Zillow appeal", photo.vision.marketing.zillowAppeal],
        ["MLS appeal", photo.vision.marketing.mlsAppeal],
        ["Luxury appeal", photo.vision.marketing.luxuryAppeal],
        ["Emotional impact", photo.vision.marketing.emotionalImpact],
        ["Click likelihood", photo.vision.marketing.clickLikelihood]
      ]
        .map(([label, score]) => `<li><span>${label}</span><strong>${score}/100</strong></li>`)
        .join("");

      const problemRows = PROBLEM_LABELS.map((label) => {
        const problem = photo.vision.problems.find((item) => item.label === label);
        if (!problem || !problem.detected) {
          return `<li><span>${label}</span><strong>clear</strong></li>`;
        }
        return `<li><span>${label}</span><strong>${formatConfidence(problem.confidence)} detected</strong></li>`;
      }).join("");

      const recommendationRows = photo.vision.recommendations
        .map(
          (item) =>
            `<li><span>${item.action.replace(/-/g, " ")}</span><strong>${formatConfidence(item.confidence)}</strong><small>${item.reason}</small></li>`
        )
        .join("");

      const alternateScenes = (photo.vision.scene.alternatives ?? [])
        .map((item) => `${prettySceneTag(item.label)} ${formatConfidence(item.confidence)}`)
        .join(" | ");

      const primarySceneLabel = sceneLabelFromDetection(photo.vision.scene.label, photo.vision.scene.confidence);
      const analysisSummary = `${primarySceneLabel} (${formatConfidence(photo.vision.scene.confidence)}) | ${detectedProblems.length} problems flagged`;

      return `<div class="photo-row" data-photo-path="${photo.filePath}">
        <img class="thumb" loading="lazy" src="${photo.thumbnailUrl}" alt="${photo.fileName}" />
        <div>
          <strong>${prettyFileName(photo.fileName)}</strong>
          <small>${photo.width}x${photo.height} | scene: ${prettySceneTag(photo.sceneTag)} | dup: ${duplicate} | sim: ${similar}</small>
          <small>Scores: sharpness ${photo.scores.sharpness}, exposure ${photo.scores.exposure}, brightness ${photo.scores.brightness}, contrast ${photo.scores.contrast}, resolution ${photo.scores.resolution}, orientation ${photo.scores.orientation}, aspect ${photo.scores.usableAspect}</small>
          <small>Issues: ${issues}</small>
          <small>Recommendation: ${photo.recommendationReasons.join(" ")}</small>
          <small><button type="button" class="secondary preview-photo" data-preview-photo="${photo.filePath}">Open larger preview</button></small>
          <details class="analysis-card">
            <summary>Vision analysis: ${analysisSummary}</summary>
            <div class="analysis-grid">
              <section>
                <h4>Scene Detection</h4>
                <ul>
                  <li><span>Detected scene</span><strong>${primarySceneLabel}</strong></li>
                  <li><span>Confidence</span><strong>${formatConfidence(photo.vision.scene.confidence)}</strong></li>
                  <li><span>Alternatives</span><strong>${alternateScenes || "None"}</strong></li>
                </ul>
              </section>
              <section>
                <h4>Photo Quality</h4>
                <ul>${qualityRows}</ul>
              </section>
              <section>
                <h4>Marketing Analysis</h4>
                <ul>${marketingRows}</ul>
              </section>
              <section>
                <h4>Problem Detection</h4>
                <ul>${problemRows}</ul>
              </section>
              <section class="wide">
                <h4>Recommendations</h4>
                <ul class="recommendation-list">${recommendationRows}</ul>
              </section>
            </div>
          </details>
        </div>
        <div class="metric ${scoreClass}">${photo.heroScore}<small>Hero</small></div>
        <div class="metric hide-mobile">${photo.recommendedMlsOrder}<small>MLS order</small></div>
        <div class="control-block">
          <label>Room
            <select class="scene-override" data-path="${photo.filePath}">${selectOptions<SceneTag>([...SCENE_TAGS], photo.sceneTag)}</select>
          </label>
        </div>
        <div class="control-block">
          <label>Decision
            <select class="decision-override" data-path="${photo.filePath}">${selectOptions<DecisionTag>(["recommended", "needs-work", "remove"], photo.decision)}</select>
          </label>
        </div>
        <div class="control-block">
          <label>Rank
            <input type="number" min="1" class="rank-override" data-path="${photo.filePath}" value="${photo.recommendedMlsOrder}" />
          </label>
        </div>
        <div class="control-block">
          <button type="button" class="secondary replace-file" data-path="${photo.filePath}">Replace</button>
          <button type="button" class="secondary delete-file" data-path="${photo.filePath}">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  table.innerHTML = rows;
}

function updateFilterButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-filter]");
  buttons.forEach((button) => {
    if (button.dataset.filter === state.filter) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  });
}

function updateDashboardFromState(): void {
  const photos = effectivePhotos();
  const filtered = filteredPhotos();

  renderTopFive(photos);
  renderPhotoTable(filtered);
  updateFilterButtons();

  setText("recommendedCount", `${photos.filter((photo) => photo.decision === "recommended").length}`);
  setText("needsWorkCount", `${photos.filter((photo) => photo.decision === "needs-work").length}`);
  setText("removeCount", `${photos.filter((photo) => photo.decision === "remove").length}`);
  renderProjectStatus();
  renderOverviewWorkspace();
  renderActivityFeed();
  renderPhotoWorkspace();
  renderAssetPanels();
  renderFloorPlanWorkspace();
  renderTourWorkspace();
  renderWalkthroughWorkspace();
}

function findPhotoByHint(hint: string): PhotoAssessment | null {
  const normalized = hint.toLowerCase();
  const photos = effectivePhotos();

  const sceneMatch = photos.find((photo) => normalized.includes(photo.sceneTag.replace(/-/g, " ")));
  if (sceneMatch) {
    return sceneMatch;
  }

  const nameMatch = photos.find((photo) => normalized.includes(photo.fileName.toLowerCase()));
  if (nameMatch) {
    return nameMatch;
  }

  if (normalized.includes("hero")) {
    return [...photos].sort((a, b) => b.heroScore - a.heroScore)[0] ?? null;
  }

  return null;
}

function renderExecutiveSummary(review: DirectorReview): void {
  const exec = review.executiveSummary;
  const strengthsEl = document.getElementById("execStrengths");
  const weaknessesEl = document.getElementById("execWeaknesses");
  const missingEl = document.getElementById("execMissingShots");

  setText("execHero", exec.heroImageRecommendation);
  setText("execReadiness", exec.estimatedMlsReadiness);

  const renderLinkedList = (element: HTMLElement | null, values: string[], emptyLabel: string): void => {
    if (!element) {
      return;
    }
    element.innerHTML = "";
    const items = values.length > 0 ? values : [emptyLabel];
    for (const item of items) {
      const li = document.createElement("li");
      const target = findPhotoByHint(item);
      if (target) {
        li.innerHTML = `${item} <button type="button" class="secondary summary-link" data-summary-photo="${target.filePath}">Open asset</button>`;
      } else {
        li.textContent = item;
      }
      element.appendChild(li);
    }
  };

  renderLinkedList(strengthsEl, exec.strengths, "No strengths identified yet.");
  renderLinkedList(weaknessesEl, exec.weaknesses, "No weaknesses identified yet.");
  renderLinkedList(missingEl, exec.missingShots, "No missing shots identified.");
}

function renderReadinessDetails(review: DirectorReview): void {
  updateList("readinessDeductions", review.readinessDeductions, "No deductions. Listing is fully ready.");
  const breakdown = document.getElementById("readinessBreakdown");
  if (breakdown) {
    breakdown.innerHTML = review.readinessBreakdown
      .map(
        (item) =>
          `<article class="match-item"><strong>${item.label}</strong><p>${item.status} | weight ${Math.round(item.weight * 100)}%</p><p>${item.reason}</p></article>`
      )
      .join("");
  }

  const health = review.mediaHealth;
  setText("healthDuplicateCount", `${health.duplicateCount}`);
  setText("healthRawCount", `${health.rawCount}`);
  setText("healthEditedCount", `${health.editedCount}`);
  setText("healthUneditedCount", `${health.uneditedCount}`);
  setText("healthMissingEdits", `${health.missingEdits}`);
  setText("healthMissingHero", health.missingHero ? "Yes" : "No");
  setText("healthUnusedAssets", `${health.unusedAssets}`);
  setText("healthStagedAssets", `${health.stagedAssets}`);
  setText("healthTwilightCandidates", `${health.twilightCandidates}`);
}

function renderDirectorConversation(summary: IntakeSummary, review: DirectorReview): void {
  const panel = document.getElementById("directorConversation");
  if (!panel) {
    return;
  }

  const top = [...summary.photos].sort((a, b) => b.heroScore - a.heroScore)[0];
  const laundryMissing = review.missingShotChecklist.some((item) => item.toLowerCase().includes("laundry"));
  const recommendations: Array<{ title: string; message: string; photo: PhotoAssessment | null }> = [];

  if (top) {
    recommendations.push({
      title: "Lead Hero",
      message: `Lead with ${prettyFileName(top.fileName)} because it has the highest hero score (${top.heroScore}/100) and strongest launch impact.`,
      photo: top
    });
  }

  const kitchen = summary.photos.find((item) => item.sceneTag === "kitchen") ?? null;
  recommendations.push({
    title: "Kitchen Sequence",
    message: kitchen
      ? `Kitchen coverage is present. Keep ${prettyFileName(kitchen.fileName)} early in sequence to strengthen buyer confidence.`
      : "Kitchen sequence is still missing. Capture one wide and one detail shot for buyer decision support.",
    photo: kitchen
  });

  if (laundryMissing) {
    recommendations.push({
      title: "Coverage Gap",
      message: "Laundry coverage is missing. Add one clear laundry photo to reduce buyer uncertainty.",
      photo: null
    });
  }

  recommendations.push({
    title: "Launch Readiness",
    message: `Current listing readiness is ${review.launchReadinessScore}% (${review.launchReadinessLabel}). Prioritize needs-work items before publish.`,
    photo: top ?? null
  });

  const cardRecommendations = review.actionableRecommendations.map((item) => {
    const safeTitle = escapeHtml(item.title || "Recommendation");
    const safeExplanation = escapeHtml(item.explanation || "No details provided.");
    const affected = item.affectedPhotoPaths
      .map((path) => `<button type="button" class="secondary summary-link" data-summary-photo="${path}">Open asset</button>`)
      .join(" ");
    const decision = state.recommendationDecisions[item.id] ?? "";
    return `<div class="director-line"><strong>${safeTitle}</strong><p>${safeExplanation}</p><small>Priority: ${item.priority}</small><div class="button-row"><button type="button" class="secondary recommendation-action ${decision === "accept" ? "active-pill" : ""}" data-recommendation-id="${item.id}" data-recommendation-action="accept">Accept</button><button type="button" class="secondary recommendation-action ${decision === "reject" ? "active-pill" : ""}" data-recommendation-id="${item.id}" data-recommendation-action="reject">Reject</button><button type="button" class="secondary recommendation-action ${decision === "ignore" ? "active-pill" : ""}" data-recommendation-id="${item.id}" data-recommendation-action="ignore">Ignore</button>${affected}</div></div>`;
  });

  panel.innerHTML = recommendations
    .map((item, index) => {
      const safeTitle = escapeHtml(item.title || "Recommendation");
      const safeMessage = escapeHtml(item.message || "No recommendation details.");
      const preview = item.photo
        ? `<img loading="lazy" src="${item.photo.thumbnailUrl}" alt="${item.photo.fileName}" data-preview-photo="${item.photo.filePath}" class="director-preview" />`
        : "";
      const openPhoto = item.photo
        ? `<button type="button" class="secondary summary-link" data-summary-photo="${item.photo.filePath}">Open asset</button>`
        : "";
      return `<div class="director-line"><strong>${safeTitle}</strong>${preview}<p>${safeMessage}</p><div class="button-row">${openPhoto}<button type="button" class="secondary accept-recommendation" data-rec-index="${index}" data-message="${escapeHtml(item.message || "Recommendation accepted")}">Accept Recommendation</button></div></div>`;
    })
    .join("") + cardRecommendations.join("");
}

function renderResults(summary: IntakeSummary): void {
  const projectForContext = currentProject();
  const review = projectForContext ? buildDirectorReview(summary, buildReviewContext(projectForContext, summary)) : buildDirectorReview(summary);
  state.summary = summary;
  state.photoAssessments = summary.photos;

  const project = currentProject();
  if (project) {
    state.overrides = project.overrides as Record<string, PhotoOverride>;
  }

  const results = document.getElementById("results");
  const progressCard = document.getElementById("progressCard");
  if (progressCard) {
    progressCard.classList.add("hidden");
  }
  if (results) {
    results.classList.remove("hidden");
  }

  setText("launchScore", `${review.launchReadinessScore}`);
  setText("launchLabel", review.listingReadinessLabel);
  setText("fileCount", `${summary.fileCount}`);
  setText("photoCount", `${summary.mediaCounts.photos}`);
  setText("videoCount", `${summary.mediaCounts.videos}`);
  setText("pdfCount", `${summary.mediaCounts.pdfs}`);
  setText("documentCount", `${summary.mediaCounts.documents}`);
  setText("otherCount", `${summary.mediaCounts.other}`);
  setText("story", review.storyAngle);
  setText("angle", review.buyerAngle);
  setText("runtime", summary.mediaCounts.videos > 0 ? "30-60 second highlight cut" : "Capture teaser before launch");
  renderExecutiveSummary(review);
  renderReadinessDetails(review);
  renderDirectorConversation(summary, review);

  updateList("missingMedia", review.missingMedia, "No missing media detected.");
  updateList("shotChecklist", review.missingShotChecklist, "No critical missing shot detected.");
  updateList("actions", review.actionItems, "No action items.");

  const downloadTextBtn = document.getElementById("downloadTextBtn");
  if (downloadTextBtn) {
    downloadTextBtn.onclick = () => {
      const textReport = createTextReport(summary, review);
      triggerDownload("director-intake-report.txt", "text/plain", textReport);
      const project = currentProject();
      if (project) {
        saveProject(
          pushProjectActivity(project, {
            type: "status",
            message: "MLS exported (text report)"
          })
        );
      }
    };
  }

  const downloadJsonBtn = document.getElementById("downloadJsonBtn");
  if (downloadJsonBtn) {
    downloadJsonBtn.onclick = () => {
      const payload = {
        summary,
        review,
        photos: effectivePhotos()
      };
      triggerDownload("director-intake-report.json", "application/json", JSON.stringify(payload, null, 2));
      const project = currentProject();
      if (project) {
        saveProject(
          pushProjectActivity(project, {
            type: "status",
            message: "MLS exported (JSON report)"
          })
        );
      }
    };
  }

  updateDashboardFromState();
  renderProjectDashboard();
  renderProjectStatus();
  setWorkspaceView(state.currentView);
}

function openProject(projectId: string): void {
  const project = loadProject(projectId);
  if (!project) {
    return;
  }

  state.currentProjectId = project.id;
  state.overrides = project.overrides as Record<string, PhotoOverride>;
  state.selectedWalkthroughId = project.walkthroughs[0]?.id ?? null;

  const summary = projectSummaryFromStored(project);
  const addressInput = document.getElementById("address") as HTMLInputElement | null;
  const priceInput = document.getElementById("price") as HTMLInputElement | null;
  if (addressInput) {
    addressInput.value = project.address;
  }
  if (priceInput) {
    priceInput.value = project.listPrice;
  }

  if (!summary) {
    const results = document.getElementById("results");
    if (results) {
      results.classList.remove("hidden");
    }
    renderProjectDashboard();
    renderProjectStatus();
    renderTourWorkspace();
    renderWalkthroughWorkspace();
    updateWalkthroughIndicators();
    return;
  }

  renderResults(summary);
}

async function processIntake(files: File[], address: string, listPrice: string, replacePath?: string): Promise<void> {
  if (!address.trim()) {
    setText("inboxSummary", "Property address is required before import.");
    return;
  }

  const progressCard = document.getElementById("progressCard");
  if (progressCard) {
    progressCard.classList.remove("hidden");
  }

  const project = getOrCreateProject(address, listPrice);
  if (state.currentProjectId !== project.id) {
    state.overrides = project.overrides as Record<string, PhotoOverride>;
  }
  state.currentProjectId = project.id;

  const synced = syncUploadIntoProject(project, files, replacePath);
  let workingProject = synced.project;

  const descriptors: FileDescriptor[] = activeMedia(workingProject).map((entry) => ({
    name: entry.fileName,
    path: entry.filePath,
    type: entry.type,
    size: entry.size
  }));

  const photoMetrics: PhotoMetrics[] = [];
  for (let index = 0; index < synced.newFiles.length; index += 1) {
    const file = synced.newFiles[index];
    if (!file) {
      continue;
    }

    const syncedPath = synced.filePathByName.get(file.name) ?? (file.webkitRelativePath || file.name);
    if (!state.sourceUrlsByPath[syncedPath]) {
      state.sourceUrlsByPath[syncedPath] = URL.createObjectURL(file);
    }

    setProgress(
      Math.round(((index + 1) / Math.max(synced.newFiles.length, 1)) * 100),
      `Analyzing new media ${index + 1} of ${synced.newFiles.length}: ${file.name}`
    );

    if (isImageDescriptor({ name: file.name, type: file.type }) && !isFloorPlanPath(file.webkitRelativePath || file.name)) {
      try {
        const forcedPath = synced.filePathByName.get(file.name);
        const metrics = await analyzePhoto(file, forcedPath);
        photoMetrics.push(metrics);
      } catch {
        // Continue analysis even if one image cannot be decoded.
      }
    }

    if ((index + 1) % 20 === 0) {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    }
  }

  // Existing analyzed media are retained; only newly added files are decoded again.
  workingProject = updateMediaMetrics(workingProject, photoMetrics);

  const allMetrics = activeMedia(workingProject)
    .map((entry) => entry.metrics)
    .filter((item): item is PhotoMetrics => item !== null);

  const previousAssessments = activeMedia(workingProject)
    .map((entry) => entry.analysis)
    .filter((item): item is PhotoAssessment => item !== null);

  const analyzed = assessPhotos(allMetrics);
  const photos = mergeAssessmentsWithHistory(previousAssessments, analyzed);
  workingProject = attachAssessments(workingProject, photos);

  const mediaCounts = classifyMedia(descriptors);
  const summary: IntakeSummary = {
    address: workingProject.address,
    listPrice: workingProject.listPrice,
    fileCount: descriptors.length,
    mediaCounts,
    photos,
    generatedAt: new Date().toISOString()
  };

  const reviewContext = buildReviewContext(workingProject, summary);
  const contextualReview = buildDirectorReview(summary, reviewContext);
  workingProject = applyProjectStatus(workingProject, summary, contextualReview);
  workingProject.overrides = { ...state.overrides };

  const pathBlob = synced.newFiles.map((file) => (file.webkitRelativePath || file.name).toLowerCase()).join(" ");
  if (pathBlob.includes("drone") || pathBlob.includes("aerial")) {
    workingProject = pushProjectActivity(workingProject, {
      type: "import",
      message: "Drone assets added"
    });
  }
  if (pathBlob.includes("matterport") || pathBlob.includes("3d") || pathBlob.includes("tour")) {
    workingProject = pushProjectActivity(workingProject, {
      type: "import",
      message: "Matterport or 3D tour assets added"
    });
  }
  if (contextualReview.listingReadinessLabel === "Ready") {
    workingProject = pushProjectActivity(workingProject, {
      type: "status",
      message: "Launch ready"
    });
  }
  saveProject(workingProject);

  renderResults(summary);
  renderProjectDashboard();
  renderProjectStatus();
}

function assignFiles(files: File[]): void {
  state.files = [...files].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
  for (const file of state.files) {
    const path = file.webkitRelativePath || file.name;
    if (!state.sourceUrlsByPath[path]) {
      state.sourceUrlsByPath[path] = URL.createObjectURL(file);
    }
  }
  const dropzone = document.getElementById("dropzone");
  const project = currentProject();
  const alreadyAnalyzedPaths = new Set((project ? activeMedia(project) : []).map((item) => item.filePath));
  state.inboxItems = buildInbox(state.files, alreadyAnalyzedPaths);

  if (dropzone) {
    const helperText = dropzone.querySelector("span");
    if (helperText) {
      helperText.textContent = `${state.files.length} files selected`;
    }
  }

  renderInbox();
}

function applyOverride(path: string, patch: PhotoOverride): void {
  saveOverrideAndActivity(path, patch, `Override updated for ${path}`);

  updateDashboardFromState();
}

function stopRecordingStream(): void {
  state.recordingStream?.getTracks().forEach((track) => track.stop());
  state.recordingStream = null;
}

async function beginWalkthroughRecording(): Promise<void> {
  if (!isMediaRecorderSupported()) {
    setRecordingStatusMessage("Recording is not supported in this browser. Upload audio instead.");
    setRecordingStatus("error");
    return;
  }

  const consent = document.getElementById("walkthroughConsent") as HTMLInputElement | null;
  if (!consent?.checked) {
    setRecordingStatusMessage("Confirm recording consent before starting.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    state.recordingStream = stream;
    state.recorder = recorder;
    state.recordingChunks = [];
    state.pendingAudioBlob = null;
    state.pendingAudioMimeType = recorder.mimeType || "audio/webm";
    state.recordingElapsedMs = 0;
    setText("walkthroughElapsed", "00:00");

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.recordingChunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(state.recordingChunks, { type: state.pendingAudioMimeType ?? "audio/webm" });
      state.pendingAudioBlob = blob;
      setRecordingStatus(transitionRecorderState(state.recordingStatus, "stop"));
      setRecordingStatusMessage("Recording stopped. Save walkthrough when ready.");
      stopRecordingTicker();
      stopRecordingStream();
    });

    recorder.start(1000);
    setRecordingStatus(transitionRecorderState(state.recordingStatus, "start"));
    setRecordingStatusMessage("Recording in progress.");
    startRecordingTicker();
  } catch {
    setRecordingStatus(transitionRecorderState(state.recordingStatus, "fail"));
    setRecordingStatusMessage("Microphone permission was denied or unavailable.");
  }
}

function pauseWalkthroughRecording(): void {
  if (!state.recorder || state.recorder.state !== "recording") {
    return;
  }
  state.recorder.pause();
  stopRecordingTicker();
  setRecordingStatus(transitionRecorderState(state.recordingStatus, "pause"));
  setRecordingStatusMessage("Recording paused.");
}

function resumeWalkthroughRecording(): void {
  if (!state.recorder || state.recorder.state !== "paused") {
    return;
  }
  state.recorder.resume();
  setRecordingStatus(transitionRecorderState(state.recordingStatus, "resume"));
  startRecordingTicker();
  setRecordingStatusMessage("Recording resumed.");
}

function stopWalkthroughRecording(): void {
  if (!state.recorder) {
    return;
  }
  if (state.recorder.state === "recording" || state.recorder.state === "paused") {
    state.recorder.stop();
  }
}

async function savePendingRecordingAsWalkthrough(): Promise<void> {
  const project = ensureCurrentProject();
  if (!project || !state.pendingAudioBlob) {
    return;
  }

  setRecordingStatus(transitionRecorderState(state.recordingStatus, "save"));
  const provider = getTranscriptionProvider(state.transcriptionMode);
  const transcription = await provider.transcribe({
    audioBlob: state.pendingAudioBlob,
    fileName: `recorded-${new Date().toISOString()}.webm`
  });

  const dataUrl = await blobToDataUrl(state.pendingAudioBlob);
  const walkthrough = createWalkthroughRecord({
    title: `Walkthrough ${new Date().toLocaleString()}`,
    sourceType: "recording",
    providerId: transcription.providerId,
    transcriptText: transcription.text,
    transcriptSegments: transcription.segments,
    audio: {
      mimeType: state.pendingAudioMimeType ?? "audio/webm",
      dataUrl,
      durationMs: state.recordingElapsedMs,
      sourceLabel: "Browser recording"
    }
  });

  saveWalkthroughToProject(walkthrough, `Saved recording walkthrough with ${walkthrough.facts.length} extracted facts`);
  setRecordingStatus("idle");
  state.pendingAudioBlob = null;
  state.recordingChunks = [];
  state.recordingElapsedMs = 0;
  setText("walkthroughElapsed", "00:00");
  setRecordingStatusMessage("Walkthrough saved.");
  renderWalkthroughWorkspace();
}

async function importWalkthroughFiles(files: File[]): Promise<void> {
  const project = ensureCurrentProject();
  if (!project || files.length === 0) {
    return;
  }

  for (const file of files) {
    const isAudio = file.type.startsWith("audio/") || /\.(m4a|mp3|wav|webm|ogg|aac)$/i.test(file.name);

    if (isAudio) {
      const provider = getTranscriptionProvider(state.transcriptionMode);
      const transcription = await provider.transcribe({
        audioBlob: file,
        fileName: file.name
      });
      const dataUrl = await blobToDataUrl(file);
      const walkthrough = createWalkthroughRecord({
        title: `Imported audio: ${file.name}`,
        sourceType: "upload",
        providerId: transcription.providerId,
        transcriptText: transcription.text,
        transcriptSegments: transcription.segments,
        audio: {
          mimeType: file.type || "audio/mpeg",
          dataUrl,
          durationMs: 0,
          sourceLabel: file.name
        }
      });
      saveWalkthroughToProject(walkthrough, `Imported walkthrough audio ${file.name}`);
      continue;
    }

    const content = await file.text();
    const parsed = parseTranscriptImport(file.name, file.type, content);
    const walkthrough = createWalkthroughRecord({
      title: `Imported transcript: ${file.name}`,
      sourceType: "upload",
      providerId: parsed.providerId,
      transcriptText: parsed.text,
      transcriptSegments: parsed.segments,
      audio: null
    });
    saveWalkthroughToProject(
      walkthrough,
      `Imported transcript ${file.name} (${parsed.format}) with ${walkthrough.facts.length} extracted facts`
    );
  }

  setRecordingStatusMessage(`Imported ${files.length} walkthrough file(s).`);
  renderWalkthroughWorkspace();
}

function persistWalkthroughSelection(mutator: (walkthrough: WalkthroughRecord) => WalkthroughRecord, message: string): void {
  const project = currentProject();
  const selected = currentWalkthrough();
  if (!project || !selected) {
    return;
  }
  const updatedWalkthrough = mutator(selected);
  saveWalkthroughToProject(updatedWalkthrough, message);
  renderWalkthroughWorkspace();
}

function addBeforeUnloadGuard(): void {
  window.addEventListener("beforeunload", (event) => {
    if (state.recordingStatus === "recording" || state.recordingStatus === "paused") {
      event.preventDefault();
      event.returnValue = "A walkthrough recording is in progress.";
    }
  });
}

function initializeIntakeApp(): void {
  const folderInput = document.getElementById("folderInput") as HTMLInputElement | null;
  const filesInput = document.getElementById("filesInput") as HTMLInputElement | null;
  const replaceInput = document.getElementById("replaceInput") as HTMLInputElement | null;
  const analyzeBtn = document.getElementById("analyzeBtn") as HTMLButtonElement | null;
  const dropzone = document.getElementById("dropzone");
  const addressInput = document.getElementById("address") as HTMLInputElement | null;
  const priceInput = document.getElementById("price") as HTMLInputElement | null;
  const table = document.getElementById("photoTable");
  const projectList = document.getElementById("projectList");
  const inboxTable = document.getElementById("inboxTable");
  const inboxSearch = document.getElementById("inboxSearch") as HTMLInputElement | null;
  const inboxKind = document.getElementById("inboxKindFilter") as HTMLSelectElement | null;
  const inboxDecision = document.getElementById("inboxDecisionFilter") as HTMLSelectElement | null;
  const batchAccept = document.getElementById("batchAcceptBtn") as HTMLButtonElement | null;
  const batchReject = document.getElementById("batchRejectBtn") as HTMLButtonElement | null;
  const toggleInboxDetailsBtn = document.getElementById("toggleInboxDetailsBtn") as HTMLButtonElement | null;
  const workspaceNav = document.getElementById("workspaceNav");
  const photoGrid = document.getElementById("photoGrid");
  const photoDetail = document.getElementById("photoDetail");
  const rankList = document.getElementById("rankList");
  const directorConversation = document.getElementById("directorConversation");
  const resultsRoot = document.getElementById("results");
  const walkthroughStart = document.getElementById("walkthroughStartBtn") as HTMLButtonElement | null;
  const walkthroughPause = document.getElementById("walkthroughPauseBtn") as HTMLButtonElement | null;
  const walkthroughResume = document.getElementById("walkthroughResumeBtn") as HTMLButtonElement | null;
  const walkthroughStop = document.getElementById("walkthroughStopBtn") as HTMLButtonElement | null;
  const walkthroughSave = document.getElementById("walkthroughSaveBtn") as HTMLButtonElement | null;
  const walkthroughImport = document.getElementById("walkthroughImportInput") as HTMLInputElement | null;
  const walkthroughMode = document.getElementById("walkthroughTranscriptionMode") as HTMLSelectElement | null;
  const walkthroughTranscriptSearch = document.getElementById("walkthroughTranscriptSearch") as HTMLInputElement | null;
  const walkthroughProjectSearch = document.getElementById("walkthroughProjectSearch") as HTMLInputElement | null;
  const walkthroughHistory = document.getElementById("walkthroughHistory");
  const walkthroughSaveTranscriptEdit = document.getElementById("walkthroughSaveTranscriptEdit") as HTMLButtonElement | null;
  const walkthroughEditedTranscript = document.getElementById("walkthroughEditedTranscript") as HTMLTextAreaElement | null;
  const walkthroughFacts = document.getElementById("walkthroughFacts");
  const walkthroughManualCategory = document.getElementById("walkthroughManualFactCategory") as HTMLInputElement | null;
  const walkthroughManualValue = document.getElementById("walkthroughManualFactValue") as HTMLInputElement | null;
  const walkthroughManualQuote = document.getElementById("walkthroughManualFactQuote") as HTMLTextAreaElement | null;
  const walkthroughManualStatus = document.getElementById("walkthroughManualFactStatus") as HTMLSelectElement | null;
  const walkthroughAddManualFact = document.getElementById("walkthroughAddManualFact") as HTMLButtonElement | null;
  const walkthroughSaveNotes = document.getElementById("walkthroughSaveNotes") as HTMLButtonElement | null;
  const walkthroughListingNotes = document.getElementById("walkthroughListingNotes") as HTMLTextAreaElement | null;
  const matterportUrl = document.getElementById("matterportUrl") as HTMLInputElement | null;
  const zillow3dUrl = document.getElementById("zillow3dUrl") as HTMLInputElement | null;
  const virtualTourUrl = document.getElementById("virtualTourUrl") as HTMLInputElement | null;
  const saveTourLinks = document.getElementById("saveTourLinks") as HTMLButtonElement | null;
  const closePreview = document.getElementById("closePhotoPreview") as HTMLButtonElement | null;
  const prevPreview = document.getElementById("prevPhotoPreview") as HTMLButtonElement | null;
  const nextPreview = document.getElementById("nextPhotoPreview") as HTMLButtonElement | null;
  const zoomInPreview = document.getElementById("zoomInPhotoPreview") as HTMLButtonElement | null;
  const zoomOutPreview = document.getElementById("zoomOutPhotoPreview") as HTMLButtonElement | null;
  const previewModal = document.getElementById("photoPreviewModal");

  if (
    !folderInput ||
    !filesInput ||
    !replaceInput ||
    !analyzeBtn ||
    !dropzone ||
    !addressInput ||
    !priceInput ||
    !table ||
    !projectList ||
    !inboxTable ||
    !inboxSearch ||
    !inboxKind ||
    !inboxDecision ||
    !batchAccept ||
    !batchReject ||
    !toggleInboxDetailsBtn ||
    !workspaceNav ||
    !photoGrid ||
    !photoDetail ||
    !rankList ||
    !directorConversation ||
    !walkthroughStart ||
    !walkthroughPause ||
    !walkthroughResume ||
    !walkthroughStop ||
    !walkthroughSave ||
    !walkthroughImport ||
    !walkthroughMode ||
    !walkthroughTranscriptSearch ||
    !walkthroughProjectSearch ||
    !walkthroughHistory ||
    !walkthroughSaveTranscriptEdit ||
    !walkthroughEditedTranscript ||
    !walkthroughFacts ||
    !walkthroughManualCategory ||
    !walkthroughManualValue ||
    !walkthroughManualQuote ||
    !walkthroughManualStatus ||
    !walkthroughAddManualFact ||
    !walkthroughSaveNotes ||
    !walkthroughListingNotes ||
    !matterportUrl ||
    !zillow3dUrl ||
    !virtualTourUrl ||
    !saveTourLinks ||
    !closePreview ||
    !prevPreview ||
    !nextPreview ||
    !zoomInPreview ||
    !zoomOutPreview ||
    !previewModal
  ) {
    return;
  }

  addBeforeUnloadGuard();

  folderInput.addEventListener("change", () => {
    assignFiles(Array.from(folderInput.files ?? []));
  });

  filesInput.addEventListener("change", () => {
    assignFiles(Array.from(filesInput.files ?? []));
  });

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragging");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
    void (async () => {
      const droppedFiles = await collectDroppedFiles(event.dataTransfer);
      if (droppedFiles.length > 0) {
        assignFiles(droppedFiles);
      }
    })();
  });

  analyzeBtn.addEventListener("click", () => {
    void (async () => {
      analyzeBtn.disabled = true;
      try {
        if (!addressInput.value.trim()) {
          setText("inboxSummary", "Property address is required before import.");
          return;
        }
        const accepted = acceptedFiles(state.inboxItems, state.files);
        if (accepted.length === 0) {
          return;
        }
        await processIntake(accepted, addressInput.value.trim(), priceInput.value.trim());
        state.files = [];
        state.inboxItems = [];
        folderInput.value = "";
        filesInput.value = "";
        renderInbox();
      } finally {
        analyzeBtn.disabled = false;
      }
    })();
  });

  replaceInput.addEventListener("change", () => {
    const replacement = replaceInput.files?.[0];
    const replacePath = state.pendingReplacePath;
    if (!replacement || !replacePath) {
      return;
    }

    void (async () => {
      analyzeBtn.disabled = true;
      try {
        await processIntake([replacement], addressInput.value.trim(), priceInput.value.trim(), replacePath);
      } finally {
        analyzeBtn.disabled = false;
        state.pendingReplacePath = null;
        replaceInput.value = "";
      }
    })();
  });

  const filterButtons = document.querySelectorAll<HTMLButtonElement>("[data-filter]");
  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter as FilterTag | undefined;
      if (!filter) {
        return;
      }
      state.filter = filter;
      updateDashboardFromState();
    });
  });

  table.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const path = target.getAttribute("data-path");
    if (!path) {
      return;
    }

    if (target.classList.contains("scene-override") && target instanceof HTMLSelectElement) {
      const current = effectivePhotos().find((photo) => photo.filePath === path);
      applyOverride(path, { sceneTag: target.value as SceneTag, rank: current?.recommendedMlsOrder });
      return;
    }

    if (target.classList.contains("decision-override") && target instanceof HTMLSelectElement) {
      applyOverride(path, { decision: target.value as DecisionTag });
      return;
    }

    if (target.classList.contains("rank-override") && target instanceof HTMLInputElement) {
      const rank = Number(target.value);
      if (Number.isFinite(rank) && rank > 0) {
        applyOverride(path, { rank });
      }
    }
  });

  table.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const previewPath = target.getAttribute("data-preview-photo");
    if (previewPath) {
      const photo = photoByPath(previewPath);
      if (photo) {
        openImagePreview(photo);
      }
      return;
    }

    const path = target.getAttribute("data-path");
    if (!path) {
      return;
    }

    if (target.classList.contains("delete-file")) {
      const project = currentProject();
      if (!project) {
        return;
      }
      const updated = deleteProjectMedia(project, path);
      saveProject(updated);
      openProject(updated.id);
      return;
    }

    if (target.classList.contains("replace-file")) {
      state.pendingReplacePath = path;
      replaceInput.click();
    }
  });

  inboxTable.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const itemId = target.getAttribute("data-id");
    const decision = target.getAttribute("data-decision") as InboxDecision | null;
    if (!itemId || !decision || !target.classList.contains("inbox-decision")) {
      return;
    }
    setInboxDecision(itemId, decision);
  });

  inboxSearch.addEventListener("input", () => {
    state.inboxSearch = inboxSearch.value;
    renderInbox();
  });

  inboxKind.addEventListener("change", () => {
    state.inboxKindFilter = inboxKind.value;
    renderInbox();
  });

  inboxDecision.addEventListener("change", () => {
    state.inboxDecisionFilter = inboxDecision.value;
    renderInbox();
  });

  batchAccept.addEventListener("click", () => applyBatchInboxDecision("accept"));
  batchReject.addEventListener("click", () => applyBatchInboxDecision("reject"));
  toggleInboxDetailsBtn.addEventListener("click", () => toggleInboxDetails());

  walkthroughMode.addEventListener("change", () => {
    state.transcriptionMode = walkthroughMode.value;
    setRecordingStatusMessage(`Transcription mode set to ${walkthroughMode.value}.`);
  });

  walkthroughStart.addEventListener("click", () => {
    void beginWalkthroughRecording();
  });
  walkthroughPause.addEventListener("click", () => pauseWalkthroughRecording());
  walkthroughResume.addEventListener("click", () => resumeWalkthroughRecording());
  walkthroughStop.addEventListener("click", () => stopWalkthroughRecording());
  walkthroughSave.addEventListener("click", () => {
    void savePendingRecordingAsWalkthrough();
  });

  walkthroughImport.addEventListener("change", () => {
    const files = Array.from(walkthroughImport.files ?? []);
    void importWalkthroughFiles(files);
    walkthroughImport.value = "";
  });

  walkthroughHistory.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const selectedId = target.getAttribute("data-walkthrough-select");
    if (!selectedId) {
      return;
    }
    state.selectedWalkthroughId = selectedId;
    renderWalkthroughWorkspace();
  });

  walkthroughTranscriptSearch.addEventListener("input", () => {
    state.walkthroughTranscriptQuery = walkthroughTranscriptSearch.value;
    renderWalkthroughWorkspace();
  });

  walkthroughProjectSearch.addEventListener("input", () => {
    state.walkthroughProjectQuery = walkthroughProjectSearch.value;
    renderWalkthroughWorkspace();
  });

  walkthroughSaveTranscriptEdit.addEventListener("click", () => {
    const editedText = walkthroughEditedTranscript.value;
    persistWalkthroughSelection(
      (walkthrough) => updateWalkthroughTranscript(walkthrough, editedText, "Director"),
      "Transcript text edited and saved"
    );
  });

  walkthroughFacts.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const factId = target.getAttribute("data-fact-id");
    const action = target.getAttribute("data-fact-action") as FactDecision | null;
    if (!factId || !action) {
      return;
    }

    let correctedValue: string | undefined;
    if (action === "corrected") {
      const input = walkthroughFacts.querySelector<HTMLInputElement>(`input[data-corrected-value="${factId}"]`);
      correctedValue = input?.value ?? "";
    }

    persistWalkthroughSelection(
      (walkthrough) => applyFactDecisionToWalkthrough(walkthrough, factId, action, correctedValue),
      `Fact review decision applied: ${action}`
    );
  });

  walkthroughAddManualFact.addEventListener("click", () => {
    const category = walkthroughManualCategory.value.trim();
    const value = walkthroughManualValue.value.trim();
    const quote = walkthroughManualQuote.value.trim();
    const status = walkthroughManualStatus.value as FactStatus;
    if (!category || !value || !quote) {
      setRecordingStatusMessage("Manual fact requires category, value, and quote.");
      return;
    }

    persistWalkthroughSelection(
      (walkthrough) =>
        addManualFact(walkthrough, {
          category,
          value,
          quote,
          status
        }),
      `Manual fact added: ${category}`
    );

    walkthroughManualCategory.value = "";
    walkthroughManualValue.value = "";
    walkthroughManualQuote.value = "";
  });

  walkthroughSaveNotes.addEventListener("click", () => {
    const project = currentProject();
    if (!project) {
      return;
    }
    const updated = {
      ...project,
      listingNotes: walkthroughListingNotes.value
    };
    saveProject(updated);
    setRecordingStatusMessage("Listing notes saved.");
  });

  saveTourLinks.addEventListener("click", () => {
    const project = ensureCurrentProject();
    if (!project) {
      setText("tourLinkStatus", "Property address is required before saving tour links.");
      return;
    }

    const matterport = matterportUrl.value.trim();
    const zillow = zillow3dUrl.value.trim();
    const virtualTour = virtualTourUrl.value.trim();
    const checks = [validateTourUrl(matterport), validateTourUrl(zillow), validateTourUrl(virtualTour)];
    const invalid = checks.find((item) => !item.valid);
    if (invalid) {
      setText("tourLinkStatus", invalid.reason);
      return;
    }

    const updated = {
      ...project,
      tourLinks: {
        matterportUrl: matterport,
        zillow3dUrl: zillow,
        virtualTourUrl: virtualTour,
        updatedAt: new Date().toISOString()
      }
    };
    saveProject(pushProjectActivity(updated, {
      type: "status",
      message: "Tour links updated"
    }));
    renderTourWorkspace();
    renderAssetPanels();
    renderProjectDashboard();
  });

  closePreview.addEventListener("click", () => closeImagePreview());
  prevPreview.addEventListener("click", () => stepPreview(-1));
  nextPreview.addEventListener("click", () => stepPreview(1));
  zoomInPreview.addEventListener("click", () => adjustPreviewZoom(0.2));
  zoomOutPreview.addEventListener("click", () => adjustPreviewZoom(-0.2));
  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) {
      closeImagePreview();
    }
  });

  workspaceNav.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest<HTMLElement>("[data-workspace-view]");
    const view = button?.getAttribute("data-workspace-view");
    if (!view || !isWorkspaceView(view)) {
      return;
    }

    if (view === "walkthrough") {
      const project = ensureCurrentProject();
      if (project) {
        const results = document.getElementById("results");
        if (results) {
          results.classList.remove("hidden");
        }
        state.selectedWalkthroughId = project.walkthroughs[0]?.id ?? null;
        renderWalkthroughWorkspace();
      }
    }

    setWorkspaceView(view);
  });

  photoGrid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest<HTMLElement>("[data-photo-select]");
    if (!button) {
      return;
    }
    const path = button.getAttribute("data-photo-select");
    if (!path) {
      return;
    }
    state.selectedPhotoPath = path;
    renderPhotoWorkspace();
  });

  photoDetail.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const path = target.getAttribute("data-path");
    const flag = target.getAttribute("data-photo-flag");
    if (!path || !flag || !isPhotoFlagKey(flag)) {
      return;
    }
    const value = target.checked;
    saveOverrideAndActivity(path, { [flag]: value }, `Updated ${flag} for ${path}`);
    updateDashboardFromState();
  });

  photoDetail.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const previewPath = target.getAttribute("data-preview-photo");
    if (!previewPath) {
      return;
    }
    const photo = photoByPath(previewPath);
    if (photo) {
      openImagePreview(photo);
    }
  });

  const floorPlanGallery = document.getElementById("floorPlanGallery");
  floorPlanGallery?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const path = target.getAttribute("data-path");
    if (!path || !target.classList.contains("floor-plan-preview")) {
      return;
    }
    const photo = photoByPath(path);
    if (!photo) {
      return;
    }
    openImagePreview(photo);
  });

  let dragPath: string | null = null;
  rankList.addEventListener("dragstart", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const path = target.getAttribute("data-rank-path");
    if (!path || target.classList.contains("locked")) {
      return;
    }
    dragPath = path;
  });

  rankList.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  rankList.addEventListener("drop", (event) => {
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof HTMLElement) || !dragPath) {
      return;
    }
    const dropTarget = target.closest<HTMLElement>("[data-rank-path]");
    if (!dropTarget) {
      return;
    }
    const dropPath = dropTarget.getAttribute("data-rank-path");
    if (!dropPath || dropPath === dragPath) {
      return;
    }

    const photos = [...effectivePhotos()].sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);
    const movable = photos.filter((photo) => !photoOverride(photo.filePath).rankLocked);
    const fromIndex = movable.findIndex((photo) => photo.filePath === dragPath);
    const toIndex = movable.findIndex((photo) => photo.filePath === dropPath);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }

    const moved = [...movable];
    const [item] = moved.splice(fromIndex, 1);
    if (!item) {
      return;
    }
    moved.splice(toIndex, 0, item);

    moved.forEach((photo, index) => {
      saveOverrideAndActivity(photo.filePath, { rank: index + 1 }, `Manually reordered ${photo.filePath} to #${index + 1}`);
    });
    dragPath = null;
    updateDashboardFromState();
  });

  directorConversation.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const previewPath = target.getAttribute("data-preview-photo");
    if (previewPath) {
      const photo = photoByPath(previewPath);
      if (photo) {
        openImagePreview(photo);
      }
      return;
    }

    const summaryPath = target.getAttribute("data-summary-photo");
    if (summaryPath) {
      focusPhoto(summaryPath);
      return;
    }

    const recommendationId = target.getAttribute("data-recommendation-id");
    const recommendationAction = target.getAttribute("data-recommendation-action") as "accept" | "reject" | "ignore" | null;
    if (recommendationId && recommendationAction) {
      state.recommendationDecisions[recommendationId] = recommendationAction;
      const project = currentProject();
      if (project) {
        saveProject(
          pushProjectActivity(project, {
            type: "recommendation-accepted",
            message: `Recommendation ${recommendationId} marked ${recommendationAction}`
          })
        );
      }
      updateDashboardFromState();
      return;
    }

    if (!target.classList.contains("accept-recommendation")) {
      return;
    }
    const message = target.getAttribute("data-message") ?? "Recommendation accepted";
    const project = currentProject();
    if (!project) {
      return;
    }
    const updated = pushProjectActivity(project, {
      type: "recommendation-accepted",
      message
    });
    saveProject(updated);
    renderActivityFeed();
    renderProjectDashboard();
  });

  resultsRoot?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const summaryPath = target.getAttribute("data-summary-photo");
    if (summaryPath) {
      focusPhoto(summaryPath);
    }
  });

  projectList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const projectId = target.getAttribute("data-project-id");
    if (!projectId) {
      return;
    }
    openProject(projectId);
  });

  renderProjectDashboard();
  renderProjectStatus();
  renderInbox();
  renderFloorPlanWorkspace();
  renderTourWorkspace();
  setWorkspaceView(state.currentView);
  if (state.projects.length > 0) {
    openProject(state.projects[0]?.id ?? "");
  }
}

if (typeof document !== "undefined") {
  initializeIntakeApp();
}
