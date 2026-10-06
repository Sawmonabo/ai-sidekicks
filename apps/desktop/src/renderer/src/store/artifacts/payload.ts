// What one artifact's payload fetch established, as the arm the pane draws. The bytes were read by
// the encoding each reply declared, never sniffed.

import type {
  ArtifactPayloadEncoding,
  ArtifactPayloadText,
} from "@ai-sidekicks/contracts/artifacts/operations";
import type { ArtifactId } from "@ai-sidekicks/contracts/provider/driver/intervention";

/**
 * What one artifact's payload fetch has established.
 *
 * The text arm carries the whole payload plus the encoding it was read by, and a payload that is
 * not text is reported as such rather than drawn as replacement characters. Before any fetch
 * there is no reading at all.
 */
export type ArtifactPayloadReading =
  | { readonly status: "fetching"; readonly artifactId: ArtifactId }
  | {
      readonly status: "text";
      readonly artifactId: ArtifactId;
      readonly encoding: ArtifactPayloadEncoding;
      /** The whole payload, never capped. */
      readonly text: string;
    }
  /** Bytes that are not text. Reported, never drawn. */
  | {
      readonly status: "opaque";
      readonly artifactId: ArtifactId;
      readonly encoding: ArtifactPayloadEncoding;
      readonly reason: Extract<ArtifactPayloadText, { status: "opaque" }>["reason"];
    };

/**
 * How a payload fetch settled. `superseded` is a fetch whose answer changes nothing on screen
 * because the reader was disposed under it.
 */
export type ArtifactPayloadOutcome =
  | { readonly status: "settled"; readonly payload: ArtifactPayloadReading }
  | { readonly status: "superseded" };

/**
 * Reads one whole payload, decoded by the encoding its replies declared, as the arm the pane
 * draws. A failed decode is an answer, not an error: it lands on `opaque` with the reason named.
 */
export function artifactPayloadReadingFrom(
  artifactId: ArtifactId,
  encoding: ArtifactPayloadEncoding,
  content: ArtifactPayloadText,
): ArtifactPayloadReading {
  if (content.status === "opaque") {
    return { status: "opaque", artifactId, encoding, reason: content.reason };
  }
  return { status: "text", artifactId, encoding, text: content.text };
}
