// Files that reach the composer outside the open dialog: a file dropped on it and a picture pasted
// into it. Each comes back to the page as a token, so page code never holds a path. A dropped
// file's path is read by the preload from the dropped `File`; a pasted picture is written by main
// to a file in its own folder, readable only by the person, and removed when the page that pasted
// it goes.

import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FilePathRef } from "@shared/preload-api.js";
import type { MainDiagnosticLog } from "../../services/diagnostic-log.js";
import { isMissingPath } from "../../services/missing-path.js";
import type { FilePathRefOwner, FilePathRefs } from "../file-path/file-path-refs.js";

/** The prefix of every pasted picture's file name; the rest is a fresh id. */
const PASTED_IMAGE_FILE_PREFIX = "pasted-image-";

/**
 * A token for the file the preload read off a drop. Throws a `TypeError` when the path is not an
 * absolute path to a regular file: a `File` the page built itself has no path, and a folder is
 * never an attachment.
 */
export async function refForDroppedFile(
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  droppedPath: unknown,
): Promise<FilePathRef> {
  if (typeof droppedPath !== "string" || !path.isAbsolute(droppedPath)) {
    throw new TypeError("Only a file dropped from this computer can be attached.");
  }
  if (!(await stat(droppedPath)).isFile()) {
    throw new TypeError("A dropped folder cannot be attached; drop the files in it.");
  }
  return filePathRefs.mint(owner, droppedPath);
}

/** Where pasted pictures are written, and where a failed cleanup is recorded. */
export interface PastedImagesOptions {
  /** Main's own folder for pasted pictures, under the profile; created on the first paste. */
  readonly folder: string;
  readonly filePathRefs: FilePathRefs;
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly now: () => Date;
}

/**
 * The pictures pasted into the composer, each written to a file under main's own folder and kept
 * until the page that pasted it goes. The service copies a staged picture at staging time, so the
 * file is needed only while its token can still be sent.
 */
export class PastedImages {
  readonly #folder: string;
  readonly #filePathRefs: FilePathRefs;
  readonly #log: Pick<MainDiagnosticLog, "write">;
  readonly #now: () => Date;
  readonly #pathsByOwner = new Map<number, string[]>();
  #folderReady: Promise<void> | undefined;

  /** A file that cannot be removed when its page goes is recorded in `log`. */
  public constructor(options: PastedImagesOptions) {
    this.#folder = options.folder;
    this.#filePathRefs = options.filePathRefs;
    this.#log = options.log;
    this.#now = options.now;
  }

  /**
   * Write the pasted bytes to a new file only the person can read and answer its token. Throws a
   * `TypeError` for anything but non-empty bytes. No size bound is applied here: what is too large
   * is refused by the service's staging and by the provider, in their own words.
   */
  public async save(owner: FilePathRefOwner, bytes: unknown): Promise<FilePathRef> {
    if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) || bytes.byteLength === 0) {
      throw new TypeError("A pasted picture arrives as its bytes, and never empty.");
    }
    const data =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // A failed preparation is not kept, so the next paste tries again.
    this.#folderReady ??= this.#prepareFolder().catch((failure: unknown) => {
      this.#folderReady = undefined;
      throw failure;
    });
    await this.#folderReady;
    const filePath = path.join(this.#folder, `${PASTED_IMAGE_FILE_PREFIX}${randomUUID()}`);
    // `wx` refuses to follow or replace anything already at the path.
    await writeFile(filePath, data, { mode: 0o600, flag: "wx" });
    this.#pathsOf(owner).push(filePath);
    return this.#filePathRefs.mint(owner, filePath);
  }

  /**
   * Empty the folder once per run, since a token from an earlier run opens nothing, and make it
   * readable only by the person.
   */
  async #prepareFolder(): Promise<void> {
    await rm(this.#folder, { recursive: true, force: true });
    await mkdir(this.#folder, { recursive: true, mode: 0o700 });
  }

  #pathsOf(owner: FilePathRefOwner): string[] {
    const known = this.#pathsByOwner.get(owner.id);
    if (known !== undefined) {
      return known;
    }
    const paths: string[] = [];
    this.#pathsByOwner.set(owner.id, paths);
    owner.once("destroyed", () => {
      this.#pathsByOwner.delete(owner.id);
      for (const filePath of paths) {
        void this.#remove(filePath);
      }
    });
    return paths;
  }

  /** Remove one pasted picture; a file already gone is the outcome wanted. */
  async #remove(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (failure) {
      if (!isMissingPath(failure)) {
        this.#log.write({
          at: this.#now().toISOString(),
          level: "error",
          source: "main/bridge/native/file-intake",
          message: `A pasted picture could not be removed: ${String(failure)}`,
        });
      }
    }
  }
}
