import {
  assessPhotos,
  buildDirectorReview,
  classifyMedia,
  createTextReport,
  isImageDescriptor,
  type DecisionTag,
  type FileDescriptor,
  type IntakeSummary,
  type PhotoAssessment,
  type PhotoMetrics,
  type SceneTag
} from "./intake-analysis.js";

type FilterTag = "all" | "recommended" | "needs-work" | "remove";

interface PhotoOverride {
  sceneTag?: SceneTag;
  decision?: DecisionTag;
  rank?: number;
}

interface AppState {
  files: File[];
  summary: IntakeSummary | null;
  photoAssessments: PhotoAssessment[];
  filter: FilterTag;
  overrides: Record<string, PhotoOverride>;
}

const state: AppState = {
  files: [],
  summary: null,
  photoAssessments: [],
  filter: "all",
  overrides: {}
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
  if (tag === "primary-bedroom") {
    return "primary bedroom";
  }
  return tag;
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

async function analyzePhoto(file: File): Promise<PhotoMetrics> {
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
    filePath: file.webkitRelativePath || file.name,
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

function triggerDownload(fileName: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
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
    .sort((a, b) => b.heroScore - a.heroScore)
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

      return `<div class="photo-row" data-photo-path="${photo.filePath}">
        <img class="thumb" src="${photo.thumbnailUrl}" alt="${photo.fileName}" />
        <div>
          <strong>${photo.fileName}</strong>
          <small>${photo.width}x${photo.height} | scene: ${prettySceneTag(photo.sceneTag)} | dup: ${duplicate} | sim: ${similar}</small>
          <small>Scores: sharpness ${photo.scores.sharpness}, exposure ${photo.scores.exposure}, brightness ${photo.scores.brightness}, contrast ${photo.scores.contrast}, resolution ${photo.scores.resolution}, orientation ${photo.scores.orientation}, aspect ${photo.scores.usableAspect}</small>
          <small>Issues: ${issues}</small>
          <small>Recommendation: ${photo.recommendationReasons.join(" ")}</small>
        </div>
        <div class="metric ${scoreClass}">${photo.heroScore}<small>Hero</small></div>
        <div class="metric hide-mobile">${photo.recommendedMlsOrder}<small>MLS order</small></div>
        <div class="control-block">
          <label>Room
            <select class="scene-override" data-path="${photo.filePath}">${selectOptions<SceneTag>(["exterior", "backyard", "kitchen", "primary-bedroom", "bathroom", "interior", "unknown"], photo.sceneTag)}</select>
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
}

function renderResults(summary: IntakeSummary): void {
  const review = buildDirectorReview(summary);
  state.summary = summary;
  state.photoAssessments = summary.photos;

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
}

async function processIntake(files: File[], address: string, listPrice: string): Promise<void> {
  const progressCard = document.getElementById("progressCard");
  if (progressCard) {
    progressCard.classList.remove("hidden");
  }

  const descriptors: FileDescriptor[] = files.map((file) => ({
    name: file.name,
    path: file.webkitRelativePath || file.name,
    type: file.type,
    size: file.size
  }));

  const mediaCounts = classifyMedia(descriptors);
  const photoMetrics: PhotoMetrics[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) {
      continue;
    }

    setProgress(
      Math.round(((index + 1) / Math.max(files.length, 1)) * 100),
      `Analyzing file ${index + 1} of ${files.length}: ${file.name}`
    );

    if (isImageDescriptor({ name: file.name, type: file.type })) {
      try {
        const metrics = await analyzePhoto(file);
        photoMetrics.push(metrics);
      } catch {
        // Continue analysis even if one image cannot be decoded.
      }
    }
  }

  const photos = assessPhotos(photoMetrics);

  const summary: IntakeSummary = {
    address,
    listPrice,
    fileCount: files.length,
    mediaCounts,
    photos,
    generatedAt: new Date().toISOString()
  };

  renderResults(summary);
}

function assignFiles(files: File[]): void {
  state.files = files;
  const analyzeBtn = document.getElementById("analyzeBtn") as HTMLButtonElement | null;
  const dropzone = document.getElementById("dropzone");

  if (analyzeBtn) {
    analyzeBtn.disabled = files.length === 0;
  }

  if (dropzone) {
    const helperText = dropzone.querySelector("span");
    if (helperText) {
      helperText.textContent = `${files.length} files selected`;
    }
  }
}

function applyOverride(path: string, patch: PhotoOverride): void {
  const current = state.overrides[path] ?? {};
  state.overrides[path] = {
    ...current,
    ...patch
  };
  updateDashboardFromState();
}

function initializeIntakeApp(): void {
  const folderInput = document.getElementById("folderInput") as HTMLInputElement | null;
  const analyzeBtn = document.getElementById("analyzeBtn") as HTMLButtonElement | null;
  const dropzone = document.getElementById("dropzone");
  const addressInput = document.getElementById("address") as HTMLInputElement | null;
  const priceInput = document.getElementById("price") as HTMLInputElement | null;
  const table = document.getElementById("photoTable");

  if (!folderInput || !analyzeBtn || !dropzone || !addressInput || !priceInput || !table) {
    return;
  }

  folderInput.addEventListener("change", () => {
    assignFiles(Array.from(folderInput.files ?? []));
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
        await processIntake(state.files, addressInput.value.trim(), priceInput.value.trim());
      } finally {
        analyzeBtn.disabled = false;
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
}

if (typeof document !== "undefined") {
  initializeIntakeApp();
}
