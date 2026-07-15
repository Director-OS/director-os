export interface TranscriptSegment {
  id: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

export interface TranscriptionResult {
  providerId: string;
  text: string;
  segments: TranscriptSegment[];
  warnings: string[];
}

export interface TranscriptionRequest {
  audioBlob: Blob;
  fileName?: string;
  language?: string;
}

export interface TranscriptionProvider {
  id: string;
  label: string;
  description: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export class MockLocalTranscriptionProvider implements TranscriptionProvider {
  id = "mock-local";
  label = "Mock Local";
  description = "Deterministic local transcript generator for testing workflows without API keys.";

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const fileLabel = request.fileName ?? "recording";
    const baseText = [
      `Walkthrough import received from ${fileLabel}.`,
      "Seller said the roof was replaced in 2019 and HVAC in 2022 with a transferable warranty.",
      "Seller would like to list around 525000 and move within 45 days after close.",
      "HOA is 95 dollars monthly and buyer should verify short-term rental rules."
    ].join(" ");

    return Promise.resolve({
      providerId: this.id,
      text: baseText,
      segments: splitTranscript(baseText),
      warnings: ["Mock transcript used. Verify details before publishing."]
    });
  }
}

export class UploadedTextPassthroughProvider implements TranscriptionProvider {
  id = "uploaded-text";
  label = "Uploaded Transcript";
  description = "Uses uploaded transcript text exactly as provided.";

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const text = await request.audioBlob.text();
    return {
      providerId: this.id,
      text,
      segments: splitTranscript(text),
      warnings: []
    };
  }
}

export function createTranscriptionProviders(): TranscriptionProvider[] {
  return [new MockLocalTranscriptionProvider(), new UploadedTextPassthroughProvider()];
}

export function getTranscriptionProvider(providerId: string): TranscriptionProvider {
  const provider = createTranscriptionProviders().find((item) => item.id === providerId);
  return provider ?? new MockLocalTranscriptionProvider();
}

export interface FutureTranscriptionAdapterSpec {
  id: string;
  inputFormats: string[];
  authModel: "api-key" | "oauth" | "none";
  notes: string;
}

export const FUTURE_TRANSCRIPTION_ADAPTERS: FutureTranscriptionAdapterSpec[] = [
  {
    id: "openai-transcription",
    inputFormats: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm"],
    authModel: "api-key",
    notes: "Future adapter target for OpenAI transcription APIs."
  },
  {
    id: "bee-export-import",
    inputFormats: ["text/plain", "text/markdown", "application/json", "audio/*"],
    authModel: "none",
    notes: "Future adapter target for Bee export file parsing or supported API integration."
  }
];

export function splitTranscript(text: string): TranscriptSegment[] {
  const cleaned = text.trim();
  if (!cleaned) {
    return [];
  }

  const chunks = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return chunks.map((chunk, index) => {
    const startMs = index * 15000;
    return {
      id: `seg-${index + 1}`,
      text: chunk,
      startMs,
      endMs: startMs + 14000
    };
  });
}
