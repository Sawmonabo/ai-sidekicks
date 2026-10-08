// The durable record of every terminal child this daemon started and has not yet seen end, so a
// daemon that died without draining them can find and end them at its next start. A child is
// recorded twice: its intent, made durable before it is started and naming the nonce its
// environment will carry, then its process once it runs. So no child ever exists outside the
// record, even when the daemon dies between the two.
//
// The file is the one source; every change rewrites it whole, crash-safely, one write at a time.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { writeFileAtomically, type AtomicWriteFileSystem } from "../../file/atomic-write.js";

/** The registry's file name in the data folder. */
export const ORPHAN_REGISTRY_FILE_NAME = "orphan-registry.json";

/** The environment variable that carries a child's nonce, by which a sweep recognizes it. */
export const SPAWN_NONCE_ENVIRONMENT_NAME = "SIDEKICKS_SPAWN_NONCE";

/** The registry file is the person's alone. */
const REGISTRY_FILE_MODE = 0o600;

/** A started child as the system knows it, enough to tell it from a later process with its id. */
export interface RecordedChild {
  processId: number;
  processStartTime: string;
}

/**
 * One child the daemon started: the nonce its environment carries and the boot it was started in,
 * and the process once it runs. An entry with no `child` is an intent whose child may or may not
 * have started.
 */
export interface OrphanRegistryEntry {
  nonce: string;
  bootId: string;
  child?: RecordedChild | undefined;
}

const OrphanRegistryFileSchema = z
  .object({
    entries: z.array(
      z
        .object({
          nonce: z.string().min(1),
          bootId: z.string().min(1),
          child: z
            .object({
              processId: z.number().int().positive(),
              processStartTime: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * What a previous run left in the file. An unreadable or invalid file yields no entries and the
 * reason, so nothing is signaled on the strength of a file that cannot be trusted.
 */
export interface OrphanRegistryLeftover {
  entries: OrphanRegistryEntry[];
  unreadableCause?: string | undefined;
}

/**
 * The registry over one data folder. It starts empty in memory; the first change, or `forget`,
 * replaces whatever a previous run left. Each change resolves once it is durable on disk.
 */
export class OrphanRegistry {
  readonly #filePath: string;
  readonly #fileSystem: AtomicWriteFileSystem | undefined;
  readonly #entries = new Map<string, OrphanRegistryEntry>();
  #lastWrite: Promise<void> = Promise.resolve();

  constructor(dataFolder: string, fileSystem?: AtomicWriteFileSystem) {
    this.#filePath = path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME);
    this.#fileSystem = fileSystem;
  }

  /** Reads what a previous run left; a missing file leaves nothing. */
  async readLeftover(): Promise<OrphanRegistryLeftover> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { entries: [] };
      }
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return { entries: [], unreadableCause: `it is not JSON (${String(error)})` };
    }
    const parsed = OrphanRegistryFileSchema.safeParse(json);
    if (!parsed.success) {
      return { entries: [], unreadableCause: `its contents are invalid (${parsed.error.message})` };
    }
    return { entries: parsed.data.entries };
  }

  /** Replaces what a previous run left with this run's entries, none until a child starts. */
  forget(): Promise<void> {
    return this.#write();
  }

  /**
   * Records that a child carrying `nonce` is about to start; resolves once durable. A failed write
   * forgets the intent, since no child will start under it.
   */
  async recordIntent(nonce: string, bootId: string): Promise<void> {
    this.#entries.set(nonce, { nonce, bootId });
    try {
      await this.#write();
    } catch (error) {
      this.#entries.delete(nonce);
      throw error;
    }
  }

  /** Records the started child of an intent; an intent already retired stays retired. */
  recordChild(nonce: string, child: RecordedChild): Promise<void> {
    const entry = this.#entries.get(nonce);
    if (entry === undefined) {
      return Promise.resolve();
    }
    this.#entries.set(nonce, { ...entry, child });
    return this.#write();
  }

  /** Forgets a child that has ended; retiring one twice changes nothing. */
  retire(nonce: string): Promise<void> {
    if (!this.#entries.delete(nonce)) {
      return Promise.resolve();
    }
    return this.#write();
  }

  /** Resolves once every change asked for so far has been written or has failed. */
  whenWritten(): Promise<void> {
    return this.#lastWrite;
  }

  // Each write takes the entries as they are when it runs, after the write before it.
  #write(): Promise<void> {
    const write = this.#lastWrite.then(() =>
      writeFileAtomically(
        this.#filePath,
        `${JSON.stringify({ entries: [...this.#entries.values()] })}\n`,
        REGISTRY_FILE_MODE,
        this.#fileSystem,
      ),
    );
    // The failure reaches the change that asked for this write; the queue only orders the next.
    this.#lastWrite = write.catch(() => undefined);
    return write;
  }
}
