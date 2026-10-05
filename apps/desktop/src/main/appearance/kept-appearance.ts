// Main's live copy of the appearance record and the platform appearance it drives. Made before
// `ready`, so the kept scheme reaches `nativeTheme.themeSource` before any window exists and the
// first frame resolves the right ground. Every change, from the renderer or from the View menu,
// goes through here and is written first: only once the file holds it does it become the record,
// set the platform scheme and tell the listeners (the menu's tick, the windows' grounds, the
// renderer's subscription), so nothing shows a choice a restart would lose. One write runs at a
// time, so a later choice is never overwritten on disk by an earlier one finishing last, and the
// choices made while it runs are written as their last alone: a slider dragged through forty
// positions writes its first and its last, not forty files.

import type { NativeTheme } from "electron";

import type {
  AppearanceChoice,
  AppearanceGrounds,
  AppearanceRecord,
  ColorScheme,
  SchemePreference,
} from "@shared/appearance.js";

import type { AppearanceRecordFile } from "./record-file.js";

/** What the kept appearance is built over. */
export interface KeptAppearanceOptions {
  readonly file: Pick<AppearanceRecordFile, "readSync" | "write">;
  readonly nativeTheme: Pick<NativeTheme, "themeSource" | "shouldUseDarkColors" | "on">;
}

/** A caller waiting on a choice's write: its own, or that of a later choice that replaced it. */
interface PendingChoice {
  readonly resolve: () => void;
  readonly reject: (failure: unknown) => void;
}

/** The record waiting to be written next, and every caller its write settles. */
interface QueuedRecord {
  readonly record: AppearanceRecord;
  readonly waiting: readonly PendingChoice[];
}

/** Main's appearance record, the scheme in force, and the grounds a window is painted with. */
export class KeptAppearance {
  readonly #file: KeptAppearanceOptions["file"];
  readonly #nativeTheme: KeptAppearanceOptions["nativeTheme"];
  readonly #listeners = new Set<() => void>();
  #record: AppearanceRecord;
  /** The record being written now, until its write settles. */
  #writing: AppearanceRecord | undefined;
  #queued: QueuedRecord | undefined;

  /** Reads the kept record and sets the platform scheme from it. */
  public constructor(options: KeptAppearanceOptions) {
    this.#file = options.file;
    this.#nativeTheme = options.nativeTheme;
    this.#record = this.#file.readSync();
    this.#nativeTheme.themeSource = this.#record.scheme;
    // The operating system's own scheme moving changes which ground `system` paints.
    this.#nativeTheme.on("updated", () => {
      this.#notify();
    });
  }

  /** The kept record: the default appearance until a choice is kept. */
  public get record(): AppearanceRecord {
    return this.#record;
  }

  /** The scheme in force. */
  public get scheme(): SchemePreference {
    return this.#record.scheme;
  }

  /** The ground a window's first frame is painted in, for the scheme in force now. */
  public get ground(): string {
    return this.#record.grounds[this.#resolvedScheme()];
  }

  /**
   * The renderer's choice and its theme's grounds, in force once written. Rejects with the file's
   * write failure, and the record stays as it was.
   */
  public choose(choice: AppearanceChoice, grounds: AppearanceGrounds): Promise<void> {
    return this.#keep({ ...choice, grounds });
  }

  /**
   * The View menu's scheme pick, over the latest choice made, in force once written. Rejects with
   * the file's write failure, and the record stays as it was.
   */
  public chooseScheme(scheme: SchemePreference): Promise<void> {
    const latest = this.#queued?.record ?? this.#writing ?? this.#record;
    return this.#keep({ ...latest, scheme });
  }

  /** Calls `listener` after every change to the record or to the platform's scheme. */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #keep(record: AppearanceRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      // Replaces a choice still waiting, whose caller now settles with this one.
      this.#queued = { record, waiting: [...(this.#queued?.waiting ?? []), { resolve, reject }] };
      if (this.#writing === undefined) {
        void this.#writeQueued();
      }
    });
  }

  async #writeQueued(): Promise<void> {
    for (let next = this.#queued; next !== undefined; next = this.#queued) {
      this.#queued = undefined;
      this.#writing = next.record;
      try {
        await this.#file.write(next.record);
        this.#record = next.record;
        this.#nativeTheme.themeSource = next.record.scheme;
        this.#notify();
      } catch (failure) {
        for (const choice of next.waiting) {
          choice.reject(failure);
        }
        continue;
      } finally {
        this.#writing = undefined;
      }
      for (const choice of next.waiting) {
        choice.resolve();
      }
    }
  }

  #resolvedScheme(): ColorScheme {
    return this.#nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
