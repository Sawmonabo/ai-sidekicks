// This window's view of main's appearance record, the one copy there is: it hears every record main
// keeps through `window.subscribeAppearance`, the View menu's pick and another window's choice
// among them, and asks for a change through `window.setAppearance`, which main applies only once
// the record is written. It holds the last record heard and nothing the person chose that main has
// not kept, so the window never shows a scheme a restart would lose.

import type { AppearanceRecord, SchemePreference } from "@shared/appearance.js";
import type { PreloadApi, Unsubscribe } from "@shared/preload-api.js";
import { nextSchemePreference } from "@renderer/styles/tokens.js";

/** The `window` members the client speaks. */
export type AppearanceMembers = Pick<PreloadApi["window"], "setAppearance" | "subscribeAppearance">;

/** Main's appearance record as this window hears it, and the acts that ask main to change it. */
export class AppearanceClient {
  readonly #members: AppearanceMembers;
  readonly #listeners = new Set<(record: AppearanceRecord) => void>();
  readonly #firstRecord: Promise<AppearanceRecord>;
  readonly #stopHearing: Unsubscribe;
  #record: AppearanceRecord | undefined;
  #isClosed = false;

  /** Starts hearing main's record; `close` stops it. */
  public constructor(members: AppearanceMembers) {
    this.#members = members;
    let heardFirst: (record: AppearanceRecord) => void = () => undefined;
    this.#firstRecord = new Promise((resolve) => {
      heardFirst = resolve;
    });
    this.#stopHearing = members.subscribeAppearance((record) => {
      this.#record = record;
      heardFirst(record);
      for (const listener of this.#listeners) {
        listener(record);
      }
    });
  }

  /** Calls `listener` with the record heard last, if any, and with every record after it. */
  public subscribe(listener: (record: AppearanceRecord) => void): Unsubscribe {
    this.#listeners.add(listener);
    if (this.#record !== undefined) {
      listener(this.#record);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Asks main to keep `scheme`. Rejects with main's refusal, and the record stays as it was. */
  public async chooseScheme(scheme: SchemePreference): Promise<void> {
    const { grounds, ...choice } = await this.#current();
    await this.#members.setAppearance({ ...choice, scheme }, grounds);
  }

  /** Asks main to keep the scheme after the one in force, in the cycle a person steps through. */
  public async chooseNextScheme(): Promise<void> {
    await this.chooseScheme(nextSchemePreference((await this.#current()).scheme));
  }

  /** Whether `close` has run; a closed client hears nothing more and is not reopened. */
  public get isClosed(): boolean {
    return this.#isClosed;
  }

  /** Stops hearing main's record, for good. */
  public close(): void {
    this.#isClosed = true;
    this.#stopHearing();
    this.#listeners.clear();
  }

  /** The record in force, waiting for main's first delivery when none was heard yet. */
  async #current(): Promise<AppearanceRecord> {
    return this.#record ?? (await this.#firstRecord);
  }
}
