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
  projectSummaryFromStored,
  pushProjectActivity,
  saveProject,
  syncUploadIntoProject,
  updateMediaMetrics,
  type DirectorProject
} from "./projects.js";
import {
  acceptedFiles,
  buildInbox,
  classifyCounts,
  type InboxDecision,
  type InboxItem
} from "./inbox.js";

type FilterTag = "all" | "recommended" | "needs-work" | "remove";
type WorkspaceView =
  | "overview"
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
  selectedPhotoPath: null
};

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
  return tag.replace(/-/g, " ");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
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

  return {
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

function currentProject(): DirectorProject | null {
  if (!state.currentProjectId) {
    return null;
  }
  return loadProject(state.currentProjectId);
}

function refreshProjects(): void {
  state.projects = listProjects();
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
  const review = summary ? buildDirectorReview(summary) : null;

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
  const byName = (needle: string) => media.filter((item) => item.fileName.toLowerCase().includes(needle));
  const drone = byName("drone").length + byName("aerial").length;
  const floorPlans = byName("floorplan").length + byName("floor-plan").length + byName("plan").length;
  const tours = byName("matterport").length + byName("tour").length;
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
        <img src="${photo.thumbnailUrl}" alt="${photo.fileName}" />
        <strong>${photo.fileName}</strong>
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
    <img src="${selected.thumbnailUrl}" alt="${selected.fileName}" />
    <h3>${selected.fileName}</h3>
    <p>Current ranking: #${selected.recommendedMlsOrder}</p>
    <p>Scene: ${prettySceneTag(selected.sceneTag)} | Decision: ${selected.decision}</p>
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
      return `<li class="rank-item ${lock}" draggable="${draggable}" data-rank-path="${photo.filePath}">#${photo.recommendedMlsOrder} ${photo.fileName}</li>`;
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

function renderInbox(): void {
  const card = document.getElementById("inboxCard");
  const table = document.getElementById("inboxTable");
  const importBtn = document.getElementById("analyzeBtn") as HTMLButtonElement | null;

  if (!card || !table || !importBtn) {
    return;
  }

  if (state.inboxItems.length === 0) {
    card.classList.add("hidden");
    table.innerHTML = "";
    importBtn.disabled = true;
    importBtn.textContent = "Import accepted files";
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
    `Visible ${visible.length} | Accepted ${acceptedCount} | Rejected ${rejectedCount} | Ignored ${ignoredCount} | RAW ${counts.raw} | Edited ${counts.edited} | Drone ${counts.drone} | Video ${counts.video} | Floor plans ${counts["floor-plan"]} | Matterport ${counts.matterport} | Brochures ${counts.brochure} | Unknown ${counts.unknown}`
  );

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
  importBtn.textContent = `Import accepted files (${acceptedCount})`;
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
    li.textContent = `${photo.fileName} (${photo.heroScore}/100, ${prettySceneTag(photo.sceneTag)}): ${photo.recommendationReasons.join(" ")}`;
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

      const analysisSummary = `${prettySceneTag(photo.vision.scene.label)} (${formatConfidence(photo.vision.scene.confidence)}) | ${detectedProblems.length} problems flagged`;

      return `<div class="photo-row" data-photo-path="${photo.filePath}">
        <img class="thumb" src="${photo.thumbnailUrl}" alt="${photo.fileName}" />
        <div>
          <strong>${photo.fileName}</strong>
          <small>${photo.width}x${photo.height} | scene: ${prettySceneTag(photo.sceneTag)} | dup: ${duplicate} | sim: ${similar}</small>
          <small>Scores: sharpness ${photo.scores.sharpness}, exposure ${photo.scores.exposure}, brightness ${photo.scores.brightness}, contrast ${photo.scores.contrast}, resolution ${photo.scores.resolution}, orientation ${photo.scores.orientation}, aspect ${photo.scores.usableAspect}</small>
          <small>Issues: ${issues}</small>
          <small>Recommendation: ${photo.recommendationReasons.join(" ")}</small>
          <details class="analysis-card">
            <summary>Vision analysis: ${analysisSummary}</summary>
            <div class="analysis-grid">
              <section>
                <h4>Scene Detection</h4>
                <ul>
                  <li><span>Detected scene</span><strong>${prettySceneTag(photo.vision.scene.label)}</strong></li>
                  <li><span>Confidence</span><strong>${formatConfidence(photo.vision.scene.confidence)}</strong></li>
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
}

function renderExecutiveSummary(review: DirectorReview): void {
  const exec = review.executiveSummary;
  setText("execHero", exec.heroImageRecommendation);
  setText("execReadiness", exec.estimatedMlsReadiness);
  updateList("execStrengths", exec.strengths, "No strengths identified yet.");
  updateList("execWeaknesses", exec.weaknesses, "No weaknesses identified yet.");
  updateList("execMissingShots", exec.missingShots, "No missing shots identified.");
}

function renderDirectorConversation(summary: IntakeSummary, review: DirectorReview): void {
  const panel = document.getElementById("directorConversation");
  if (!panel) {
    return;
  }

  const top = [...summary.photos].sort((a, b) => b.heroScore - a.heroScore)[0];
  const laundryMissing = review.missingShotChecklist.some((item) => item.toLowerCase().includes("laundry"));
  const lines: string[] = [];

  if (top) {
    lines.push(`I recommend leading with ${top.fileName}; it is currently your strongest hero candidate.`);
  }
  lines.push(`The kitchen sequence is ${summary.photos.some((item) => item.sceneTag === "kitchen") ? "excellent" : "still missing"}.`);
  if (laundryMissing) {
    lines.push("You are still missing a laundry room photo.");
  }
  lines.push(`This listing is ${review.launchReadinessScore}% launch ready.`);

  panel.innerHTML = lines
    .map(
      (line, index) =>
        `<div class="director-line"><p>${line}</p><button type="button" class="secondary accept-recommendation" data-rec-index="${index}" data-message="${line.replace(/"/g, "&quot;")}">Accept Recommendation</button></div>`
    )
    .join("");
}

function renderResults(summary: IntakeSummary): void {
  const review = buildDirectorReview(summary);
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
  setText("launchLabel", review.launchReadinessLabel);
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
  renderDirectorConversation(summary, review);

  updateList("missingMedia", review.missingMedia, "No missing media detected.");
  updateList("shotChecklist", review.missingShotChecklist, "No critical missing shot detected.");
  updateList("actions", review.actionItems, "No action items.");

  const downloadTextBtn = document.getElementById("downloadTextBtn");
  if (downloadTextBtn) {
    downloadTextBtn.onclick = () => {
      const textReport = createTextReport(summary, review);
      triggerDownload("director-intake-report.txt", "text/plain", textReport);
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

  const summary = projectSummaryFromStored(project);
  if (!summary) {
    renderProjectDashboard();
    renderProjectStatus();
    return;
  }

  const addressInput = document.getElementById("address") as HTMLInputElement | null;
  const priceInput = document.getElementById("price") as HTMLInputElement | null;
  if (addressInput) {
    addressInput.value = project.address;
  }
  if (priceInput) {
    priceInput.value = project.listPrice;
  }

  renderResults(summary);
}

async function processIntake(files: File[], address: string, listPrice: string, replacePath?: string): Promise<void> {
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

    setProgress(
      Math.round(((index + 1) / Math.max(synced.newFiles.length, 1)) * 100),
      `Analyzing new media ${index + 1} of ${synced.newFiles.length}: ${file.name}`
    );

    if (isImageDescriptor({ name: file.name, type: file.type })) {
      try {
        const forcedPath = synced.filePathByName.get(file.name);
        const metrics = await analyzePhoto(file, forcedPath);
        photoMetrics.push(metrics);
      } catch {
        // Continue analysis even if one image cannot be decoded.
      }
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

  const review = buildDirectorReview(summary);
  workingProject = applyProjectStatus(workingProject, summary, review);
  workingProject.overrides = { ...state.overrides };
  saveProject(workingProject);

  renderResults(summary);
  renderProjectDashboard();
  renderProjectStatus();
}

function assignFiles(files: File[]): void {
  state.files = files;
  const dropzone = document.getElementById("dropzone");
  const project = currentProject();
  const alreadyAnalyzedPaths = new Set((project ? activeMedia(project) : []).map((item) => item.filePath));
  state.inboxItems = buildInbox(files, alreadyAnalyzedPaths);

  if (dropzone) {
    const helperText = dropzone.querySelector("span");
    if (helperText) {
      helperText.textContent = `${files.length} files selected`;
    }
  }

  renderInbox();
}

function applyOverride(path: string, patch: PhotoOverride): void {
  saveOverrideAndActivity(path, patch, `Override updated for ${path}`);

  updateDashboardFromState();
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
  const workspaceNav = document.getElementById("workspaceNav");
  const photoGrid = document.getElementById("photoGrid");
  const photoDetail = document.getElementById("photoDetail");
  const rankList = document.getElementById("rankList");
  const directorConversation = document.getElementById("directorConversation");

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
    !workspaceNav ||
    !photoGrid ||
    !photoDetail ||
    !rankList ||
    !directorConversation
  ) {
    return;
  }

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
    const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
    if (droppedFiles.length > 0) {
      assignFiles(droppedFiles);
    }
  });

  analyzeBtn.addEventListener("click", () => {
    void (async () => {
      analyzeBtn.disabled = true;
      try {
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
      applyOverride(path, { sceneTag: target.value as SceneTag });
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

  workspaceNav.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const view = target.getAttribute("data-workspace-view");
    if (!view || !isWorkspaceView(view)) {
      return;
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
    if (!(target instanceof HTMLElement) || !target.classList.contains("accept-recommendation")) {
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
  setWorkspaceView(state.currentView);
  if (state.projects.length > 0) {
    openProject(state.projects[0]?.id ?? "");
  }
}

if (typeof document !== "undefined") {
  initializeIntakeApp();
}
