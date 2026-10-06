// Files that reach the composer outside the open dialog: a file dropped on it and a picture pasted
// into it. Each comes back to the page as a token, so page code never holds a path. A dropped
// file's path is read by the preload from the dropped `File`; a pasted picture is written by main
// to a file in its own folder, readable only by the person, and removed when the document that
// pasted it is replaced or goes. The folder is emptied at each start, so a picture a quit left
// behind lasts no longer than the next start.

import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FilePathRef } from "#shared/preload-api.js";
import type { MainDiagnosticLog } from "../../services/diagnostic-log.js";
import { isMissingPath } from "../../services/missing-path.js";
import type { FilePathRefOwner, FilePathRefs } from "../file-path/refs.js";

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
  return filePathRefs.mint(owner, "attach", droppedPath);
}

/** Where pasted pictures are written, and where a failed cleanup is recorded. */
export interface PastedImagesOptions {
  /** Main's own folder for pasted pictures, under the profile; emptied at construction. */
  readonly folder: string;
  readonly filePathRefs: FilePathRefs;
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly now: () => Date;
}

/**
 * The pictures pasted into the composer, each written to a file under main's own folder and kept
 * while the document that pasted it is loaded. The service copies a staged picture at staging
 * time, so the file is needed only while its token can still be sent.
 */
export class PastedImages {
  readonly #folder: string;
  readonly #filePathRefs: FilePathRefs;
  readonly #log: Pick<MainDiagnosticLog, "write">;
  readonly #now: () => Date;
  readonly #pathsByOwner = new Map<number, string[]>();
  /** The folder emptied and made at construction; a failed one is made again at the next paste. */
  #folderReady: Promise<void> | undefined;

  /**
   * Empties the folder at once, as an earlier run's pictures open nothing now; a failure there,
   * and a file that cannot be removed when its page goes, is recorded in `log`.
   */
  public constructor(options: PastedImagesOptions) {
    this.#folder = options.folder;
    this.#filePathRefs = options.filePathRefs;
    this.#log = options.log;
    this.#now = options.now;
    this.#folderReady = this.#prepareFolder().catch((failure: unknown) => {
      this.#folderReady = undefined;
      this.#record(`The pasted pictures' folder could not be emptied: ${String(failure)}`);
    });
  }

  /**
   * Write the pasted bytes to a new file only the person can read and answer its token. Throws a
   * `TypeError` for anything but a non-empty `ArrayBuffer`, and an `Error` when the page went
   * before the picture was kept. No size bound is applied here: what is too large is refused by
   * the service's staging and by the provider, in their own words.
   */
  public async save(owner: FilePathRefOwner, bytes: unknown): Promise<FilePathRef> {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      throw new TypeError("A pasted picture arrives as its bytes, and never empty.");
    }
    // A failed preparation is not kept, so the next paste tries again.
    this.#folderReady ??= this.#prepareFolder().catch((failure: unknown) => {
      this.#folderReady = undefined;
      throw failure;
    });
    await this.#folderReady;
    const filePath = path.join(this.#folder, `${PASTED_IMAGE_FILE_PREFIX}${randomUUID()}`);
    // `wx` refuses to follow or replace anything already at the path.
    await writeFile(filePath, new Uint8Array(bytes), { mode: 0o600, flag: "wx" });
    if (owner.isDestroyed()) {
      await this.#remove(filePath);
      throw new Error("The window the picture was pasted into has closed.");
    }
    this.#pathsOf(owner).push(filePath);
    return this.#filePathRefs.mint(owner, "attach", filePath);
  }

  /** Empty the folder and make it readable only by the person. */
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
    // A new document holds none of the old one's tokens, so their pictures open nothing.
    owner.on("did-navigate", () => {
      for (const filePath of paths.splice(0)) {
        void this.#remove(filePath);
      }
    });
    owner.once("destroyed", () => {
      this.#pathsByOwner.delete(owner.id);
      for (const filePath of paths.splice(0)) {
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
        this.#record(`A pasted picture could not be removed: ${String(failure)}`);
      }
    }
  }

  #record(message: string): void {
    this.#log.write({
      at: this.#now().toISOString(),
      level: "error",
      source: "main/bridge/native/file-intake",
      message,
    });
  }
}
