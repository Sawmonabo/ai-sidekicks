// The artifact store's calls, the ingest calls and the publish, over a real database and a real
// store in a temporary folder, dispatched through the method registry as a client's calls are,
// with the disk's free room, the clock and the type detector in the test's hands, and what the
// store, the spool folder and the database hold.

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AttachmentIngestChunkResponse,
  AttachmentIngestCompleteResponse,
  AttachmentIngestInitResponse,
} from "@ai-sidekicks/contracts/artifacts/ingest";
import type {
  ArtifactPublishRequest,
  ArtifactPublishResponse,
} from "@ai-sidekicks/contracts/artifacts/publication";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { isMissingFileError } from "../../../file/missing-error.js";
import { registerArtifactIngestMethods } from "../../../ipc/handlers/artifact/ingest.js";
import { registerArtifactPublish } from "../../../ipc/handlers/artifact/publish.js";
import { MethodRegistryImpl } from "../../../ipc/registry.js";
import {
  mintSessionId,
  seedSessionRow,
} from "../../../session/directory/__fixtures__/directory-rows.js";
import { PayloadStore } from "../../payload-store.js";
import { ArtifactPublishService } from "../../publish.js";
import { MAX_INGEST_STREAM_LIFETIME_MS } from "../limits.js";
import { AttachmentIngestService } from "../service.js";
import type { MediaTypeDetector } from "../detection/thread.js";
import { IngestValidation } from "../validation.js";

/** The device every call comes from. */
export const CALLING_DEVICE_ID = "device-laptop" as DeviceId;

/** The first bytes of a PNG file: enough for its type to be read. */
export const PNG_SIGNATURE: Uint8Array = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** What a harness is opened with; each defaults to a roomy disk and the real detector. */
export interface IngestHarnessOptions {
  /** The disk's free room, in bytes, read at each opening. */
  readonly readVolumeFreeBytes?: () => Promise<number>;
  readonly detectMediaType?: MediaTypeDetector;
}

/** An open harness: the calls, the clock, and what the store and the database hold. */
export interface IngestHarness {
  readonly sessionId: SessionId;
  readonly service: AttachmentIngestService;
  /** The publish service, for a publish the daemon makes itself. */
  readonly publisher: ArtifactPublishService;
  readonly spoolDirectory: string;
  /** How many times a completion has run the pipeline. */
  readonly pipelineRunCount: () => number;
  /** Moves the clock past a stream's lifetime, counted from when the harness opened. */
  readonly passLifetime: () => void;
  readonly init: (
    declaredSizeBytes: number,
    fileName?: string,
    mediaType?: string,
  ) => Promise<AttachmentIngestInitResponse>;
  readonly chunk: (
    ingestId: string,
    sequenceNumber: number,
    bytes: Uint8Array,
  ) => Promise<AttachmentIngestChunkResponse>;
  readonly complete: (ingestId: string) => Promise<AttachmentIngestCompleteResponse>;
  /** Publishes as a client does, in the harness's session unless `request` names another. */
  readonly publish: (
    request: Omit<ArtifactPublishRequest, "sessionId"> & { readonly sessionId?: SessionId },
  ) => Promise<ArtifactPublishResponse>;
  /** The names of the files in the spool folder. */
  readonly spoolNames: () => Promise<string[]>;
  /** Opens a stream for `bytes`, sends them in one chunk and completes it. */
  readonly ingest: (
    bytes: Uint8Array,
    fileName?: string,
  ) => Promise<AttachmentIngestCompleteResponse>;
  /** The stored payload files, as paths under the store's folder. */
  readonly storedPayloads: () => Promise<string[]>;
  /** The bytes a stream has spooled, or `undefined` once its spool is gone. */
  readonly spooledBytes: (ingestId: string) => Promise<Buffer | undefined>;
  readonly manifestRows: () => ManifestRow[];
  readonly payloadRefRows: () => PayloadRefRow[];
  readonly close: () => Promise<void>;
}

/** One `artifact_manifests` row. */
interface ManifestRow {
  readonly id: string;
  readonly session_id: string;
  readonly created_by: string | null;
  readonly artifact_type: string;
  readonly state: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly metadata: string;
}

/** One `artifact_payload_refs` row. */
interface PayloadRefRow {
  readonly manifest_id: string;
  readonly storage_path: string;
  readonly media_type: string;
  readonly size_bytes: number;
}

/** `sha256:<hex>` of `bytes`, as the store keys them. */
export function contentHashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Opens a harness over a fresh database holding one session, and a fresh store. */
export async function openIngestHarness(
  options: IngestHarnessOptions = {},
): Promise<IngestHarness> {
  const scratch: ScratchDatabase = await openScratchDatabase();
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), "aisk-artifacts-"));
  const objectsDirectory = path.join(storeDirectory, "objects");
  const spoolDirectory = path.join(storeDirectory, "spool");
  const sessionId = mintSessionId();
  await seedSessionRow(scratch.writer, sessionId, "chat");

  const openedAt = Date.now();
  let nowMs = openedAt;
  let pipelineRuns = 0;
  const payloadStore = new PayloadStore(objectsDirectory);
  const validation = new IngestValidation({
    payloadStore,
    ...(options.detectMediaType === undefined ? {} : { detectMediaType: options.detectMediaType }),
  });
  const service = new AttachmentIngestService({
    database: scratch,
    validation: {
      run: (payload, recordReference) => {
        pipelineRuns += 1;
        return validation.run(payload, recordReference);
      },
    },
    spoolDirectory,
    readVolumeFreeBytes: options.readVolumeFreeBytes ?? (() => Promise.resolve(2 ** 40)),
    now: () => nowMs,
  });
  const publisher = new ArtifactPublishService({
    database: scratch,
    validation,
    payloadStore,
    spoolDirectory,
    now: () => nowMs,
  });
  const registry = new MethodRegistryImpl();
  registerArtifactIngestMethods(registry, service);
  registerArtifactPublish(registry, publisher);
  const context = { deviceId: CALLING_DEVICE_ID };

  const init: IngestHarness["init"] = async (
    declaredSizeBytes,
    fileName = "notes.bin",
    mediaType,
  ) =>
    (await registry.dispatch(
      "artifact.ingestInit",
      {
        sessionId,
        fileName,
        declaredSizeBytes,
        ...(mediaType === undefined ? {} : { mediaType }),
      },
      context,
    )) as AttachmentIngestInitResponse;
  const chunk: IngestHarness["chunk"] = async (ingestId, sequenceNumber, bytes) =>
    (await registry.dispatch(
      "artifact.ingestChunk",
      { ingestId, sequenceNumber, chunk: Buffer.from(bytes).toString("base64") },
      context,
    )) as AttachmentIngestChunkResponse;
  const complete: IngestHarness["complete"] = async (ingestId) =>
    (await registry.dispatch(
      "artifact.ingestComplete",
      { ingestId },
      context,
    )) as AttachmentIngestCompleteResponse;

  return {
    sessionId,
    service,
    publisher,
    spoolDirectory,
    pipelineRunCount: () => pipelineRuns,
    passLifetime: () => {
      nowMs = openedAt + MAX_INGEST_STREAM_LIFETIME_MS + 1;
    },
    init,
    chunk,
    complete,
    publish: async (request) =>
      (await registry.dispatch(
        "artifact.publish",
        { sessionId, ...request },
        context,
      )) as ArtifactPublishResponse,
    spoolNames: async () => {
      try {
        return await readdir(spoolDirectory);
      } catch (error) {
        if (isMissingFileError(error)) {
          return [];
        }
        throw error;
      }
    },
    ingest: async (bytes, fileName) => {
      const { ingestId } = await init(bytes.length, fileName);
      await chunk(ingestId, 0, bytes);
      return complete(ingestId);
    },
    storedPayloads: async () => {
      try {
        const entries = await readdir(objectsDirectory, { recursive: true, withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => path.relative(objectsDirectory, path.join(entry.parentPath, entry.name)));
      } catch (error) {
        if (isMissingFileError(error)) {
          return [];
        }
        throw error;
      }
    },
    spooledBytes: async (ingestId) => {
      try {
        return await readFile(path.join(spoolDirectory, ingestId));
      } catch (error) {
        if (isMissingFileError(error)) {
          return undefined;
        }
        throw error;
      }
    },
    manifestRows: () =>
      scratch.reader
        .prepare(
          `SELECT id, session_id, created_by, artifact_type, state, content_hash, size_bytes,
                  metadata
           FROM artifact_manifests ORDER BY id`,
        )
        .all() as ManifestRow[],
    payloadRefRows: () =>
      scratch.reader
        .prepare(
          `SELECT manifest_id, storage_path, media_type, size_bytes
           FROM artifact_payload_refs ORDER BY manifest_id`,
        )
        .all() as PayloadRefRow[],
    close: async () => {
      await scratch.close();
      await rm(storeDirectory, { recursive: true, force: true });
    },
  };
}
