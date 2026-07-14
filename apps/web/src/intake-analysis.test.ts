import { describe, expect, it } from "vitest";

import {
  assessPhotos,
  buildDirectorReview,
  classifyMedia,
  createTextReport,
  type IntakeSummary,
  type PhotoMetrics
} from "./intake-analysis.js";

describe("intake analysis", () => {
  it("classifies media inventory by type and extension", () => {
    const counts = classifyMedia([
      { name: "IMG_0001.JPG", type: "image/jpeg" },
      { name: "IMG_0002.MP4", type: "video/mp4" },
      { name: "brochure.pdf", type: "application/pdf" },
      { name: "notes.txt", type: "text/plain" },
      { name: "blob.bin" }
    ]);

    expect(counts).toEqual({
      photos: 1,
      videos: 1,
      pdfs: 1,
      documents: 1,
      other: 1
    });
  });

  it("detects probable duplicates and assigns remove decision", () => {
    const photos: PhotoMetrics[] = [
      {
        fileName: "IMG_0001.JPG",
        filePath: "IMG_0001.JPG",
        thumbnailUrl: "blob:1",
        width: 2800,
        height: 1800,
        brightness: 0.56,
        contrast: 0.14,
        saturation: 0.31,
        sharpness: 42,
        edgeDensity: 0.15,
        blueRatio: 0.23,
        greenRatio: 0.22,
        warmRatio: 0.35,
        brightPixelRatio: 0.06,
        darkPixelRatio: 0.04,
        perceptualHash: "1111000011110000111100001111000011110000111100001111000011110000",
        colorHistogram: Array.from({ length: 12 }, () => 1 / 12)
      },
      {
        fileName: "IMG_0002.JPG",
        filePath: "IMG_0002.JPG",
        thumbnailUrl: "blob:2",
        width: 2800,
        height: 1800,
        brightness: 0.55,
        contrast: 0.14,
        saturation: 0.31,
        sharpness: 41,
        edgeDensity: 0.15,
        blueRatio: 0.23,
        greenRatio: 0.22,
        warmRatio: 0.35,
        brightPixelRatio: 0.06,
        darkPixelRatio: 0.04,
        perceptualHash: "1111000011110000111100001111000011110000111100001111000011110001",
        colorHistogram: Array.from({ length: 12 }, () => 1 / 12)
      }
    ];

    const assessed = assessPhotos(photos);

    expect(assessed.length).toBe(2);
    expect(assessed.some((item) => item.decision === "remove")).toBe(true);
    expect(assessed.some((item) => item.issues.includes("redundant"))).toBe(true);
  });

  it("uses pixel traits for scene inference with unnamed files", () => {
    const assessed = assessPhotos([
      {
        fileName: "IMG_0007.JPG",
        filePath: "IMG_0007.JPG",
        thumbnailUrl: "blob:7",
        width: 3200,
        height: 1900,
        brightness: 0.62,
        contrast: 0.18,
        saturation: 0.3,
        sharpness: 46,
        edgeDensity: 0.12,
        blueRatio: 0.34,
        greenRatio: 0.2,
        warmRatio: 0.2,
        brightPixelRatio: 0.08,
        darkPixelRatio: 0.03,
        perceptualHash: "1010101010101010101010101010101010101010101010101010101010101010",
        colorHistogram: [0.08, 0.07, 0.06, 0.04, 0.03, 0.07, 0.09, 0.05, 0.12, 0.13, 0.14, 0.12]
      }
    ]);

    expect(assessed[0]?.sceneTag).toBe("exterior-front");
  });

  it("builds review and text report with sequencing", () => {
    const photos = assessPhotos([
      {
        fileName: "IMG_1001.JPG",
        filePath: "IMG_1001.JPG",
        thumbnailUrl: "blob:a",
        width: 3200,
        height: 1900,
        brightness: 0.58,
        contrast: 0.16,
        saturation: 0.3,
        sharpness: 42,
        edgeDensity: 0.13,
        blueRatio: 0.31,
        greenRatio: 0.24,
        warmRatio: 0.25,
        brightPixelRatio: 0.07,
        darkPixelRatio: 0.04,
        perceptualHash: "1001100110011001100110011001100110011001100110011001100110011001",
        colorHistogram: Array.from({ length: 12 }, () => 1 / 12)
      }
    ]);

    const summary: IntakeSummary = {
      address: "55 Test Drive",
      listPrice: "$515,000",
      fileCount: 4,
      mediaCounts: {
        photos: 1,
        videos: 0,
        pdfs: 0,
        documents: 0,
        other: 3
      },
      photos,
      generatedAt: "2026-07-14T00:00:00.000Z"
    };

    const review = buildDirectorReview(summary);
    const report = createTextReport(summary, review);

    expect(review.missingShotChecklist.length).toBeGreaterThan(0);
    expect(report).toContain("Recommended MLS Order");
    expect(report).toContain("Executive Summary");
    expect(report).toContain("IMG_1001.JPG");
  });
});
