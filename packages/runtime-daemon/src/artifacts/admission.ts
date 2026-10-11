// The one admission every upload a client sends passes before a byte of it is spooled: an ingest
// stream at its opening and a publish before its payload is decoded. Admissions run one at a time
// against the bound on open uploads and the disk's free room, read at each admission, less what
// the open uploads have yet to write. A release only lowers those totals, so one landing during an
// admission only makes it more careful.

import { mkdir } from "node:fs/promises";

import { KeyedLock } from "../keyed-lock.js";
import { MAX_ACTIVE_INGEST_STREAMS } from "./ingest/limits.js";
import { ArtifactTooLargeError, IngestCapacityExhaustedError } from "./refusals.js";

// The one key of the admission ledger's exclusion.
const LEDGER_KEY = "admission";

/** One admitted upload: its place among the open uploads and the room it has yet to write. */
export interface AdmittedUpload {
  /** The declared bytes not yet written to its spool; a stream lowers it as chunks land. */
  remainingBytes: number;
}

/** What the admission reads the disk with. */
export interface UploadAdmissionDeps {
  /** Where the spools are written; created at the first admission. */
  readonly spoolDirectory: string;
  /** The free bytes on the volume holding a folder. */
  readonly readVolumeFreeBytes: (folderPath: string) => Promise<number>;
}

/** The admission ledger over every open upload a client sent. */
export class UploadAdmission {
  readonly #spoolDirectory: string;
  readonly #readVolumeFreeBytes: (folderPath: string) => Promise<number>;
  readonly #ledger = new KeyedLock<string>();
  readonly #openUploads = new Set<AdmittedUpload>();

  constructor(deps: UploadAdmissionDeps) {
    this.#spoolDirectory = deps.spoolDirectory;
    this.#readVolumeFreeBytes = deps.readVolumeFreeBytes;
  }

  /**
   * Admits an upload of `declaredSizeBytes`, reserving that room until {@link release}. Rejects
   * with `artifact.too_large` when the disk could not hold it with no other upload open, naming
   * `fileName` when there is one, and with `artifact.ingest_capacity_exhausted` at the bound on
   * open uploads or when the disk has no room for it beside theirs; a refusal admits nothing.
   */
  admit(declaredSizeBytes: number, fileName: string | undefined): Promise<AdmittedUpload> {
    return this.#ledger.run(LEDGER_KEY, async () => {
      await mkdir(this.#spoolDirectory, { recursive: true, mode: 0o700 });
      const availableBytes = await this.#readVolumeFreeBytes(this.#spoolDirectory);
      if (declaredSizeBytes > availableBytes) {
        throw new ArtifactTooLargeError(fileName, { availableBytes });
      }
      let reservedBytes = 0;
      for (const upload of this.#openUploads) {
        reservedBytes += upload.remainingBytes;
      }
      if (
        this.#openUploads.size >= MAX_ACTIVE_INGEST_STREAMS ||
        declaredSizeBytes > availableBytes - reservedBytes
      ) {
        throw new IngestCapacityExhaustedError();
      }
      const upload: AdmittedUpload = { remainingBytes: declaredSizeBytes };
      this.#openUploads.add(upload);
      return upload;
    });
  }

  /** Gives back an upload's place and the room it still held; releasing twice is a no-op. */
  release(upload: AdmittedUpload): void {
    this.#openUploads.delete(upload);
  }

  /** Runs `work` while no admission runs, for a pass that must see the uploads hold still. */
  whileNoneAdmits<T>(work: () => Promise<T>): Promise<T> {
    return this.#ledger.run(LEDGER_KEY, work);
  }
}
