// An artifact's whole payload through `artifact.read`: in one reply when it fits one message,
// else window by window at the version the first reply named. Windows are joined as bytes before
// any is read as text, because a window may end inside a character.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts/artifacts/ingest";
import {
  decodeArtifactPayloadText,
  type ArtifactPayloadText,
} from "@ai-sidekicks/contracts/artifacts/payload-decoding";
import type {
  ArtifactReadRequest,
  ArtifactReadResponse,
} from "@ai-sidekicks/contracts/artifacts/operations";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { refuse } from "#renderer/lib/refusal/contract.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";

/** One `artifact.read` call, made the way its caller makes calls. */
export type ArtifactReadCall = (
  request: ArtifactReadRequest,
) => Promise<DaemonReply<ArtifactReadResponse>>;

/** A whole payload read: the first reply, and its bytes read as text or that they are not text. */
export interface ArtifactPayloadRead {
  /** The first reply, whose manifest and version every window was read against. */
  readonly reply: ArtifactReadResponse;
  readonly content: ArtifactPayloadText;
}

/**
 * Read one artifact's whole payload. Answers the call's own refusal, or `payload-unreadable` when
 * a window comes back without its bytes or short of them. Bytes that are not UTF-8 are an answer,
 * on `content`.
 */
export async function readArtifactPayload(
  read: ArtifactReadCall,
  artifactId: ArtifactId,
): Promise<DaemonReply<ArtifactPayloadRead>> {
  const first = await read({ artifactId, payloadSelection: { kind: "whole" } });
  if (first.status === "refused") {
    return first;
  }
  const reply = first.value;
  if (reply.payload !== undefined) {
    return {
      status: "served",
      value: { reply, content: decodeArtifactPayloadText(reply.payload) },
    };
  }
  // Too large for one message: read it window by window, the version the first reply named.
  const size = reply.manifest.size;
  const joined = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += ARTIFACT_CHUNK_MAX_BYTES) {
    const length = Math.min(ARTIFACT_CHUNK_MAX_BYTES, size - offset);
    const windowReply = await read({
      artifactId,
      version: reply.versionNumber,
      payloadSelection: { kind: "range", offset, length },
    });
    if (windowReply.status === "refused") {
      return windowReply;
    }
    const bytes = windowReply.value.payload;
    if (bytes?.length !== length) {
      return unreadablePayload();
    }
    joined.set(bytes, offset);
  }
  return { status: "served", value: { reply, content: decodeArtifactPayloadText(joined) } };
}

function unreadablePayload(): DaemonReply<never> {
  return {
    status: "refused",
    refusal: refuse(
      "artifacts",
      "payload-unreadable",
      "This artifact's stored bytes could not be read whole.",
    ),
  };
}
