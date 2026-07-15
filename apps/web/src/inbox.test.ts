import { describe, expect, it } from "vitest";

import { acceptedFiles, buildInbox, classifyCounts } from "./inbox.js";

describe("director inbox", () => {
  it("classifies key media kinds and ignores contract docs", () => {
    const files = [
      new File(["raw"], "IMG_1001.CR3", { type: "application/octet-stream", lastModified: 1 }),
      new File(["edit"], "IMG_1001_edited.jpg", { type: "image/jpeg", lastModified: 2 }),
      new File(["doc"], "purchase-contract.pdf", { type: "application/pdf", lastModified: 3 }),
      new File(["video"], "walkthrough.mp4", { type: "video/mp4", lastModified: 4 }),
      new File(["plan"], "floorplan.pdf", { type: "application/pdf", lastModified: 5 })
    ];

    const inbox = buildInbox(files, new Set());
    const counts = classifyCounts(inbox);

    expect(counts.raw).toBe(1);
    expect(counts.edited).toBe(1);
    expect(counts.contract).toBe(1);
    expect(counts.video).toBe(1);
    expect(counts["floor-plan"]).toBe(1);

    const contract = inbox.find((item) => item.fileName === "purchase-contract.pdf");
    expect(contract?.decision).toBe("ignore");
    expect(contract?.locked).toBe(false);
  });

  it("adds raw/edited recommendation when both exist", () => {
    const files = [
      new File(["raw"], "kitchen_raw.dng", { type: "application/octet-stream", lastModified: 1 }),
      new File(["edit"], "kitchen_edited.jpg", { type: "image/jpeg", lastModified: 2 })
    ];

    const inbox = buildInbox(files, new Set());
    const raw = inbox.find((item) => item.kind === "raw");
    const edited = inbox.find((item) => item.kind === "edited");

    expect(raw?.recommendation.toLowerCase()).toContain("raw + edited pair");
    expect(edited?.recommendation.toLowerCase()).toContain("raw + edited pair");
    expect(raw?.autoEditCandidate).toBe(true);
  });

  it("filters accepted files only", () => {
    const files = [
      new File(["a"], "a.jpg", { type: "image/jpeg", lastModified: 1 }),
      new File(["b"], "b.txt", { type: "text/plain", lastModified: 2 })
    ];
    const inbox = buildInbox(files, new Set());

    const documentItem = inbox.find((item) => item.fileName === "b.txt");
    if (documentItem) {
      documentItem.decision = "reject";
    }

    const accepted = acceptedFiles(inbox, files);
    expect(accepted.length).toBe(1);
    expect(accepted[0]?.name).toBe("a.jpg");
  });
});
