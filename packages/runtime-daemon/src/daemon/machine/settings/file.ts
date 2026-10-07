// The machine's settings file, read and written by the service, its only writer.
//
// Every read goes to disk, so the service holds no copy that could drift from
// the file. A missing file reads as the defaults and is written with them, with
// nothing for the page to say. A broken file, one that is not JSON or that the
// schema refuses, reads as the defaults and is rewritten with them, and the
// repair is carried on every reading until the next change is written, so the
// page can say both happened. Reads, writes and repairs run one at a time, so a change never
// interleaves with another and a new listener's first reading is never older
// than a change announced after it.
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  MACHINE_SETTINGS_DEFAULTS,
  MachineSettingsSchema,
  parseMachineSettingsFile,
  type MachineSettings,
  type MachineSettingsChange,
  type MachineSettingsReading,
  type SettingsFileRepair,
  type SettingsFileRepairCause,
} from "@ai-sidekicks/contracts/machine-settings";

import { writeFileAtomically } from "../../../atomic-file-write.js";

/** Hears each reading the file takes on: after a change, and after a repair. */
export type MachineSettingsListener = (reading: MachineSettingsReading) => void;

/** Where the settings file lives and the clock that stamps a repair. */
export interface MachineSettingsFileOptions {
  /** The file's full path, `<home>/.ai-sidekicks/machine-settings.json` in the service. */
  readonly filePath: string;
  /** The clock that stamps a repair. */
  readonly now: () => Date;
}

// Readable and writable by the person alone: an environment row's value can
// carry a proxy's credentials.
const SETTINGS_FILE_MODE = 0o600;
const SETTINGS_FOLDER_MODE = 0o700;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The machine-settings file with its read, write and repair rules. Every operation reads
 * the disk and runs one at a time, so callers never see a half-applied change.
 */
export class MachineSettingsFile {
  readonly #filePath: string;
  readonly #now: () => Date;
  readonly #listeners = new Set<MachineSettingsListener>();
  #repair: SettingsFileRepair | undefined;
  #pending: Promise<unknown> = Promise.resolve();

  public constructor(options: MachineSettingsFileOptions) {
    this.#filePath = options.filePath;
    this.#now = options.now;
  }

  /** The file as it stands, with the repair made since the last change, if any. */
  public read(): Promise<MachineSettingsReading> {
    return this.#oneAtATime(() => this.#readFromDisk());
  }

  /** Writes one change over the file as it stands and tells every listener. */
  public update(change: MachineSettingsChange): Promise<MachineSettings> {
    return this.#oneAtATime(async () => {
      const current = await this.#readFromDisk();
      const settings = MachineSettingsSchema.parse({ ...current.settings, ...change });
      await this.#writeAtomically(settings);
      this.#repair = undefined;
      this.#announce({ settings });
      return settings;
    });
  }

  /**
   * Hands the listener the file as it stands, then every later reading, until
   * the returned function is called.
   */
  public subscribe(listener: MachineSettingsListener): Promise<() => void> {
    return this.#oneAtATime(async () => {
      listener(await this.#readFromDisk());
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    });
  }

  #oneAtATime<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.#pending.then(work);
    // The next piece of work waits for this one to settle, whether it succeeded
    // or not; its own caller still receives the failure through `result`.
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readFromDisk(): Promise<MachineSettingsReading> {
    let fileText: string;
    try {
      fileText = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        await this.#writeAtomically(MACHINE_SETTINGS_DEFAULTS);
        return this.#readingOf(MACHINE_SETTINGS_DEFAULTS);
      }
      throw error;
    }
    let fileJson: unknown;
    try {
      fileJson = JSON.parse(fileText);
    } catch {
      return this.#repairWithDefaults("unparseable");
    }
    const parsed = parseMachineSettingsFile(fileJson);
    if (!parsed.success) {
      return this.#repairWithDefaults("schemaRefused");
    }
    return this.#readingOf(parsed.data);
  }

  async #repairWithDefaults(cause: SettingsFileRepairCause): Promise<MachineSettingsReading> {
    await this.#writeAtomically(MACHINE_SETTINGS_DEFAULTS);
    this.#repair = { repairedAt: this.#now().toISOString(), cause };
    const reading = this.#readingOf(MACHINE_SETTINGS_DEFAULTS);
    this.#announce(reading);
    return reading;
  }

  #readingOf(settings: MachineSettings): MachineSettingsReading {
    return this.#repair === undefined ? { settings } : { settings, repair: this.#repair };
  }

  #announce(reading: MachineSettingsReading): void {
    for (const listener of this.#listeners) {
      listener(reading);
    }
  }

  // A reader sees the old file or the new one, never half of either.
  async #writeAtomically(settings: MachineSettings): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: SETTINGS_FOLDER_MODE });
    await writeFileAtomically(
      this.#filePath,
      `${JSON.stringify(settings, null, 2)}\n`,
      SETTINGS_FILE_MODE,
    );
  }
}
