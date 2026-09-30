// What a served payload reply is, as the arm the pane draws.
//
// It reaches neither the port nor the wire: it takes one served reply and answers with
// the arm the pane draws. The bytes are read by the contract's decoder, which switches
// on the reply's own encoding and never sniffs.

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
 * `ArtifactReadResponse` is a union: the deferred arm hands back a content-addressed key and
 * no bytes, the inline arm hands back the bytes with the encoding to read them by. Both
 * are served answers the pane has to draw. The inline arm splits on whether the bytes
 * are text: a payload that decodes is drawn whole, and one that does not is reported as
 * what it is rather than drawn as replacement characters.
 *
 * Before anyone asks there is no reading at all, which is why `ArtifactListReading.payload`
 * is absent rather than one more arm here.
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
 * How a payload fetch settled, with the arm it reached on the one that served.
 *
 * `superseded` is a fetch whose answer changed nothing on screen and never will: the
 * reader was disposed under it.
 */
export type ArtifactPayloadOutcome =
  | { readonly status: "settled"; readonly payload: ArtifactPayloadReading }
  | { readonly status: "superseded" };

/**
 * Read one served payload reply as the arm the pane draws.
 *
 * The reply's own `payloadEncoding` decides the arm: it is present exactly when
 * `payload` is. A decode that fails is an answer, not an error: base64 that will not
 * decode and bytes that are not UTF-8 both land on `opaque` with the reason named.
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
