// `keyboard-map.json` in the user-data folder holds only the rows a person changed, keyed by
// command id, each a chord or `null`. Every read goes to disk, so main keeps no copy that
// could drift. A missing file reads as the empty map and stays missing until the first write.
// A broken file (not JSON, or refused by the schema) reads as the empty map, is rewritten as
// that, and the repair rides on every reading until the next write. Reads and writes run one
// at a time, and a write goes through a temporary file and a rename with owner-only
// permissions, so a crash mid-save never leaves half a file. Which command ids still name an
// act is the renderer's to decide.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { SettingsFileRepair, SettingsFileRepairCause } from "@ai-sidekicks/contracts";
import * as z from "zod/mini";

import type { KeyboardMap, KeyboardMapReading } from "@shared/preload-api.js";

/** The file's name inside the app's user-data folder. */
export const KEYBOARD_MAP_FILE_NAME = "keyboard-map.json";

const KEYBOARD_MAP_FILE_MODE = 0o600;
const KEYBOARD_MAP_FOLDER_MODE = 0o700;

/** The longest command id or chord the file admits. */
const KEYBOARD_MAP_TEXT_MAX_LEN = 256;

const keyboardMapTextSchema = z
  .string()
  .check(z.minLength(1), z.maxLength(KEYBOARD_MAP_TEXT_MAX_LEN));

const KeyboardMapSchema: z.ZodMiniType<KeyboardMap> = z.record(
  keyboardMapTextSchema,
  z.nullable(keyboardMapTextSchema),
);

/** Parses a map the renderer asks to store; throws on anything that is not one. */
export function parseKeyboardMap(candidate: unknown): KeyboardMap {
  return KeyboardMapSchema.parse(candidate);
}

/** Where the keyboard map file lives and the clock that stamps a repair. */
export interface KeyboardMapFileOptions {
  /** The file's full path. */
  readonly filePath: string;
  readonly now: () => Date;
}

const EMPTY_MAP: KeyboardMap = Object.freeze({});

/** Main's reader and writer for the keyboard map file. */
export class KeyboardMapFile {
  readonly #filePath: string;
  readonly #now: () => Date;
  #repair: SettingsFileRepair | undefined;
  #pending: Promise<unknown> = Promise.resolve();

  public constructor(options: KeyboardMapFileOptions) {
    this.#filePath = options.filePath;
    this.#now = options.now;
  }

  /** The map as it stands, with the repair made since the last write, if any. */
  public read(): Promise<KeyboardMapReading> {
    return this.#oneAtATime(() => this.#readFromDisk());
  }

  /** Replaces the whole map and answers it as stored. */
  public write(map: KeyboardMap): Promise<KeyboardMap> {
    return this.#oneAtATime(async () => {
      await this.#writeAtomically(map);
      this.#repair = undefined;
      return map;
    });
  }

  #oneAtATime<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.#pending.then(work);
    // The next piece of work waits for this one to settle either way; its caller still gets
    // the failure through `result`.
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readFromDisk(): Promise<KeyboardMapReading> {
    let fileText: string;
    try {
      fileText = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return this.#readingOf(EMPTY_MAP);
      }
      throw error;
    }
    let fileJson: unknown;
    try {
      fileJson = JSON.parse(fileText);
    } catch {
      return this.#repairWithEmptyMap("unparseable");
    }
    const parsed = KeyboardMapSchema.safeParse(fileJson);
    if (!parsed.success) {
      return this.#repairWithEmptyMap("schemaRefused");
    }
    return this.#readingOf(parsed.data);
  }

  async #repairWithEmptyMap(cause: SettingsFileRepairCause): Promise<KeyboardMapReading> {
    await this.#writeAtomically(EMPTY_MAP);
    this.#repair = { repairedAt: this.#now().toISOString(), cause };
    return this.#readingOf(EMPTY_MAP);
  }

  #readingOf(map: KeyboardMap): KeyboardMapReading {
    return this.#repair === undefined ? { map } : { map, repair: this.#repair };
  }

  // A flushed temporary file renamed over the real one: a reader sees the old file or the new.
  async #writeAtomically(map: KeyboardMap): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: KEYBOARD_MAP_FOLDER_MODE });
    const temporaryPath = `${this.#filePath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", KEYBOARD_MAP_FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(map, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
