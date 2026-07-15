import { splitTranscript, type TranscriptSegment } from "./transcription.js";

export type FactStatus = "Confirmed" | "Needs Verification" | "Uncertain";
export type FactDecision = "pending" | "confirmed" | "corrected" | "rejected" | "follow-up";

export interface WalkthroughAudioRecord {
  mimeType: string;
  dataUrl: string;
  durationMs: number;
  sourceLabel: string;
}

export interface TranscriptRevision {
  at: string;
  editor: string;
  reason: string;
  previousText: string;
  nextText: string;
}

export interface WalkthroughTranscript {
  providerId: string;
  originalText: string;
  editedText: string;
  segments: TranscriptSegment[];
  revisions: TranscriptRevision[];
}

export interface ExtractedFact {
  id: string;
  category: string;
  value: string;
  quote: string;
  transcriptTimestampMs: number | null;
  confidence: number;
  status: FactStatus;
  decision: FactDecision;
  sourceWalkthroughId: string;
  correctedValue?: string;
  sourceType: "transcript" | "project" | "document" | "equipment-label";
}

export interface ConflictFlag {
  id: string;
  category: string;
  sourceFactId: string;
  conflictingFactId: string;
  message: string;
  valueA: string;
  valueB: string;
}

export interface WalkthroughDebriefSection {
  id: string;
  title:
    | "Executive Summary"
    | "Key Property Facts"
    | "Seller Priorities"
    | "Pricing Discussion"
    | "Timing and Possession"
    | "Included and Excluded Items"
    | "Improvements"
    | "Known Concerns"
    | "Marketing Opportunities"
    | "Follow-up Questions"
    | "Agent Action Items"
    | "Seller Action Items"
    | "Risks Requiring Review";
  lines: Array<{
    text: string;
    factId: string | null;
    transcriptSegmentId: string | null;
  }>;
}

export interface WalkthroughRecord {
  id: string;
  title: string;
  sourceType: "recording" | "upload";
  createdAt: string;
  updatedAt: string;
  audio: WalkthroughAudioRecord | null;
  transcript: WalkthroughTranscript;
  facts: ExtractedFact[];
  conflicts: ConflictFlag[];
  debrief: WalkthroughDebriefSection[];
  tasks: {
    agent: string[];
    seller: string[];
    openQuestions: string[];
    risks: string[];
  };
}

export interface WalkthroughSearchResult {
  transcriptMatches: TranscriptSegment[];
  factMatches: ExtractedFact[];
  relatedTasks: string[];
  relatedRisks: string[];
}

export interface TranscriptImportResult {
  providerId: string;
  text: string;
  segments: TranscriptSegment[];
  format: "txt" | "md" | "json";
  warnings: string[];
}

export type RecorderStatus = "idle" | "recording" | "paused" | "stopped" | "saving" | "error";
export type RecorderEvent = "start" | "pause" | "resume" | "stop" | "save" | "fail" | "reset";

const FACT_PATTERNS: Array<{ category: string; regex: RegExp; confidence: number }> = [
  { category: "Roof", regex: /roof[^.\n]*(replaced|installed|age|warranty|issue|leak|repair)[^.\n]*/gi, confidence: 0.9 },
  {
    category: "HVAC",
    regex: /(?:hvac|furnace|air\s*condition(?:er|ing)|ac\s*unit)[^.\n]*/gi,
    confidence: 0.88
  },
  { category: "Water Heater", regex: /water\s*heater[^.\n]*/gi, confidence: 0.84 },
  { category: "Windows and Doors", regex: /(windows?|doors?)[^.\n]*(new|updated|replaced|original|issue)?[^.\n]*/gi, confidence: 0.78 },
  { category: "Flooring", regex: /flooring|hardwood|tile|carpet|laminate|vinyl/gi, confidence: 0.76 },
  { category: "Kitchen Updates", regex: /kitchen[^.\n]*(updated|renovat|new|appliance|cabinet|counter)/gi, confidence: 0.8 },
  { category: "Bath Updates", regex: /(bath|bathroom|primary bath|ensuite)[^.\n]*(updated|renovat|new|vanity|tile|shower)/gi, confidence: 0.79 },
  { category: "Electrical Updates", regex: /electrical|panel|wiring|breaker/gi, confidence: 0.79 },
  { category: "Plumbing Updates", regex: /plumbing|pipes?|sewer|drain/gi, confidence: 0.79 },
  { category: "Appliances Included or Excluded", regex: /appliance|refrigerator|oven|range|microwave|dishwasher[^.\n]*/gi, confidence: 0.8 },
  { category: "Washer and Dryer Inclusion", regex: /washer|dryer/gi, confidence: 0.81 },
  { category: "HOA", regex: /hoa[^.\n]*/gi, confidence: 0.87 },
  { category: "Seller Desired List Price", regex: /(list|asking)\s*(price)?[^.\n]*\$?\d[\d,]*/gi, confidence: 0.91 },
  { category: "Price Range Discussed", regex: /\$\d[\d,]*(\s*(to|-)\s*\$?\d[\d,]*)?/gi, confidence: 0.86 },
  { category: "Seller Motivation", regex: /motivat(ed|ion)|relocat|downsizing|upsizing|job\s*change|divorce/gi, confidence: 0.74 },
  { category: "Desired Timing", regex: /(timeline|timing|days|weeks|month|close|closing|launch)[^.\n]*/gi, confidence: 0.77 },
  { category: "Possession or Occupancy Needs", regex: /possession|occupancy|rent\s*back|lease\s*back/gi, confidence: 0.84 },
  { category: "Improvements and Renovations", regex: /renovat|improv|remodel|updated|upgraded/gi, confidence: 0.76 },
  { category: "Known Defects or Repairs Needed", regex: /defect|repair|issue|problem|crack|damage/gi, confidence: 0.73 },
  { category: "Water Intrusion or Foundation Concerns", regex: /water\s*intrusion|flood|foundation|settling|basement\s*leak/gi, confidence: 0.88 },
  { category: "Permits and Warranties", regex: /permit|warranty|guarantee/gi, confidence: 0.76 },
  { category: "Utility Information", regex: /utility|gas|electric|water\s*bill|sewer|trash|internet/gi, confidence: 0.7 },
  { category: "Seller Priorities", regex: /seller\s*(priority|priorities)|most\s*important|must\s*have|non\s*negotiable/gi, confidence: 0.75 },
  { category: "Pets", regex: /pet|dog|cat|animal/gi, confidence: 0.69 },
  { category: "Showing Instructions", regex: /showing|show\s*instructions|lockbox|notice|appointment|occupant/gi, confidence: 0.79 },
  { category: "Closing Preferences", regex: /closing\s*(date|timing|preference)|close\s*by|possession\s*date|rent\s*back/gi, confidence: 0.82 },
  { category: "Schools or Neighborhood Comments", regex: /school|district|neighborhood|community|walkable|park/gi, confidence: 0.68 },
  { category: "Important Seller Features", regex: /important|favorite|best\s*feature|love/gi, confidence: 0.65 },
  { category: "Marketing Angles", regex: /marketing|angle|headline|highlight|story/gi, confidence: 0.66 },
  { category: "Follow-up Documents Promised", regex: /send|share|provide[^.\n]*(document|invoice|receipt|warranty|permit)/gi, confidence: 0.83 },
  { category: "Agent Tasks", regex: /i\s+(will|need\s*to|can)\s+[^.\n]*/gi, confidence: 0.71 },
  { category: "Seller Tasks", regex: /seller\s+(will|needs?\s*to)\s+[^.\n]*/gi, confidence: 0.73 },
  { category: "Open Questions", regex: /\?[^.\n]*|need\s*to\s*confirm|not\s*sure/gi, confidence: 0.64 },
  { category: "Potential Risks or Inconsistencies", regex: /risk|concern|conflict|inconsistent|verify/gi, confidence: 0.67 }
];

export function transitionRecorderState(current: RecorderStatus, event: RecorderEvent): RecorderStatus {
  if (event === "reset") {
    return "idle";
  }

  if (event === "fail") {
    return "error";
  }

  if (current === "idle" && event === "start") {
    return "recording";
  }

  if (current === "recording" && event === "pause") {
    return "paused";
  }

  if (current === "paused" && event === "resume") {
    return "recording";
  }

  if ((current === "recording" || current === "paused") && event === "stop") {
    return "stopped";
  }

  if (current === "stopped" && event === "save") {
    return "saving";
  }

  return current;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

function statusFromConfidence(confidence: number): FactStatus {
  if (confidence >= 0.82) {
    return "Confirmed";
  }
  if (confidence >= 0.58) {
    return "Needs Verification";
  }
  return "Uncertain";
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferTimestamp(segment: TranscriptSegment): number | null {
  if (typeof segment.startMs === "number") {
    return segment.startMs;
  }
  return null;
}

export function extractFactsFromTranscript(
  sourceWalkthroughId: string,
  transcriptText: string,
  segments: TranscriptSegment[]
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  for (const segment of segments) {
    const text = segment.text;
    for (const pattern of FACT_PATTERNS) {
      const matches = text.match(pattern.regex);
      if (!matches) {
        continue;
      }

      for (const match of matches) {
        const quote = cleanText(match);
        if (!quote) {
          continue;
        }

        const confidence = Math.min(0.98, pattern.confidence + (/[0-9$]/.test(quote) ? 0.06 : 0));
        facts.push({
          id: nextId("fact"),
          category: pattern.category,
          value: quote,
          quote: text,
          transcriptTimestampMs: inferTimestamp(segment),
          confidence,
          status: statusFromConfidence(confidence),
          decision: "pending",
          sourceWalkthroughId,
          sourceType: "transcript"
        });
      }
    }
  }

  if (facts.length === 0 && transcriptText.trim()) {
    facts.push({
      id: nextId("fact"),
      category: "Open Questions",
      value: "Transcript imported but no structured matches were detected automatically.",
      quote: transcriptText.slice(0, 200),
      transcriptTimestampMs: null,
      confidence: 0.45,
      status: "Uncertain",
      decision: "follow-up",
      sourceWalkthroughId,
      sourceType: "transcript"
    });
  }

  if (facts.length > 0) {
    const uncertainSignals = segments
      .map((segment) => segment.text)
      .filter((text) => /unknown|not\s*sure|need\s*to\s*confirm|follow\s*up|tbd/i.test(text));

    for (const line of uncertainSignals) {
      facts.push({
        id: nextId("fact"),
        category: "Open Questions",
        value: cleanText(line),
        quote: line,
        transcriptTimestampMs: null,
        confidence: 0.52,
        status: "Needs Verification",
        decision: "follow-up",
        sourceWalkthroughId,
        sourceType: "transcript"
      });
    }
  }

  return dedupeFacts(facts);
}

function dedupeFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const seen = new Set<string>();
  const deduped: ExtractedFact[] = [];

  for (const fact of facts) {
    const key = `${fact.category}|${fact.value.toLowerCase()}|${fact.quote.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(fact);
  }

  return deduped;
}

function groupFactsByDebriefSection(facts: ExtractedFact[]): Record<string, ExtractedFact[]> {
  const reliableFacts = facts.filter((fact) => fact.status !== "Uncertain" && fact.decision !== "rejected");

  const map: Record<string, ExtractedFact[]> = {
    "Executive Summary": reliableFacts.slice(0, 4),
    "Key Property Facts": reliableFacts.filter((fact) => ["Roof", "HVAC", "Water Heater", "Electrical Updates", "Plumbing Updates"].includes(fact.category)),
    "Seller Priorities": reliableFacts.filter((fact) => ["Important Seller Features", "Seller Motivation"].includes(fact.category)),
    "Pricing Discussion": reliableFacts.filter((fact) => ["Seller Desired List Price", "Price Range Discussed"].includes(fact.category)),
    "Timing and Possession": reliableFacts.filter((fact) => ["Desired Timing", "Possession or Occupancy Needs"].includes(fact.category)),
    "Included and Excluded Items": reliableFacts.filter((fact) => ["Appliances Included or Excluded", "Washer and Dryer Inclusion"].includes(fact.category)),
    Improvements: reliableFacts.filter((fact) => fact.category === "Improvements and Renovations"),
    "Known Concerns": reliableFacts.filter((fact) => ["Known Defects or Repairs Needed", "Water Intrusion or Foundation Concerns"].includes(fact.category)),
    "Marketing Opportunities": reliableFacts.filter((fact) => fact.category === "Marketing Angles"),
    "Follow-up Questions": facts.filter((fact) => fact.category === "Open Questions"),
    "Agent Action Items": reliableFacts.filter((fact) => fact.category === "Agent Tasks"),
    "Seller Action Items": reliableFacts.filter((fact) => fact.category === "Seller Tasks"),
    "Risks Requiring Review": facts.filter((fact) => fact.category === "Potential Risks or Inconsistencies" || fact.status === "Uncertain")
  };

  return map;
}

export function buildWalkthroughDebrief(facts: ExtractedFact[]): WalkthroughDebriefSection[] {
  const grouped = groupFactsByDebriefSection(facts);

  const titles: WalkthroughDebriefSection["title"][] = [
    "Executive Summary",
    "Key Property Facts",
    "Seller Priorities",
    "Pricing Discussion",
    "Timing and Possession",
    "Included and Excluded Items",
    "Improvements",
    "Known Concerns",
    "Marketing Opportunities",
    "Follow-up Questions",
    "Agent Action Items",
    "Seller Action Items",
    "Risks Requiring Review"
  ];

  return titles.map((title) => {
    const selected = grouped[title] ?? [];
    return {
      id: nextId("debrief"),
      title,
      lines:
        selected.length > 0
          ? selected.slice(0, 6).map((fact) => ({
              text: `${fact.value} (${Math.round(fact.confidence * 100)}% confidence, ${fact.status})`,
              factId: fact.id,
              transcriptSegmentId: null
            }))
          : [
              {
                text: "No items extracted yet.",
                factId: null,
                transcriptSegmentId: null
              }
            ]
    };
  });
}

function valueSignature(value: string): string {
  const year = value.match(/(19|20)\d{2}/)?.[0] ?? "";
  const money = value.match(/\$?\d[\d,]*/)?.[0] ?? "";
  const age = value.match(/\d+\s*(year|yr)/i)?.[0] ?? "";
  const includeTerm = /(include|included|exclude|excluded)/i.exec(value)?.[0] ?? "";
  return [year, money, age.toLowerCase(), includeTerm.toLowerCase()].filter(Boolean).join("|");
}

function canConflict(category: string): boolean {
  return [
    "Roof",
    "HVAC",
    "Water Heater",
    "Seller Desired List Price",
    "Price Range Discussed",
    "Appliances Included or Excluded",
    "Washer and Dryer Inclusion"
  ].includes(category);
}

export function detectFactConflicts(transcriptFacts: ExtractedFact[], otherFacts: ExtractedFact[]): ConflictFlag[] {
  const conflicts: ConflictFlag[] = [];

  for (const source of transcriptFacts) {
    if (!canConflict(source.category)) {
      continue;
    }
    const sourceSig = valueSignature(source.correctedValue ?? source.value);
    if (!sourceSig) {
      continue;
    }

    for (const other of otherFacts) {
      if (source.id === other.id || source.category !== other.category) {
        continue;
      }
      const otherSig = valueSignature(other.correctedValue ?? other.value);
      if (!otherSig || otherSig === sourceSig) {
        continue;
      }

      conflicts.push({
        id: nextId("conflict"),
        category: source.category,
        sourceFactId: source.id,
        conflictingFactId: other.id,
        message: `Possible conflict in ${source.category}: "${source.value}" vs "${other.value}"`,
        valueA: source.value,
        valueB: other.value
      });
    }
  }

  return dedupeConflicts(conflicts);
}

function dedupeConflicts(conflicts: ConflictFlag[]): ConflictFlag[] {
  const seen = new Set<string>();
  return conflicts.filter((item) => {
    const pair = [item.sourceFactId, item.conflictingFactId].sort().join("|");
    const key = `${item.category}|${pair}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function applyFactDecision(
  fact: ExtractedFact,
  decision: FactDecision,
  correctedValue?: string
): ExtractedFact {
  if (decision === "corrected" && correctedValue && correctedValue.trim()) {
    return {
      ...fact,
      decision,
      correctedValue: correctedValue.trim(),
      status: "Confirmed",
      confidence: Math.max(0.7, fact.confidence)
    };
  }

  if (decision === "confirmed") {
    return {
      ...fact,
      decision,
      status: "Confirmed",
      confidence: Math.max(0.75, fact.confidence)
    };
  }

  if (decision === "rejected") {
    return {
      ...fact,
      decision,
      status: "Uncertain",
      confidence: Math.min(0.4, fact.confidence)
    };
  }

  if (decision === "follow-up") {
    return {
      ...fact,
      decision,
      status: "Needs Verification",
      confidence: Math.min(0.65, fact.confidence)
    };
  }

  return {
    ...fact,
    decision
  };
}

export function createWalkthroughRecord(input: {
  title: string;
  sourceType: "recording" | "upload";
  providerId: string;
  transcriptText: string;
  transcriptSegments?: TranscriptSegment[];
  audio?: WalkthroughAudioRecord | null;
}): WalkthroughRecord {
  const id = nextId("walkthrough");
  const now = nowIso();
  const segments = input.transcriptSegments ?? splitTranscript(input.transcriptText);
  const transcript: WalkthroughTranscript = {
    providerId: input.providerId,
    originalText: input.transcriptText,
    editedText: input.transcriptText,
    segments,
    revisions: []
  };
  const facts = extractFactsFromTranscript(id, input.transcriptText, segments);
  const debrief = buildWalkthroughDebrief(facts);
  const tasks = buildTaskLists(facts);

  return {
    id,
    title: input.title,
    sourceType: input.sourceType,
    createdAt: now,
    updatedAt: now,
    audio: input.audio ?? null,
    transcript,
    facts,
    conflicts: [],
    debrief,
    tasks
  };
}

function buildTaskLists(facts: ExtractedFact[]): WalkthroughRecord["tasks"] {
  return {
    agent: facts.filter((fact) => fact.category === "Agent Tasks").map((fact) => fact.value),
    seller: facts.filter((fact) => fact.category === "Seller Tasks").map((fact) => fact.value),
    openQuestions: facts.filter((fact) => fact.category === "Open Questions").map((fact) => fact.value),
    risks: facts.filter((fact) => fact.category === "Potential Risks or Inconsistencies").map((fact) => fact.value)
  };
}

export function updateWalkthroughTranscript(
  walkthrough: WalkthroughRecord,
  nextText: string,
  editor = "Director"
): WalkthroughRecord {
  const cleaned = nextText.trim();
  if (!cleaned || cleaned === walkthrough.transcript.editedText) {
    return walkthrough;
  }

  const revision: TranscriptRevision = {
    at: nowIso(),
    editor,
    reason: "Manual transcript correction",
    previousText: walkthrough.transcript.editedText,
    nextText: cleaned
  };

  const segments = splitTranscript(cleaned);
  const facts = extractFactsFromTranscript(walkthrough.id, cleaned, segments);

  return {
    ...walkthrough,
    updatedAt: revision.at,
    transcript: {
      ...walkthrough.transcript,
      editedText: cleaned,
      segments,
      revisions: [revision, ...walkthrough.transcript.revisions]
    },
    facts,
    debrief: buildWalkthroughDebrief(facts),
    tasks: buildTaskLists(facts)
  };
}

export function applyFactDecisionToWalkthrough(
  walkthrough: WalkthroughRecord,
  factId: string,
  decision: FactDecision,
  correctedValue?: string
): WalkthroughRecord {
  const nextFacts = walkthrough.facts.map((fact) =>
    fact.id === factId ? applyFactDecision(fact, decision, correctedValue) : fact
  );

  return {
    ...walkthrough,
    updatedAt: nowIso(),
    facts: nextFacts,
    debrief: buildWalkthroughDebrief(nextFacts),
    tasks: buildTaskLists(nextFacts)
  };
}

export function addManualFact(
  walkthrough: WalkthroughRecord,
  fact: Pick<ExtractedFact, "category" | "value" | "quote" | "status">,
  sourceType: ExtractedFact["sourceType"] = "transcript"
): WalkthroughRecord {
  const nextFact: ExtractedFact = {
    id: nextId("fact"),
    category: fact.category,
    value: fact.value,
    quote: fact.quote,
    transcriptTimestampMs: null,
    confidence: fact.status === "Confirmed" ? 0.85 : fact.status === "Needs Verification" ? 0.65 : 0.45,
    status: fact.status,
    decision: "pending",
    sourceWalkthroughId: walkthrough.id,
    sourceType
  };

  const nextFacts = [nextFact, ...walkthrough.facts];
  return {
    ...walkthrough,
    updatedAt: nowIso(),
    facts: nextFacts,
    debrief: buildWalkthroughDebrief(nextFacts),
    tasks: buildTaskLists(nextFacts)
  };
}

export function searchWalkthrough(walkthrough: WalkthroughRecord, query: string): WalkthroughSearchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return {
      transcriptMatches: [],
      factMatches: [],
      relatedTasks: [],
      relatedRisks: []
    };
  }

  return {
    transcriptMatches: walkthrough.transcript.segments.filter((segment) => segment.text.toLowerCase().includes(needle)),
    factMatches: walkthrough.facts.filter(
      (fact) =>
        fact.category.toLowerCase().includes(needle) ||
        fact.value.toLowerCase().includes(needle) ||
        fact.quote.toLowerCase().includes(needle)
    ),
    relatedTasks: [...walkthrough.tasks.agent, ...walkthrough.tasks.seller, ...walkthrough.tasks.openQuestions].filter((item) =>
      item.toLowerCase().includes(needle)
    ),
    relatedRisks: walkthrough.tasks.risks.filter((item) => item.toLowerCase().includes(needle))
  };
}

export function parseTranscriptImport(fileName: string, contentType: string, textContent: string): TranscriptImportResult {
  const normalizedName = fileName.toLowerCase();
  const normalizedType = contentType.toLowerCase();

  if (normalizedType.includes("json") || normalizedName.endsWith(".json")) {
    return parseJsonTranscript(textContent);
  }

  if (normalizedType.includes("markdown") || normalizedName.endsWith(".md") || normalizedName.endsWith(".markdown")) {
    return {
      providerId: "uploaded-markdown",
      text: textContent,
      segments: splitTranscript(textContent),
      format: "md",
      warnings: []
    };
  }

  return {
    providerId: "uploaded-text",
    text: textContent,
    segments: splitTranscript(textContent),
    format: "txt",
    warnings: []
  };
}

function parseJsonTranscript(textContent: string): TranscriptImportResult {
  try {
    const parsed = JSON.parse(textContent) as unknown;

    if (Array.isArray(parsed)) {
      const segments = parsed
        .map((item, index) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const row = item as Record<string, unknown>;
          const text = typeof row.text === "string" ? row.text : "";
          if (!text) {
            return null;
          }
          const startMs = typeof row.startMs === "number" ? row.startMs : null;
          const endMs = typeof row.endMs === "number" ? row.endMs : null;
          return {
            id: `seg-${index + 1}`,
            text,
            startMs,
            endMs
          } satisfies TranscriptSegment;
        })
        .filter((item): item is TranscriptSegment => item !== null);

      const text = segments.map((item) => item.text).join(" ");
      return {
        providerId: "uploaded-json",
        text,
        segments,
        format: "json",
        warnings: []
      };
    }

    if (parsed && typeof parsed === "object") {
      const payload = parsed as Record<string, unknown>;
      const directText = typeof payload.transcript === "string" ? payload.transcript : typeof payload.text === "string" ? payload.text : "";

      if (Array.isArray(payload.segments)) {
        const segments = payload.segments
          .map((item, index) => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const row = item as Record<string, unknown>;
            const text = typeof row.text === "string" ? row.text : "";
            if (!text) {
              return null;
            }
            return {
              id: `seg-${index + 1}`,
              text,
              startMs: typeof row.startMs === "number" ? row.startMs : null,
              endMs: typeof row.endMs === "number" ? row.endMs : null
            } satisfies TranscriptSegment;
          })
          .filter((item): item is TranscriptSegment => item !== null);

        return {
          providerId: "uploaded-json",
          text: directText || segments.map((item) => item.text).join(" "),
          segments,
          format: "json",
          warnings: []
        };
      }

      if (directText) {
        return {
          providerId: "uploaded-json",
          text: directText,
          segments: splitTranscript(directText),
          format: "json",
          warnings: []
        };
      }
    }
  } catch {
    // fall through to fallback
  }

  return {
    providerId: "uploaded-json",
    text: textContent,
    segments: splitTranscript(textContent),
    format: "json",
    warnings: ["JSON transcript format was not recognized. Parsed as plain text."]
  };
}

export function formatTimestamp(ms: number | null): string {
  if (typeof ms !== "number" || ms < 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}
