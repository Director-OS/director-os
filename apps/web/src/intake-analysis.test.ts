import { describe, expect, it } from "vitest";

import {
  buildDirectorReview,
  classifyMedia,
  createTextReport,
  rankHeroCandidates,
  type IntakeSummary,
  type PhotoMetrics
} from "./intake-analysis.js";

describe("intake analysis", () => {
  it("classifies media inventory by type and extension", () => {
    const counts = classifyMedia([
      { name: "front.jpg", type: "image/jpeg" },
      { name: "walkthrough.mp4", type: "video/mp4" },
      { name: "brochure.pdf", type: "application/pdf" },
      { name: "disclosure.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { name: "notes.unknown" }
    ]);

    expect(counts).toEqual({
      photos: 1,
      videos: 1,
      pdfs: 1,
      documents: 1,
      other: 1
    });
  });

  it("ranks strongest hero candidate first", () => {
    const photos: PhotoMetrics[] = [
      {
        fileName: "hero.jpg",
        width: 3200,
        height: 2000,
        brightness: 0.56,
        contrast: 0.18,
        saturation: 0.34,
        sharpness: 40
      },
      {
        fileName: "dark-soft.jpg",
        width: 1600,
        height: 1200,
        brightness: 0.22,
        contrast: 0.08,
        saturation: 0.1,
        sharpness: 10
      }
    ];

    const ranked = rankHeroCandidates(photos);

    expect(ranked[0]?.fileName).toBe("hero.jpg");
    expect(ranked[0]?.heroScore).toBeGreaterThan(ranked[1]?.heroScore ?? 0);
  });

  it("builds review and text report", () => {
    const summary: IntakeSummary = {
      address: "10 Coastal Drive",
      listPrice: "$875,000",
      mediaCounts: {
        photos: 18,
        videos: 0,
        pdfs: 0,
        documents: 1,
        other: 0
      },
      heroCandidates: rankHeroCandidates([
        {
          fileName: "kitchen.jpg",
          width: 2800,
          height: 1800,
          brightness: 0.54,
          contrast: 0.16,
          saturation: 0.32,
          sharpness: 36
        }
      ]),
      generatedAt: "2026-07-13T12:00:00.000Z"
    };

    const review = buildDirectorReview(summary);
    const report = createTextReport(summary, review);

    expect(review.launchReadinessScore).toBeLessThan(85);
    expect(review.missingMedia.length).toBeGreaterThan(0);
    expect(report).toContain("Director Intake Report");
    expect(report).toContain("Likely Buyer Angle");
  });
});
