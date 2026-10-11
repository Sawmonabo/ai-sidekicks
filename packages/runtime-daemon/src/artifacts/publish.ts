// Publishes an artifact from a payload its producer holds whole: the payload is decoded before it
// is hashed, so the digest and size bind the decoded bytes; it is written to a spool beside the
// ingest spools, moved into the content store, and its manifest and payload reference are written
// in one transaction, the manifest first.
//
// - A publish a client sends crosses into the daemon, so it passes the uploads' admission before
//   its payload is decoded, and its payload runs the ingest pipeline: the type recorded is read
//   from the bytes and the caller's is kept only for UTF-8 text. A file is refused outright, since
//   a file's bytes come in only through the ingest calls.
// - A publish the daemon makes itself never crossed that boundary: the producing code names the
//   type, and the manifest names no device.
// - A spool the store did not take is deleted; one a crash left behind is reaped with the ingest
//   spools once unwritten for long enough.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { ArtifactManifest } from "@ai-sidekicks/contracts/artifacts/manifest";
import type {
  ArtifactPublishRequest,
  ArtifactPublishResponse,
} from "@ai-sidekicks/contracts/artifacts/publication";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { withCleanupFailures } from "../cleanup-failures.js";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { DatabaseWriter } from "../database/writer.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { UploadAdmission } from "./admission.js";
import { mintArtifactId } from "./id.js";
import {
  prepareArtifactOwnerCheck,
  writePublishedManifest,
  type ArtifactOwnerCheck,
} from "./manifest-write.js";
import { formatContentHash, type PayloadStore } from "./payload-store.js";
import { FilePublishRefusedError } from "./refusals.js";
import type { IngestValidation } from "./validation.js";

/**
 * Where a publish came from: a client's request, made by the device the gateway stamped on it, or
 * the daemon's own code, which crossed no boundary.
 */
export type PublishOrigin =
  | { readonly kind: "request"; readonly deviceId: DeviceId }
  | { readonly kind: "daemon" };

/** What the publish service is built from. */
export interface ArtifactPublishServiceDeps {
  readonly database: DatabaseConnections;
  /** The pipeline a client's payload runs before anything of it is kept. */
  readonly validation: Pick<IngestValidation, "run">;
  /** The store a payload the daemon produced goes into directly. */
  readonly payloadStore: Pick<PayloadStore, "admit">;
  /** The admission a client's publish passes before its payload is decoded. */
  readonly admission: Pick<UploadAdmission, "admit" | "release">;
  /** Where a payload is spooled before the store takes it; on the store's volume. */
  readonly spoolDirectory: string;
  /** Wall clock in milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Publishes artifacts from whole payloads, a client's or the daemon's own. */
export class ArtifactPublishService {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #checkOwner: ArtifactOwnerCheck;
  readonly #validation: Pick<IngestValidation, "run">;
  readonly #payloadStore: Pick<PayloadStore, "admit">;
  readonly #admission: Pick<UploadAdmission, "admit" | "release">;
  readonly #spoolDirectory: string;
  readonly #now: () => number;

  constructor(deps: ArtifactPublishServiceDeps) {
    this.#writer = deps.database.writer;
    this.#checkOwner = prepareArtifactOwnerCheck(deps.database.reader);
    this.#validation = deps.validation;
    this.#payloadStore = deps.payloadStore;
    this.#admission = deps.admission;
    this.#spoolDirectory = deps.spoolDirectory;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Publishes `request`'s payload as a new artifact and answers its manifest, attributed to the
   * requesting device or to none for the daemon's own. Rejects with `session.not_found`, with
   * `run.not_found` for a run that is not the session's, with `artifact.file_publish_refused` for
   * a client's file, with the admission's refusals for a client's publish, and with
   * `artifact.type_unreadable` or `artifact.type_check_unavailable` when a client's payload's type
   * cannot be read; a refusal keeps nothing.
   */
  async publish(
    request: ArtifactPublishRequest,
    origin: PublishOrigin,
  ): Promise<ArtifactPublishResponse> {
    if (origin.kind === "request" && request.artifactType === "file") {
      throw new FilePublishRefusedError();
    }
    this.#checkOwner(request.sessionId, request.runId);
    const encoding = request.payloadEncoding ?? "utf8";
    // Counted from the encoded text, so nothing is decoded before the publish is admitted.
    const upload =
      origin.kind === "request"
        ? await this.#admission.admit(Buffer.byteLength(request.payload, encoding), undefined)
        : undefined;
    try {
      return await this.#publishAdmitted(request, origin);
    } finally {
      if (upload !== undefined) {
        this.#admission.release(upload);
      }
    }
  }

  // Decodes, spools and stores one publish that has passed admission, or needed none.
  async #publishAdmitted(
    request: ArtifactPublishRequest,
    origin: PublishOrigin,
  ): Promise<ArtifactPublishResponse> {
    const bytes = Buffer.from(request.payload, request.payloadEncoding ?? "utf8");
    const contentHash = formatContentHash(createHash("sha256").update(bytes).digest("hex"));
    const artifactId = mintArtifactId();
    const createdAt = new Date(this.#now()).toISOString();
    const recordManifest = (mediaType: string): Promise<ArtifactManifest> =>
      writePublishedManifest(this.#writer, {
        artifactId,
        sessionId: request.sessionId,
        runId: request.runId,
        createdBy: origin.kind === "request" ? origin.deviceId : undefined,
        artifactType: request.artifactType,
        contentHash,
        sizeBytes: bytes.length,
        mediaType,
        metadata: request.metadata ?? {},
        createdAt,
      });

    await mkdir(this.#spoolDirectory, { recursive: true, mode: 0o700 });
    const spoolPath = path.join(this.#spoolDirectory, mintUuidV7());
    try {
      await writeFile(spoolPath, bytes, { flag: "wx", mode: 0o600 });
      if (origin.kind === "daemon") {
        const manifest = await this.#payloadStore.admit(spoolPath, contentHash, () =>
          recordManifest(request.mediaType),
        );
        return { manifest };
      }
      const { recorded } = await this.#validation.run(
        { spoolPath, contentHash, declaredMediaType: request.mediaType },
        recordManifest,
      );
      return { manifest: recorded };
    } catch (error) {
      // Still there, whole or part-written, when the publish failed before the store took it.
      const cleanupFailures: unknown[] = [];
      await rm(spoolPath, { force: true }).catch((failure: unknown) => {
        cleanupFailures.push(failure);
      });
      throw withCleanupFailures(error, cleanupFailures, "publishing the artifact");
    }
  }
}
