// An artifact payload's bytes read as text. A reply carries the bytes as an attachment, so the read
// is one strict UTF-8 decode.

/**
 * A payload read as text, or that its bytes are not UTF-8. Bytes that are not UTF-8 are an answer,
 * not an error.
 */
export type ArtifactPayloadText =
  | { status: "text"; text: string }
  | { status: "opaque"; reason: "not-utf8" };

/**
 * Reads a payload's bytes as strict UTF-8, because the lenient decoder answers with replacement
 * characters a reader would draw as content.
 */
export function decodeArtifactPayloadText(payload: Uint8Array): ArtifactPayloadText {
  try {
    return { status: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(payload) };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}
