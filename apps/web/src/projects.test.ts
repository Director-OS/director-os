import { describe, expect, it } from "vitest";

import type { PhotoAssessment } from "./intake-analysis.js";
import {
  deleteProjectMedia,
  mergeAssessmentsWithHistory,
  syncUploadIntoProject,
  type DirectorProject
} from "./projects.js";

function baseProject(): DirectorProject {
  return {
    id: "123-director-lane",
    address: "123 Director Lane",
    listPrice: "$425,000",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    lastAnalyzedAt: null,
    lastUploadAt: null,
    uploadHistory: [],
    media: [],
    overrides: {},
    activity: [],
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
}

function makeAssessment(filePath: string, heroScore: number, rank: number): PhotoAssessment {
  return {
    fileName: filePath,
    filePath,
    thumbnailUrl: "blob:test",
    width: 1920,
    height: 1080,
    brightness: 0.55,
    contrast: 0.12,
    saturation: 0.3,
    sharpness: 40,
    edgeDensity: 0.11,
    blueRatio: 0.2,
    greenRatio: 0.2,
    warmRatio: 0.2,
    brightPixelRatio: 0.08,
    darkPixelRatio: 0.06,
    perceptualHash: "10101010",
    colorHistogram: Array.from({ length: 12 }, () => 1 / 12),
    sceneTag: "kitchen",
    scores: {
      sharpness: 60,
      exposure: 60,
      brightness: 60,
      contrast: 60,
      resolution: 60,
      orientation: 95,
      usableAspect: 80
    },
    totalScore: heroScore,
    issues: [],
    scoreReasons: [],
    recommendationReasons: [],
    decision: "recommended",
    duplicateGroupId: null,
    similarGroupId: null,
    duplicateOfPath: null,
    recommendedMlsOrder: rank,
    heroScore,
    vision: {
      engineVersion: "director-vision-engine-v1",
      scene: { label: "kitchen", confidence: 0.9 },
      quality: {
        sharpness: 60,
        noise: 60,
        brightness: 60,
        exposure: 60,
        whiteBalance: 60,
        contrast: 60,
        dynamicRange: 60,
        resolution: 60,
        horizonLevel: 90,
        lensDistortion: 80,
        verticalCorrection: 85,
        composition: 70
      },
      marketing: {
        heroImageScore: heroScore,
        zillowAppeal: heroScore,
        mlsAppeal: heroScore,
        luxuryAppeal: heroScore,
        emotionalImpact: heroScore,
        clickLikelihood: heroScore
      },
      problems: [],
      recommendations: [
        {
          action: "keep",
          confidence: 0.9,
          reason: "test"
        }
      ]
    },
    primaryRecommendation: {
      action: "keep",
      confidence: 0.9,
      reason: "test"
    }
  };
}

describe("projects store logic", () => {
  it("detects already analyzed files and only marks new files as new", () => {
    const initial = baseProject();
    const file = new File(["abc"], "front.jpg", { type: "image/jpeg", lastModified: 1700000000000 });

    const firstSync = syncUploadIntoProject(initial, [file]);
    expect(firstSync.newFiles.length).toBe(1);
    expect(firstSync.existingFiles.length).toBe(0);

    const secondSync = syncUploadIntoProject(firstSync.project, [file]);
    expect(secondSync.newFiles.length).toBe(0);
    expect(secondSync.existingFiles.length).toBe(1);
    expect(secondSync.project.uploadHistory[0]?.existingCount).toBe(1);
  });

  it("preserves previous hero ranking for unchanged photos", () => {
    const previous = [makeAssessment("a.jpg", 80, 2), makeAssessment("b.jpg", 75, 1)];
    const next = [makeAssessment("a.jpg", 80, 1), makeAssessment("b.jpg", 75, 2)];

    const merged = mergeAssessmentsWithHistory(previous, next);
    const a = merged.find((item) => item.filePath === "a.jpg");
    const b = merged.find((item) => item.filePath === "b.jpg");

    expect(a?.recommendedMlsOrder).toBe(2);
    expect(b?.recommendedMlsOrder).toBe(1);
  });

  it("marks files deleted without removing historical entries", () => {
    const file = new File(["abc"], "delete-me.jpg", { type: "image/jpeg", lastModified: 1700000000001 });
    const synced = syncUploadIntoProject(baseProject(), [file]);

    const deleted = deleteProjectMedia(synced.project, "delete-me.jpg");
    const entry = deleted.media.find((item) => item.filePath === "delete-me.jpg");

    expect(entry?.deletedAt).not.toBeNull();
    expect(entry?.history.some((event) => event.action === "deleted")).toBe(true);
  });
});
