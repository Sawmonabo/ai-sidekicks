// What one artifact's payload fetch established, as the arm the pane draws. The bytes arrive as
// bytes and are read as strict UTF-8, never sniffed.

import type { ArtifactPayloadText } from "@ai-sidekicks/contracts/artifacts/payload-decoding";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

/**
 * What one artifact's payload fetch has established.
 *
 * The text arm carries the whole payload, and a payload that is not text is reported as such
 * rather than drawn as replacement characters. Before any fetch there is no reading at all.
 */
export type ArtifactPayloadReading =
  | { readonly status: "fetching"; readonly artifactId: ArtifactId }
  | {
      readonly status: "text";
      readonly artifactId: ArtifactId;
      /** The whole payload, never capped. */
      readonly text: string;
    }
  /** Bytes that are not text. Reported, never drawn. */
  | { readonly status: "opaque"; readonly artifactId: ArtifactId };

/**
 * How a payload fetch settled. `superseded` is a fetch whose answer changes nothing on screen
 * because the reader was disposed under it.
 */
export type ArtifactPayloadOutcome =
  | { readonly status: "settled"; readonly payload: ArtifactPayloadReading }
  | { readonly status: "superseded" };

/**
 * One whole payload's text, or that its bytes are not text, as the arm the pane draws. Bytes that
 * are not UTF-8 are an answer, not an error.
 */
export function artifactPayloadReadingFrom(
  artifactId: ArtifactId,
  content: ArtifactPayloadText,
): ArtifactPayloadReading {
  return content.status === "opaque"
    ? { status: "opaque", artifactId }
    : { status: "text", artifactId, text: content.text };
}
