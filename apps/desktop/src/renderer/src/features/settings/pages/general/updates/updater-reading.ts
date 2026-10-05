// What the updater said, sequenced across its two sources.
//
// The block subscribes and then reads the current state once, and the answers race: an opening
// read that installed unconditionally would overwrite a transition pushed meanwhile, hiding a
// `ready`, `downloading` or error until the next push, which a terminal arm never makes. So the
// sources are sequenced: the opening read installs only while nothing has been pushed.
//
// `close()` is not terminal: StrictMode runs an effect's cleanup between two setups and a changed
// updater rebuilds the opening, so an opening is a generation that `close()` invalidates and a
// later `open()` restarts. The holder takes the updater namespace, not the whole bridge.
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Unsubscribe, UpdateState } from "@shared/preload-api.js";

import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import { Emitter } from "@renderer/lib/emitter.js";
import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import { GenerationLatch, type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";

/** The updater's calls: the state read, its subscription, and its controls. */
export type UpdaterCalls = PlatformBridge["update"];

/**
 * What the block knows about the updater: nothing read yet, the state it reported, or the
 * refusal its opening read was answered with.
 */
export type UpdateReading =
  | { readonly kind: "not-read" }
  | { readonly kind: "state"; readonly state: UpdateState }
  | { readonly kind: "failed"; readonly refusal: Refusal };

/** The held reading, rebuilt on every accepted observation and held by identity. */
export interface UpdaterReadingSnapshot {
  readonly reading: UpdateReading;
}

const NOTHING_READ: UpdaterReadingSnapshot = { reading: { kind: "not-read" } };

/** The subsystem a refused opening read names as its author. */
const UPDATER_READ_ORIGIN = "updater-read";

/** The one key this holder claims on its latch, named so the take and the teardown agree. */
const OPENING_KEY = "open";

/**
 * One window's reading of the updater, sequenced across its two sources.
 *
 * A class with private fields because it owns a subscription, an opening generation, and the
 * rule for which answer installs. The React binding is `useUpdateReading`.
 */
export class UpdaterReadingHolder {
  readonly #updater: UpdaterCalls;
  readonly #changes = new Emitter<void>("updater reading change");
  #snapshot: UpdaterReadingSnapshot = NOTHING_READ;
  #release: (() => void) | undefined = undefined;
  /** The openings this holder has made. One round per `open`, released by `close`. */
  readonly #openings = new GenerationLatch();
  /** Reset per opening, because each opening subscribes afresh. */
  #hasObservedPush = false;

  public constructor(updater: UpdaterCalls) {
    this.#updater = updater;
  }

  public snapshot(): UpdaterReadingSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Subscribe, then read once, in that order: a transition landing between a read and the
   * handler attaching would be lost, while the reverse costs one redundant render. A rejected
   * read installs its refusal under the same rule as an answer: only while nothing was pushed.
   */
  public open(): void {
    this.close();
    const opening = this.#openings.supersedeAndClaim(this, OPENING_KEY);
    this.#hasObservedPush = false;
    this.#release = this.#updater.subscribe((state) => {
      this.#observePush(opening, state);
    });
    void this.#updater.getState().then(
      (state) => {
        this.#observeOpening(opening, { kind: "state", state });
      },
      (error: unknown) => {
        this.#observeOpening(opening, {
          kind: "failed",
          refusal: coerceToRefusal(error, UPDATER_READ_ORIGIN),
        });
      },
    );
  }

  /** Release the current opening. Not terminal: {@link open} starts another. */
  public close(): void {
    this.#openings.supersedeAll();
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  /** A transition the updater pushed: always the newest fact this window has. */
  #observePush(opening: GenerationClaim, state: UpdateState): void {
    opening.settle(() => {
      this.#hasObservedPush = true;
      this.#install({ kind: "state", state });
    });
  }

  /** The opening read's answer, installed only while nothing has been pushed; a push is newer. */
  #observeOpening(opening: GenerationClaim, reading: UpdateReading): void {
    opening.settle(() => {
      if (this.#hasObservedPush) {
        return;
      }
      this.#install(reading);
    });
  }

  #install(reading: UpdateReading): void {
    this.#snapshot = { reading };
    this.#changes.emit();
  }
}
