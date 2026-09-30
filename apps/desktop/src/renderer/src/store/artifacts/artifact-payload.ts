// Reads one served payload reply as the arm the pane draws. The contract's decoder reads the
// bytes by the reply's own encoding and never sniffs.

import {
  decodeArtifactPayloadText,
  type ArtifactId,
  type ArtifactPayloadEncoding,
  type ArtifactPayloadText,
  type ArtifactReadResponse,
} from "@ai-sidekicks/contracts";

/**
 * What one artifact's payload fetch has established.
 *
 * The deferred arm carries a content-addressed key and no bytes; the inline arm carries bytes
 * plus the encoding to read them by, and a payload that is not text is reported as such rather
 * than drawn as replacement characters. Before any fetch there is no reading at all.
 */
export type ArtifactPayloadReading =
  | { readonly status: "fetching"; readonly artifactId: ArtifactId }
  /** The content-addressed key the bytes are stored under, and no bytes. */
  | { readonly status: "deferred"; readonly artifactId: ArtifactId; readonly payloadHandle: string }
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
 * Reads one served payload reply as the arm the pane draws.
 *
 * The reply's `payloadEncoding` decides the arm; it is present exactly when `payload` is. A
 * failed decode is an answer, not an error: it lands on `opaque` with the reason named.
 */
export function artifactPayloadReadingFrom(
  artifactId: ArtifactId,
  read: ArtifactReadResponse,
): ArtifactPayloadReading {
  if (read.payloadEncoding === undefined) {
    return { status: "deferred", artifactId, payloadHandle: read.payloadHandle };
  }
  const encoding = read.payloadEncoding;
  const decoded = decodeArtifactPayloadText(read.payload, encoding);
  if (decoded.status === "opaque") {
    return { status: "opaque", artifactId, encoding, reason: decoded.reason };
  }
  return { status: "text", artifactId, encoding, text: decoded.text };
}
