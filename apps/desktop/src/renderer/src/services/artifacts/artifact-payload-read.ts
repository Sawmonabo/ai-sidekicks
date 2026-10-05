// An artifact's whole payload through `artifact.read`: in one reply when it fits one message,
// else window by window at the version the first reply named. Windows are joined as bytes before
// any is read as text, because a window may end inside a character.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts/artifacts/ingest";
import {
  decodeArtifactPayloadBytes,
  decodeArtifactPayloadText,
  type ArtifactPayloadEncoding,
  type ArtifactPayloadText,
  type ArtifactReadRequest,
  type ArtifactReadResponse,
} from "@ai-sidekicks/contracts/artifacts/operations";
import type { ArtifactId } from "@ai-sidekicks/contracts/provider/driver/driver";

import { refuse } from "@renderer/lib/refusal/refusal.js";
import type { DaemonReply } from "@renderer/services/daemon/daemon-reply.js";

/** One `artifact.read` call, made the way its caller makes calls. */
export type ArtifactReadCall = (
  request: ArtifactReadRequest,
) => Promise<DaemonReply<ArtifactReadResponse>>;

/** A whole payload read: the first reply, and its bytes read as text or why they are not text. */
export interface ArtifactPayloadRead {
  /** The first reply, whose manifest and version every window was read against. */
  readonly reply: ArtifactReadResponse;
  /** The encoding the bytes were declared in: the one reply's, or the last window's read. */
  readonly encoding: ArtifactPayloadEncoding;
  readonly content: ArtifactPayloadText;
}

/**
 * Read one artifact's whole payload. Answers the call's own refusal, or
 * `artifacts.payload_unreadable` when a window comes back without its bytes or short of them.
 * Base64 that will not decode and bytes that are not UTF-8 are answers, on `content`.
 */
export async function readArtifactPayload(
  read: ArtifactReadCall,
  artifactId: ArtifactId,
): Promise<DaemonReply<ArtifactPayloadRead>> {
  const first = await read({ artifactId, includePayload: true });
  if (first.status === "refused") {
    return first;
  }
  const reply = first.value;
  if (reply.payloadEncoding !== undefined) {
    const content = decodeArtifactPayloadText(reply.payload, reply.payloadEncoding);
    return { status: "served", value: { reply, encoding: reply.payloadEncoding, content } };
  }
  // Too large for one message: read it window by window, the version the first reply named.
  const size = reply.manifest.size;
  const joined = new Uint8Array(size);
  // Replaced by the first window: a payload that did not fit one message spans at least one.
  let encoding: ArtifactPayloadEncoding = "base64";
  for (let offset = 0; offset < size; offset += ARTIFACT_CHUNK_MAX_BYTES) {
    const length = Math.min(ARTIFACT_CHUNK_MAX_BYTES, size - offset);
    const windowReply = await read({
      artifactId,
      version: reply.versionNumber,
      includePayload: true,
      range: { offset, length },
    });
    if (windowReply.status === "refused") {
      return windowReply;
    }
    if (windowReply.value.payloadEncoding === undefined) {
      return unreadablePayload();
    }
    encoding = windowReply.value.payloadEncoding;
    const bytes = decodeArtifactPayloadBytes(windowReply.value.payload, encoding);
    if (bytes === undefined) {
      const content: ArtifactPayloadText = { status: "opaque", reason: "undecodable" };
      return { status: "served", value: { reply, encoding, content } };
    }
    if (bytes.length !== length) {
      return unreadablePayload();
    }
    joined.set(bytes, offset);
  }
  return { status: "served", value: { reply, encoding, content: joinedText(joined) } };
}

/** Joined bytes read as strict UTF-8, since the lenient decoder draws replacement characters. */
function joinedText(bytes: Uint8Array): ArtifactPayloadText {
  try {
    return { status: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}

function unreadablePayload(): DaemonReply<never> {
  return {
    status: "refused",
    refusal: refuse(
      "artifacts",
      "artifacts.payload_unreadable",
      "This artifact's stored bytes could not be read whole.",
    ),
  };
}
