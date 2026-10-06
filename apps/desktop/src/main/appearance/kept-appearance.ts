// Main's live copy of the appearance record and the platform appearance it drives. Made before
// `ready`, so the kept scheme reaches `nativeTheme.themeSource` before any window exists and the
// first frame resolves the right ground. Every change, from the renderer or from the View menu,
// goes through here and is written first: only once the file holds it does it become the record,
// set the platform scheme and tell the listeners (the menu's tick, the windows' grounds, the
// renderer's subscription), so nothing shows a choice a restart would lose. One write runs at a
// time, so a later choice is never overwritten on disk by an earlier one finishing last, and the
// choices made while it runs are written as their last alone: a slider dragged through forty
// positions writes its first and its last, not forty files. A View-menu pick changes the scheme
// alone, over whatever is kept when its turn to be written comes, so a choice whose write failed
// never rides in on it. A listener that throws stops neither the others nor the writes.

import type { NativeTheme } from "electron";

import type {
  AppearanceChoice,
  AppearanceGrounds,
  AppearanceRecord,
  ColorScheme,
  SchemePreference,
} from "#shared/appearance.js";

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

/**
 * What is written next, and every caller its write settles: the renderer's latest whole record, if
 * one waits, and the View menu's latest scheme, if one waits, over that record or the kept one.
 */
interface QueuedRecord {
  readonly record: AppearanceRecord | undefined;
  readonly scheme: SchemePreference | undefined;
  readonly waiting: readonly PendingChoice[];
}

/** Main's appearance record, the scheme in force, and the grounds a window is painted with. */
export class KeptAppearance {
  readonly #file: KeptAppearanceOptions["file"];
  readonly #nativeTheme: KeptAppearanceOptions["nativeTheme"];
  readonly #listeners = new Set<() => void>();
  #record: AppearanceRecord;
  /** Whether a write runs now. */
  #isWriting = false;
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

  /** The scheme the platform draws in now: the one chosen, or the system's under `system`. */
  public get resolvedScheme(): ColorScheme {
    return this.#nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }

  /** The ground a window's first frame is painted in, for the scheme in force now. */
  public get ground(): string {
    return this.#record.grounds[this.resolvedScheme];
  }

  /**
   * The renderer's choice and its theme's grounds, in force once written. Rejects with the file's
   * write failure, and the record stays as it was.
   */
  public choose(choice: AppearanceChoice, grounds: AppearanceGrounds): Promise<void> {
    return this.#keep({ record: { ...choice, grounds }, scheme: undefined });
  }

  /**
   * The View menu's scheme pick, over the choice waiting to be written or else the kept record, in
   * force once written. Rejects with the file's write failure, and the record stays as it was.
   */
  public chooseScheme(scheme: SchemePreference): Promise<void> {
    return this.#keep({ record: this.#queued?.record, scheme });
  }

  /** Calls `listener` after every change to the record or to the platform's scheme. */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #keep(change: Pick<QueuedRecord, "record" | "scheme">): Promise<void> {
    return new Promise((resolve, reject) => {
      // Replaces a choice still waiting, whose caller now settles with this one.
      this.#queued = {
        ...change,
        waiting: [...(this.#queued?.waiting ?? []), { resolve, reject }],
      };
      if (!this.#isWriting) {
        void this.#writeQueued();
      }
    });
  }

  async #writeQueued(): Promise<void> {
    this.#isWriting = true;
    for (let next = this.#queued; next !== undefined; next = this.#queued) {
      this.#queued = undefined;
      // Built now, over the record kept once the write before it settled.
      const base = next.record ?? this.#record;
      const record = next.scheme === undefined ? base : { ...base, scheme: next.scheme };
      try {
        await this.#file.write(record);
      } catch (failure) {
        for (const choice of next.waiting) {
          choice.reject(failure);
        }
        continue;
      }
      this.#record = record;
      this.#nativeTheme.themeSource = record.scheme;
      for (const choice of next.waiting) {
        choice.resolve();
      }
      this.#notify();
    }
    this.#isWriting = false;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (failure) {
        // Thrown again on its own task, where main's uncaught-error handling reports it, so the
        // other listeners still hear the change and the choice stays kept.
        queueMicrotask(() => {
          throw failure;
        });
      }
    }
  }
}
