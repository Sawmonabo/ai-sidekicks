// `window-places.json` in the user-data folder: which console window was used last, and where each
// window was, one entry per window keyed by its place key (`../frame-name.ts`), holding its
// rectangle in screen coordinates (which also say which display it was on) and whether it was
// maximized or fullscreen. It is read once, before the console window is built, and written whole
// when a window closes; the registry keeps in it the console windows open now, the last one
// closed, and one place per pane kind (`../open-windows.ts`). Read defensively: a missing or
// unreadable file reads as no window used last and no places, so the app comes up at the default
// size; a file that is not a JSON object, an entry the schema refuses and a window used last the
// frame-name grammar refuses are dropped, and the file is rewritten with what is left. Every
// failure is recorded in main's diagnostic log.

import { readFileSync } from "node:fs";

import * as z from "zod/mini";

import { isConsoleWindowId } from "#shared/window/frame-name.js";

import type { MainDiagnosticLog } from "../../services/diagnostic-log.js";
import { isMissingPath } from "../../services/missing-path.js";
import { writeOwnerOnlyJsonFileSync } from "../../services/owner-only-file.js";

/** The file's name inside the app's user-data folder. */
export const WINDOW_PLACES_FILE_NAME = "window-places.json";

/** One window's kept place: its normal rectangle and its maximized or fullscreen state. */
export interface WindowPlace {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
  readonly isFullScreen: boolean;
}

/** What the file keeps: the console window used last, and every window's place by place key. */
export interface KeptWindowPlaces {
  /** The id of the window of session views used last, opened first at the next start. */
  readonly windowUsedLast: string | undefined;
  readonly places: ReadonlyMap<string, WindowPlace>;
}

const windowPlaceSchema: z.ZodMiniType<WindowPlace> = z.strictObject({
  x: z.int(),
  y: z.int(),
  width: z.int().check(z.positive()),
  height: z.int().check(z.positive()),
  isMaximized: z.boolean(),
  isFullScreen: z.boolean(),
});

/** Main's reader and writer for the window places. */
export class WindowPlaceFile {
  readonly #filePath: string;
  readonly #log: Pick<MainDiagnosticLog, "write">;

  public constructor(filePath: string, log: Pick<MainDiagnosticLog, "write">) {
    this.#filePath = filePath;
    this.#log = log;
  }

  /**
   * What the file keeps that the schema accepts; nothing when the file cannot be read. A file
   * holding anything the schema refuses is rewritten with only what it accepts.
   */
  public readSync(): KeptWindowPlaces {
    let fileText: string;
    try {
      fileText = readFileSync(this.#filePath, "utf8");
    } catch (error) {
      if (!isMissingPath(error)) {
        this.#record("warning", `the window places were unreadable: ${describe(error)}`);
      }
      return nothingKept();
    }
    let fileJson: unknown;
    try {
      fileJson = JSON.parse(fileText);
    } catch (error) {
      return this.#repairSync(
        nothingKept(),
        `the window places file is not JSON: ${describe(error)}`,
      );
    }
    if (!isRecord(fileJson)) {
      return this.#repairSync(nothingKept(), "the window places file is not an object");
    }
    const keptPlaces = isRecord(fileJson["places"]) ? fileJson["places"] : {};
    const places = new Map<string, WindowPlace>();
    for (const [placeKey, entry] of Object.entries(keptPlaces)) {
      const parsed = windowPlaceSchema.safeParse(entry);
      if (parsed.success) {
        places.set(placeKey, parsed.data);
      }
    }
    const keptWindowUsedLast = fileJson["windowUsedLast"];
    const kept: KeptWindowPlaces = {
      windowUsedLast: isConsoleWindowId(keptWindowUsedLast) ? keptWindowUsedLast : undefined,
      places,
    };
    const isWhole =
      isRecord(fileJson["places"]) &&
      places.size === Object.keys(keptPlaces).length &&
      (keptWindowUsedLast === undefined || kept.windowUsedLast !== undefined) &&
      Object.keys(fileJson).every((key) => key === "places" || key === "windowUsedLast");
    return isWhole ? kept : this.#repairSync(kept, "the window places file held refused entries");
  }

  /**
   * Replaces the file with `kept`. Synchronous because a window's close can be the last thing
   * before the process ends. Throws the file system's error.
   */
  public writeSync(kept: KeptWindowPlaces): void {
    writeOwnerOnlyJsonFileSync(this.#filePath, {
      windowUsedLast: kept.windowUsedLast,
      places: Object.fromEntries(kept.places),
    });
  }

  /** Rewrites the file as `kept`, recording why; a failed rewrite is recorded and `kept` stands. */
  #repairSync(kept: KeptWindowPlaces, why: string): KeptWindowPlaces {
    this.#record("warning", `${why}; rewriting it with what it holds that is valid`);
    try {
      this.writeSync(kept);
    } catch (error) {
      this.#record("error", `the window places file could not be rewritten: ${describe(error)}`);
    }
    return kept;
  }

  #record(level: "error" | "warning", message: string): void {
    this.#log.write({
      at: new Date().toISOString(),
      level,
      source: "main/windows/place-file",
      message,
    });
  }
}

function nothingKept(): KeptWindowPlaces {
  return { windowUsedLast: undefined, places: new Map() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
