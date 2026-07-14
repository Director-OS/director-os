import type { DirectorReview, IntakeSummary, PhotoAssessment, PhotoMetrics } from "./intake-analysis.js";

export interface ProjectStatus {
  mediaComplete: boolean;
  marketingComplete: boolean;
  mlsReady: boolean;
  launchReady: boolean;
}

export interface UploadHistoryEntry {
  uploadedAt: string;
  fileCount: number;
  newCount: number;
  existingCount: number;
  note?: string;
}

export interface ProjectMediaHistoryEntry {
  action: "uploaded" | "analyzed" | "deleted" | "replaced";
  at: string;
  note?: string;
}

export interface ProjectMediaEntry {
  key: string;
  fileName: string;
  filePath: string;
  type: string;
  size: number;
  lastModified: number;
  uploadedAt: string;
  updatedAt: string;
  deletedAt: string | null;
  replacedByKey: string | null;
  metrics: PhotoMetrics | null;
  analysis: PhotoAssessment | null;
  history: ProjectMediaHistoryEntry[];
}

export interface DirectorProject {
  id: string;
  address: string;
  listPrice: string;
  createdAt: string;
  updatedAt: string;
  lastAnalyzedAt: string | null;
  lastUploadAt: string | null;
  uploadHistory: UploadHistoryEntry[];
  media: ProjectMediaEntry[];
  overrides: Record<string, { sceneTag?: string; decision?: string; rank?: number }>;
  latestSummary: IntakeSummary | null;
  latestReview: DirectorReview | null;
  newSinceLastAnalysis: number;
  status: ProjectStatus;
}

const STORAGE_KEY = "director-os-projects-v1";

function nowIso(): string {
  return new Date().toISOString();
}

function safeStorage(): Storage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}

function readAll(): DirectorProject[] {
  const storage = safeStorage();
  if (!storage) {
    return [];
  }

  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as DirectorProject[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(projects: DirectorProject[]): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function listProjects(): DirectorProject[] {
  return readAll().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function projectIdFromAddress(address: string): string {
  const normalized = address.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return normalized.length > 0 ? normalized : `project-${Date.now()}`;
}

function fileKey(filePath: string, size: number, lastModified: number): string {
  return `${filePath}::${size}::${lastModified}`;
}

export function getOrCreateProject(address: string, listPrice: string): DirectorProject {
  const projects = readAll();
  const normalized = address.trim().toLowerCase();
  const existing = projects.find((project) => project.address.trim().toLowerCase() === normalized);
  if (existing) {
    if (listPrice && existing.listPrice !== listPrice) {
      existing.listPrice = listPrice;
      existing.updatedAt = nowIso();
      writeAll(projects);
    }
    return existing;
  }

  const now = nowIso();
  const created: DirectorProject = {
    id: projectIdFromAddress(address),
    address,
    listPrice,
    createdAt: now,
    updatedAt: now,
    lastAnalyzedAt: null,
    lastUploadAt: null,
    uploadHistory: [],
    media: [],
    overrides: {},
    latestSummary: null,
    latestReview: null,
    newSinceLastAnalysis: 0,
    status: {
      mediaComplete: false,
      marketingComplete: false,
      mlsReady: false,
      launchReady: false
    }
  };

  writeAll([created, ...projects]);
  return created;
}

export function loadProject(projectId: string): DirectorProject | null {
  return readAll().find((project) => project.id === projectId) ?? null;
}

export function saveProject(project: DirectorProject): DirectorProject {
  const projects = readAll();
  const index = projects.findIndex((item) => item.id === project.id);
  const next = {
    ...project,
    updatedAt: nowIso()
  };

  if (index >= 0) {
    projects[index] = next;
  } else {
    projects.unshift(next);
  }

  writeAll(projects);
  return next;
}

export function syncUploadIntoProject(
  project: DirectorProject,
  files: File[],
  replacePath?: string
): { project: DirectorProject; newFiles: File[]; existingFiles: File[]; filePathByName: Map<string, string> } {
  const now = nowIso();
  const updatedProject: DirectorProject = {
    ...project,
    media: [...project.media],
    uploadHistory: [...project.uploadHistory]
  };

  const newFiles: File[] = [];
  const existingFiles: File[] = [];
  const filePathByName = new Map<string, string>();

  files.forEach((file, index) => {
    const defaultPath = file.webkitRelativePath || file.name;
    const effectivePath = replacePath && index === 0 ? replacePath : defaultPath;
    filePathByName.set(file.name, effectivePath);

    const key = fileKey(effectivePath, file.size, file.lastModified);
    const duplicate = updatedProject.media.find((item) => item.key === key && item.deletedAt === null);
    if (duplicate) {
      existingFiles.push(file);
      return;
    }

    const replaced = updatedProject.media.find((item) => item.filePath === effectivePath && item.deletedAt === null);
    if (replaced) {
      replaced.deletedAt = now;
      replaced.replacedByKey = key;
      replaced.updatedAt = now;
      replaced.history.push({ action: "replaced", at: now, note: `Replaced by ${file.name}` });
    }

    updatedProject.media.push({
      key,
      fileName: file.name,
      filePath: effectivePath,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      uploadedAt: now,
      updatedAt: now,
      deletedAt: null,
      replacedByKey: null,
      metrics: null,
      analysis: null,
      history: [{ action: "uploaded", at: now }]
    });

    newFiles.push(file);
  });

  updatedProject.lastUploadAt = now;
  updatedProject.newSinceLastAnalysis = (updatedProject.newSinceLastAnalysis ?? 0) + newFiles.length;
  updatedProject.uploadHistory.unshift({
    uploadedAt: now,
    fileCount: files.length,
    newCount: newFiles.length,
    existingCount: existingFiles.length,
    note: replacePath ? `Replace operation for ${replacePath}` : undefined
  });

  return {
    project: updatedProject,
    newFiles,
    existingFiles,
    filePathByName
  };
}

export function activeMedia(project: DirectorProject): ProjectMediaEntry[] {
  return project.media.filter((item) => item.deletedAt === null);
}

export function updateMediaMetrics(project: DirectorProject, metrics: PhotoMetrics[]): DirectorProject {
  const now = nowIso();
  const byPath = new Map(metrics.map((item) => [item.filePath, item]));
  const updatedMedia = project.media.map((item) => {
    if (item.deletedAt !== null) {
      return item;
    }

    const metric = byPath.get(item.filePath);
    if (!metric) {
      return item;
    }

    const analyzedEntry: ProjectMediaHistoryEntry = {
      action: "analyzed",
      at: now
    };

    return {
      ...item,
      metrics: metric,
      updatedAt: now,
      history: [...item.history, analyzedEntry]
    };
  });

  return {
    ...project,
    media: updatedMedia
  };
}

export function mergeAssessmentsWithHistory(
  previous: PhotoAssessment[],
  next: PhotoAssessment[]
): PhotoAssessment[] {
  const previousByPath = new Map(previous.map((item) => [item.filePath, item]));
  const usedRanks = new Set<number>();

  const annotated = next.map((item) => {
    const old = previousByPath.get(item.filePath);
    if (!old) {
      return { item, preserveRank: false, rank: 0 };
    }

    const unchanged =
      old.heroScore === item.heroScore &&
      old.decision === item.decision &&
      old.sceneTag === item.sceneTag &&
      old.duplicateGroupId === item.duplicateGroupId &&
      old.similarGroupId === item.similarGroupId;

    if (unchanged && old.recommendedMlsOrder > 0) {
      usedRanks.add(old.recommendedMlsOrder);
      return { item: { ...item, recommendedMlsOrder: old.recommendedMlsOrder }, preserveRank: true, rank: old.recommendedMlsOrder };
    }

    return { item, preserveRank: false, rank: 0 };
  });

  const pending = annotated
    .filter((entry) => !entry.preserveRank)
    .map((entry) => entry.item)
    .sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);

  let nextRank = 1;
  for (const item of pending) {
    while (usedRanks.has(nextRank)) {
      nextRank += 1;
    }
    item.recommendedMlsOrder = nextRank;
    usedRanks.add(nextRank);
    nextRank += 1;
  }

  return annotated.map((entry) => entry.item).sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);
}

export function attachAssessments(project: DirectorProject, assessments: PhotoAssessment[]): DirectorProject {
  const now = nowIso();
  const byPath = new Map(assessments.map((item) => [item.filePath, item]));

  return {
    ...project,
    media: project.media.map((item) => {
      if (item.deletedAt !== null) {
        return item;
      }
      const analysis = byPath.get(item.filePath) ?? item.analysis;
      return {
        ...item,
        analysis,
        updatedAt: now
      };
    }),
    lastAnalyzedAt: now,
    newSinceLastAnalysis: 0
  };
}

export function applyProjectStatus(project: DirectorProject, summary: IntakeSummary, review: DirectorReview): DirectorProject {
  const status: ProjectStatus = {
    mediaComplete: summary.mediaCounts.photos >= 24 && summary.mediaCounts.videos >= 1 && summary.mediaCounts.pdfs >= 1,
    marketingComplete: summary.photos.filter((photo) => photo.decision !== "remove").length >= 12,
    mlsReady: review.launchReadinessScore >= 70,
    launchReady: review.launchReadinessScore >= 85
  };

  return {
    ...project,
    latestSummary: summary,
    latestReview: review,
    status
  };
}

export function deleteProjectMedia(project: DirectorProject, filePath: string): DirectorProject {
  const now = nowIso();
  return {
    ...project,
    media: project.media.map((item) => {
      if (item.filePath !== filePath || item.deletedAt !== null) {
        return item;
      }

      const deletedEntry: ProjectMediaHistoryEntry = {
        action: "deleted",
        at: now
      };

      return {
        ...item,
        deletedAt: now,
        updatedAt: now,
        history: [...item.history, deletedEntry]
      };
    })
  };
}

export function projectSummaryFromStored(project: DirectorProject): IntakeSummary | null {
  if (project.latestSummary) {
    return project.latestSummary;
  }

  const photos = activeMedia(project)
    .map((item) => item.analysis)
    .filter((item): item is PhotoAssessment => item !== null)
    .sort((a, b) => a.recommendedMlsOrder - b.recommendedMlsOrder);

  if (photos.length === 0) {
    return null;
  }

  return {
    address: project.address,
    listPrice: project.listPrice,
    fileCount: activeMedia(project).length,
    mediaCounts: {
      photos: activeMedia(project).length,
      videos: 0,
      pdfs: 0,
      documents: 0,
      other: 0
    },
    photos,
    generatedAt: project.lastAnalyzedAt ?? nowIso()
  };
}
