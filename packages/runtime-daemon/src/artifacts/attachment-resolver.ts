// Binds each attachment a message carries to the stored copy its manifest names, in the order the
// sender staged them. An attachment that can no longer be bound keeps its place as an unresolved
// marker naming why, so the list never shortens and the recipient reads which file is missing.
//
// Every id is canonicalized before the lookup: the id schema accepts any hex case, while the
// manifest's key compares bytes exactly, so a literal lookup of an uppercase spelling would mark a
// manifest that exists as missing.

import type { Database, Statement } from "better-sqlite3";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { AttachmentResolver, ProviderAttachment } from "../provider/driver/attachments.js";
import type { PayloadStore } from "./payload-store.js";

interface PayloadRow {
  readonly contentHash: string;
  readonly mediaType: string;
  readonly fileName: unknown;
}

// The manifest's newest payload reference within the message's session; a manifest whose payload
// was reclaimed has none.
const SELECT_PAYLOAD_SQL = `SELECT refs.storage_path AS contentHash, refs.media_type AS mediaType,
       json_extract(manifests.metadata, '$.fileName') AS fileName
  FROM artifact_manifests AS manifests
  JOIN artifact_payload_refs AS refs ON refs.manifest_id = manifests.id
  WHERE manifests.id = @artifact_id AND manifests.session_id = @session_id
  ORDER BY refs.created_at DESC, refs.id DESC
  LIMIT 1`;

/** Resolves a message's attachments against the session's manifests and the payload store. */
export class ArtifactAttachmentResolver implements AttachmentResolver {
  readonly #selectPayload: Statement<{ artifact_id: string; session_id: string }, PayloadRow>;
  readonly #payloads: Pick<PayloadStore, "objectPathOf">;

  /** `reader` is the daemon's read-only connection. */
  constructor(reader: Database, payloads: Pick<PayloadStore, "objectPathOf">) {
    this.#selectPayload = reader.prepare(SELECT_PAYLOAD_SQL);
    this.#payloads = payloads;
  }

  /**
   * Each of `artifactIds` in its own position: bound to its stored copy, named as it was sent or
   * by its id where its manifest records no name, or, where the session holds no manifest or no
   * payload for it, the unresolved marker with the cause `deleted`.
   */
  resolveAttachments(
    sessionId: SessionId,
    artifactIds: readonly ArtifactId[],
  ): Promise<ProviderAttachment[]> {
    return Promise.resolve(
      artifactIds.map((artifactId): ProviderAttachment => {
        const canonicalId = canonicalizeUuid(artifactId);
        const row = this.#selectPayload.get({
          artifact_id: canonicalId,
          session_id: canonicalizeUuid(sessionId),
        });
        if (row === undefined) {
          return { kind: "unresolved", artifactId, cause: "deleted" };
        }
        return {
          kind: "resolved",
          artifactId: canonicalId,
          path: this.#payloads.objectPathOf(row.contentHash),
          fileName: typeof row.fileName === "string" ? row.fileName : canonicalId,
          mediaType: row.mediaType,
        };
      }),
    );
  }
}
