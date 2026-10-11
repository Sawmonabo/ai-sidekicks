// The content-addressed store of artifact payloads: a payload is kept once, under its SHA-256, and
// every manifest over the same bytes references that one copy. The key is the digest, so no
// caller's string is ever part of a stored path.
//
// Writing a payload and recording the reference to it run inside one exclusion per storage key, so
// a removal deciding whether any reference is left cannot interleave with a write that adds one.
// The bytes are flushed to disk and in place before the reference is recorded: a crash between
// leaves stored bytes nothing references, never a reference to missing bytes, and a record that
// fails takes back the bytes its own call moved in.

import { mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";

import { withCleanupFailures } from "../cleanup-failures.js";
import { CAN_FLUSH_FOLDER, flushPath } from "../disk-flush.js";
import { pathExists } from "../file/path-exists.js";
import { KeyedLock } from "../keyed-lock.js";

const CONTENT_HASH_ALGORITHM = "sha256";

/**
 * A payload's content hash, `sha256:<hex>`, from its SHA-256 in lowercase hex. It is the manifest's
 * digest and the payload's storage key.
 */
export function formatContentHash(sha256Hex: string): string {
  return `${CONTENT_HASH_ALGORITHM}:${sha256Hex}`;
}

/** The content-addressed payload store under one folder. */
export class PayloadStore {
  readonly #objectsDirectory: string;
  readonly #storageKeyLock = new KeyedLock<string>();

  /** `objectsDirectory` is created when the first payload is stored. */
  constructor(objectsDirectory: string) {
    this.#objectsDirectory = objectsDirectory;
  }

  /**
   * Stores the file at `sourcePath` under `contentHash`, moving it in place, or deleting it when
   * the same bytes are already stored, then runs `recordReference` while still holding the key, and
   * resolves with what it returns. `sourcePath` must be on the store's volume. Rejects with the
   * file system's error or `recordReference`'s; a failed record deletes the bytes this call moved
   * in, and bytes already stored before it stay for the references they have.
   */
  async admit<Recorded>(
    sourcePath: string,
    contentHash: string,
    recordReference: () => Promise<Recorded>,
  ): Promise<Recorded> {
    return this.#storageKeyLock.run(contentHash, async () => {
      const objectPath = this.#objectPathOf(contentHash);
      const isStored = await pathExists(objectPath);
      if (isStored) {
        await rm(sourcePath);
      } else {
        const objectFolder = path.dirname(objectPath);
        await flushPath(sourcePath);
        await mkdir(objectFolder, { recursive: true, mode: 0o700 });
        await rename(sourcePath, objectPath);
        if (CAN_FLUSH_FOLDER) {
          await flushPath(objectFolder);
        }
      }
      try {
        return await recordReference();
      } catch (error) {
        if (isStored) {
          throw error;
        }
        // Nothing can have referenced these bytes yet: every reference is recorded under this key.
        const cleanupFailures: unknown[] = [];
        await rm(objectPath, { force: true }).catch((failure: unknown) => {
          cleanupFailures.push(failure);
        });
        throw withCleanupFailures(error, cleanupFailures, "taking back the stored payload");
      }
    });
  }

  // `sha256/ab/abcd…`: the first two hex digits fan the payloads out over 256 folders.
  #objectPathOf(contentHash: string): string {
    const hex = contentHash.slice(CONTENT_HASH_ALGORITHM.length + 1);
    return path.join(this.#objectsDirectory, CONTENT_HASH_ALGORITHM, hex.slice(0, 2), hex);
  }
}
