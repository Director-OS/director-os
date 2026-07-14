import {
  buildDirectorReview,
  classifyMedia,
  createTextReport,
  rankHeroCandidates,
  type FileDescriptor,
  type HeroCandidate,
  type IntakeSummary,
  type PhotoMetrics
} from "./intake-analysis.js";

interface AppState {
  files: File[];
  summary: IntakeSummary | null;
}

const state: AppState = {
  files: [],
  summary: null
};

const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "avif"]);

function getExtension(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts[parts.length - 1] ?? "";
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || imageExtensions.has(getExtension(file.name));
}

function toMetricClass(value: number): "good" | "warn" | "bad" {
  if (value >= 75) {
    return "good";
  }
  if (value >= 50) {
    return "warn";
  }
  return "bad";
}

function extractChannelMetrics(pixels: Uint8ClampedArray): {
  brightness: number;
  contrast: number;
  saturation: number;
  sharpness: number;
} {
  const channelCount = Math.floor(pixels.length / 4);
  if (channelCount === 0) {
    return {
      brightness: 0.5,
      contrast: 0,
      saturation: 0,
      sharpness: 0
    };
  }

  let lumaSum = 0;
  let lumaSquaredSum = 0;
  let saturationSum = 0;
  const luminanceValues = new Float32Array(channelCount);

  for (let index = 0, pixelIndex = 0; pixelIndex < pixels.length; index += 1, pixelIndex += 4) {
    const r = (pixels[pixelIndex] ?? 0) / 255;
    const g = (pixels[pixelIndex + 1] ?? 0) / 255;
    const b = (pixels[pixelIndex + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

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
  for (let index = 1; index < luminanceValues.length - 1; index += 1) {
    const previous = luminanceValues[index - 1] ?? 0;
    const current = luminanceValues[index] ?? 0;
    const next = luminanceValues[index + 1] ?? 0;
    sharpnessSum += Math.abs(previous - 2 * current + next);
  }
  const sharpness = sharpnessSum / Math.max(luminanceValues.length - 2, 1);

  return {
    brightness: meanLuma,
    contrast,
    saturation,
    sharpness: sharpness * 255
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
  const { brightness, contrast, saturation, sharpness } = extractChannelMetrics(pixels);

  return {
    fileName: file.name,
    width: originalWidth,
    height: originalHeight,
    brightness,
    contrast,
    saturation,
    sharpness
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

function renderPhotoTable(candidates: HeroCandidate[]): void {
  const table = document.getElementById("photoTable");
  if (!table) {
    return;
  }

  if (candidates.length === 0) {
    table.innerHTML = "<p>No photos detected in this folder.</p>";
    return;
  }

  const rows = candidates.slice(0, 16).map((candidate, index) => {
    const scoreClass = toMetricClass(candidate.heroScore);
    const brightness = Math.round(candidate.brightness * 100);
    const contrast = Math.round(candidate.contrast * 1000) / 10;
    const sharpness = Math.round(candidate.sharpness);

    return `<div class="photo-row">
      <div class="rank">#${index + 1}</div>
      <div><strong>${candidate.fileName}</strong><small>${candidate.orientation} | ${candidate.width}x${candidate.height}</small></div>
      <div class="metric ${scoreClass}">${candidate.heroScore}<small>Hero score</small></div>
      <div class="metric hide-mobile">${brightness}<small>Brightness</small></div>
      <div class="metric hide-mobile">${contrast}<small>Contrast</small></div>
      <div class="metric hide-mobile">${sharpness}<small>Sharpness</small></div>
    </div>`;
  });

  table.innerHTML = rows.join("");
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

function renderResults(summary: IntakeSummary): void {
  const review = buildDirectorReview(summary);
  state.summary = summary;

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
  setText("photoCount", `${summary.mediaCounts.photos}`);
  setText("videoCount", `${summary.mediaCounts.videos}`);
  setText("pdfCount", `${summary.mediaCounts.pdfs}`);
  setText("documentCount", `${summary.mediaCounts.documents}`);
  setText("otherCount", `${summary.mediaCounts.other}`);
  setText("story", review.storyAngle);
  setText("angle", review.buyerAngle);
  setText("runtime", summary.mediaCounts.videos > 0 ? "30-60 second highlight cut" : "Capture teaser before launch");

  updateList("missingMedia", review.missingMedia, "No missing media detected.");
  updateList("actions", review.actionItems, "No action items.");
  renderPhotoTable(summary.heroCandidates);

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
        review
      };
      triggerDownload("director-intake-report.json", "application/json", JSON.stringify(payload, null, 2));
    };
  }
}

async function processIntake(files: File[], address: string, listPrice: string): Promise<void> {
  const progressCard = document.getElementById("progressCard");
  if (progressCard) {
    progressCard.classList.remove("hidden");
  }

  const descriptors: FileDescriptor[] = files.map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size
  }));
  const mediaCounts = classifyMedia(descriptors);
  const photoFiles = files.filter((file) => isImageFile(file));
  const photoMetrics: PhotoMetrics[] = [];

  for (let index = 0; index < photoFiles.length; index += 1) {
    const file = photoFiles[index];
    if (!file) {
      continue;
    }
    setProgress(
      Math.round((index / Math.max(photoFiles.length, 1)) * 100),
      `Analyzing ${index + 1} of ${photoFiles.length} photos: ${file.name}`
    );

    try {
      const metrics = await analyzePhoto(file);
      photoMetrics.push(metrics);
    } catch {
      // Continue analysis even if one media file cannot be decoded.
    }
  }

  setProgress(100, "Generating Director review");
  const heroCandidates = rankHeroCandidates(photoMetrics);
  const summary: IntakeSummary = {
    address,
    listPrice,
    mediaCounts,
    heroCandidates,
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
    const photoCount = files.filter((file) => isImageFile(file)).length;
    const helperText = dropzone.querySelector("span");
    if (helperText) {
      helperText.textContent = `${files.length} files selected (${photoCount} photos)`;
    }
  }
}

function initializeIntakeApp(): void {
  const folderInput = document.getElementById("folderInput") as HTMLInputElement | null;
  const analyzeBtn = document.getElementById("analyzeBtn") as HTMLButtonElement | null;
  const dropzone = document.getElementById("dropzone");
  const addressInput = document.getElementById("address") as HTMLInputElement | null;
  const priceInput = document.getElementById("price") as HTMLInputElement | null;

  if (!folderInput || !analyzeBtn || !dropzone || !addressInput || !priceInput) {
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
}

if (typeof document !== "undefined") {
  initializeIntakeApp();
}
