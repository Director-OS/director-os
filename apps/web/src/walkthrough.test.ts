import { describe, expect, it } from "vitest";

import {
  addManualFact,
  applyFactDecisionToWalkthrough,
  createWalkthroughRecord,
  detectFactConflicts,
  parseTranscriptImport,
  searchWalkthrough,
  transitionRecorderState,
  updateWalkthroughTranscript
} from "./walkthrough.js";

const SAMPLE_CONVERSATION = [
  "Seller said the roof was replaced in 2019 with a transferable warranty.",
  "HVAC was installed in 2022 and serviced last month.",
  "HOA is 95 dollars monthly and contact is management at North Ridge.",
  "Seller wants to list around $525,000 but discussed a range from $510,000 to $540,000.",
  "Seller will move after closing and needs 30 day possession.",
  "Agent will collect permit receipts and seller will send appliance invoices.",
  "There is a possible basement leak concern after heavy rain."
].join(" ");

describe("walkthrough workflow", () => {
  it("supports recording-state transitions", () => {
    expect(transitionRecorderState("idle", "start")).toBe("recording");
    expect(transitionRecorderState("recording", "pause")).toBe("paused");
    expect(transitionRecorderState("paused", "resume")).toBe("recording");
    expect(transitionRecorderState("recording", "stop")).toBe("stopped");
    expect(transitionRecorderState("stopped", "save")).toBe("saving");
  });

  it("imports transcript text from txt, markdown, and json formats", () => {
    const txt = parseTranscriptImport("walkthrough.txt", "text/plain", SAMPLE_CONVERSATION);
    const md = parseTranscriptImport("walkthrough.md", "text/markdown", `# Walkthrough\n${SAMPLE_CONVERSATION}`);
    const json = parseTranscriptImport(
      "walkthrough.json",
      "application/json",
      JSON.stringify({
        segments: [
          { text: "Roof replaced in 2019", startMs: 0, endMs: 2000 },
          { text: "HVAC installed in 2022", startMs: 2000, endMs: 5000 }
        ]
      })
    );

    expect(txt.segments.length).toBeGreaterThan(0);
    expect(md.text.includes("Walkthrough")).toBe(true);
    expect(json.segments.length).toBe(2);
  });

  it("extracts facts with confidence and status", () => {
    const walkthrough = createWalkthroughRecord({
      title: "Listing appt",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: SAMPLE_CONVERSATION
    });

    expect(walkthrough.facts.length).toBeGreaterThan(5);
    const roofFact = walkthrough.facts.find((fact) => fact.category === "Roof");
    expect(roofFact).toBeDefined();
    expect(roofFact?.confidence).toBeGreaterThan(0.7);
    expect(["Confirmed", "Needs Verification", "Uncertain"]).toContain(roofFact?.status);
  });

  it("supports correction, rejection, and manual missing fact entries", () => {
    const walkthrough = createWalkthroughRecord({
      title: "Listing appt",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: SAMPLE_CONVERSATION
    });
    const targetFact = walkthrough.facts[0];
    expect(targetFact).toBeDefined();

    const corrected = applyFactDecisionToWalkthrough(
      walkthrough,
      targetFact?.id ?? "",
      "corrected",
      "Roof replacement confirmed by invoice in 2020"
    );
    const correctedFact = corrected.facts.find((fact) => fact.id === targetFact?.id);
    expect(correctedFact?.decision).toBe("corrected");
    expect(correctedFact?.correctedValue).toContain("2020");

    const rejected = applyFactDecisionToWalkthrough(corrected, targetFact?.id ?? "", "rejected");
    const rejectedFact = rejected.facts.find((fact) => fact.id === targetFact?.id);
    expect(rejectedFact?.decision).toBe("rejected");

    const withManual = addManualFact(rejected, {
      category: "Utility Information",
      value: "Average utility cost 190/month",
      quote: "Seller shared utility average",
      status: "Needs Verification"
    });
    expect(withManual.facts.some((fact) => fact.value.includes("190/month"))).toBe(true);
  });

  it("supports additional walkthrough imports and project-wide search patterns", () => {
    const first = createWalkthroughRecord({
      title: "First walkthrough",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: SAMPLE_CONVERSATION
    });
    const second = createWalkthroughRecord({
      title: "Second walkthrough",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: "Seller confirmed HVAC serviced in 2024 and washer is excluded from sale."
    });

    const firstSearch = searchWalkthrough(first, "roof");
    const secondSearch = searchWalkthrough(second, "washer");

    expect(firstSearch.factMatches.length).toBeGreaterThan(0);
    expect(secondSearch.factMatches.some((fact) => fact.value.toLowerCase().includes("washer"))).toBe(true);
  });

  it("detects conflicting facts and keeps both sources unresolved", () => {
    const first = createWalkthroughRecord({
      title: "First walkthrough",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: "Seller said HVAC installed in 2022."
    });

    const second = createWalkthroughRecord({
      title: "Second walkthrough",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: "Prior project note says HVAC installed in 2020."
    });

    const conflicts = detectFactConflicts(first.facts, second.facts);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]?.message.toLowerCase().includes("conflict")).toBe(true);
  });

  it("rebuilds extraction after transcript edit", () => {
    const walkthrough = createWalkthroughRecord({
      title: "Editable walkthrough",
      sourceType: "upload",
      providerId: "uploaded-text",
      transcriptText: "Seller mentioned roof details."
    });

    const edited = updateWalkthroughTranscript(
      walkthrough,
      "Seller said roof replaced in 2018 and water heater replaced in 2021.",
      "Agent"
    );

    expect(edited.transcript.revisions.length).toBe(1);
    expect(edited.facts.some((fact) => fact.category === "Roof")).toBe(true);
    expect(edited.facts.some((fact) => fact.category === "Water Heater")).toBe(true);
  });
});
