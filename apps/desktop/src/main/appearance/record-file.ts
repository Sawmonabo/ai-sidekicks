// `appearance.json` in the user-data folder: the theme, the scheme, the text size, the transcript
// width and the current theme's two grounds, written by main alone through `window.setAppearance`.
// It is read before the first window exists, so the read is synchronous, and it never stops a
// start: a missing file reads as the default appearance and stays missing until the first choice;
// an unreadable one reads as the default and is left alone; a broken one (not JSON, or refused by
// the schema) reads as the default and is rewritten as it before the read answers. The last two
// are written to main's diagnostic log, a failed rewrite among them.

import { readFileSync } from "node:fs";

import * as z from "zod/mini";

import {
  APPEARANCE_THEMES,
  COLOR_SCHEMES,
  DEFAULT_APPEARANCE_RECORD,
  SYSTEM_SCHEME_PREFERENCE,
  TEXT_SIZES,
  TRANSCRIPT_WIDTH_CEILING,
  TRANSCRIPT_WIDTH_FLOOR,
  type AppearanceChoice,
  type AppearanceGrounds,
  type AppearanceRecord,
} from "#shared/appearance.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { isMissingPath } from "../services/missing-path.js";
import { writeOwnerOnlyJsonFileSync, writeOwnerOnlyJsonFile } from "../services/owner-only-file.js";

/** The file's name inside the app's user-data folder. */
export const APPEARANCE_FILE_NAME = "appearance.json";

/** A ground as the platform paints it: `#rrggbb`. */
const groundSchema = z.string().check(z.regex(/^#[0-9a-fA-F]{6}$/));

const appearanceChoiceShape = {
  theme: z.enum(APPEARANCE_THEMES),
  scheme: z.enum([...COLOR_SCHEMES, SYSTEM_SCHEME_PREFERENCE]),
  textSize: z.literal(TEXT_SIZES),
  transcriptWidth: z.number().check(z.gte(TRANSCRIPT_WIDTH_FLOOR), z.lte(TRANSCRIPT_WIDTH_CEILING)),
};

/** Parses the choice the renderer sends; throws on anything that is not one. */
export const appearanceChoiceSchema: z.ZodMiniType<AppearanceChoice> =
  z.strictObject(appearanceChoiceShape);

/** Parses the grounds the renderer sends; throws on anything that is not two `#rrggbb` colors. */
export const appearanceGroundsSchema: z.ZodMiniType<AppearanceGrounds> = z.strictObject({
  light: groundSchema,
  dark: groundSchema,
});

const appearanceRecordSchema: z.ZodMiniType<AppearanceRecord> = z.strictObject({
  ...appearanceChoiceShape,
  grounds: appearanceGroundsSchema,
});

/** Where the record lives, and where a file that could not be read or repaired is reported. */
export interface AppearanceRecordFileOptions {
  readonly filePath: string;
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly now: () => Date;
}

/** Main's reader and writer for the appearance record. */
export class AppearanceRecordFile {
  readonly #filePath: string;
  readonly #log: AppearanceRecordFileOptions["log"];
  readonly #now: () => Date;

  public constructor(options: AppearanceRecordFileOptions) {
    this.#filePath = options.filePath;
    this.#log = options.log;
    this.#now = options.now;
  }

  /**
   * The record as kept, or the default appearance when none is kept or the file cannot be read or
   * is broken, which is rewritten as the default first. Never throws.
   */
  public readSync(): AppearanceRecord {
    let fileText: string;
    try {
      fileText = readFileSync(this.#filePath, "utf8");
    } catch (error) {
      if (!isMissingPath(error)) {
        this.#report("warning", "could not be read, so the defaults are in force", error);
      }
      return DEFAULT_APPEARANCE_RECORD;
    }
    let fileJson: unknown;
    try {
      fileJson = JSON.parse(fileText);
    } catch {
      return this.#repairSync();
    }
    const parsed = appearanceRecordSchema.safeParse(fileJson);
    return parsed.success ? parsed.data : this.#repairSync();
  }

  /** Replaces the whole record. Rejects with the file system's error. */
  public write(record: AppearanceRecord): Promise<void> {
    return writeOwnerOnlyJsonFile(this.#filePath, record);
  }

  #repairSync(): AppearanceRecord {
    try {
      writeOwnerOnlyJsonFileSync(this.#filePath, DEFAULT_APPEARANCE_RECORD);
    } catch (error) {
      this.#report(
        "error",
        "was broken and could not be rewritten; the defaults are in force",
        error,
      );
      return DEFAULT_APPEARANCE_RECORD;
    }
    this.#report("warning", "was broken and was rewritten as the defaults");
    return DEFAULT_APPEARANCE_RECORD;
  }

  #report(level: "error" | "warning", what: string, failure?: unknown): void {
    const cause =
      failure === undefined
        ? ""
        : `: ${failure instanceof Error ? failure.message : String(failure)}`;
    this.#log.write({
      at: this.#now().toISOString(),
      level,
      source: "main/appearance",
      message: `the appearance record ${what}${cause}`,
    });
  }
}
