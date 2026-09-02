// What the artifact pane knows, who asked for it, and what it refuses to invent.
//
// `Spec-023 §Console Design (Meridian)` §10.4. Two reads, both on `Plan-023 §Console
// growth slate` and both refused by name today: `artifactList` and `artifactRead`
// against `artifact-ingest-and-crud`, `artifactAllowlistRead` against
// `artifact-allowlist-and-abort`.
//
// THE ONE DECISION IN THIS FILE IS WHAT TO DO WITH A SERVED LIST, AND IT HAS CHANGED.
// The growth port's `artifactList` used to answer a four-member payload summary —
// `artifactId`, `name`, `byteLength`, `contentType` — while §10.4's row renders the
// MANIFEST ENVELOPE, and none of the missing members was derivable from the four that
// were present. So a served list was REFUSED with the console's own code rather than
// mapped, and that refusal named the gap "so the day the shape lands the fix is a
// mapping and not an archaeology". The shape landed: `GrowthArtifactSummary` now
// mirrors `api-payload-contracts.md §ArtifactManifest` member for member. The fix is
// the mapping, and it lives on the model beside the vocabularies it fills
// (`repos/artifact-model.ts:artifactManifestRowFromSummary`) rather than here, because
// what a served row IS is a model question and this file owns only who asked.
//
// NO TIMER AND NO POLL, AND ALSO NO RACE. The reads run once when the pane mounts and
// again when the participant asks, and BOTH go through the console's one
// `RefreshScheduler` (`store/scheduling.ts`, the `repos/repo-mounts-reader.ts`
// precedent) rather than straight at the port. A reader that called the port on every
// press started a second list/allow-list pair beside the first: two presses cost two
// read pairs, an older answer could land after a newer one and overwrite it, and the
// two legs published independently, so a snapshot could hold a list from one press
// beside an allow-list from another. The scheduler coalesces a burst of presses into
// one read and serializes reads so two never overlap; the GENERATION stamp below is
// what makes the discard explicit — every completion carries the stamp its refresh was
// issued under, a completion whose stamp is no longer current is dropped, and the two
// legs of one generation publish as ONE snapshot rather than two.
//
// `Spec-023`'s refresh rule allows focus, reconnect, and a stale frame; a pane that
// armed an interval would be spending the budget on a wire that refuses.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  Emitter,
  RealClock,
  refuse,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import {
  ATTACHMENT_ALLOWLIST_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
} from "../../repos/attachment-model.js";
import {
  artifactManifestRowFromSummary,
  type ArtifactsPanelState,
} from "../../repos/artifact-model.js";
import { RefreshScheduler } from "../../store/index.js";

/**
 * The effective allow-list and byte cap, with where they came from.
 *
 * `source` is rendered rather than inferred. An operator override REPLACES the default
 * wholesale — `Spec-014 §Bounds (normative defaults; operator-tunable)` — so a hint that
 * could not say which of the two it is showing would be a hint a participant cannot
 * trust against a deployment they cannot see.
 */
export interface ArtifactAllowlistReading {
  readonly source: "effective" | "shipped-default";
  readonly mediaTypes: readonly string[];
  readonly maximumByteLength: number;
  /** Why the effective read did not answer, on the `shipped-default` arm. */
  readonly refusal: ConsoleRefusal | undefined;
}

/** Everything the pane renders from, in one immutable value. */
export interface ArtifactPaneReading {
  readonly artifacts: ArtifactsPanelState;
  readonly allowlist: ArtifactAllowlistReading;
}

const SHIPPED_DEFAULT_ALLOWLIST: ArtifactAllowlistReading = {
  source: "shipped-default",
  mediaTypes: ATTACHMENT_ALLOWLIST_DEFAULT,
  maximumByteLength: ATTACHMENT_BYTE_CAP_DEFAULT,
  refusal: undefined,
};

const NOTHING_READ_YET: ArtifactPaneReading = {
  artifacts: { kind: "not-checked" },
  allowlist: SHIPPED_DEFAULT_ALLOWLIST,
};

/** Which subsystem refused, when the refusal is this reader's own and not the port's. */
const ARTIFACT_READER_ORIGIN = "artifact-pane-reader";

export interface ArtifactPaneReaderOptions {
  readonly bridge: ConsoleBridge;
  /**
   * The session to read. ABSENT on a bare route, where the deck has a pane and no
   * session behind it — and a reader that read anyway would have to invent a session
   * id, so it reads nothing and the pane renders the absence that says nobody asked.
   */
  readonly sessionId: string | undefined;
  /** Injected so a test drives every read on frozen time with no real timers. */
  readonly clock?: ConsoleClock;
}

export class ArtifactPaneReader {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string | undefined;
  readonly #scheduler: RefreshScheduler;
  readonly #changes = new Emitter<ArtifactPaneReading>("artifact pane reading");

  #reading: ArtifactPaneReading = NOTHING_READ_YET;
  #started = false;
  #disposed = false;
  #hasEnteredLoading = false;
  /**
   * Which refresh a completion belongs to.
   *
   * Bumped when a read starts AND when the reader is disposed, so one comparison
   * answers both "this answer was superseded" and "this answer outlived its pane".
   * A second boolean beside it would be two mechanisms for one question.
   */
  #generation = 0;

  public constructor(options: ArtifactPaneReaderOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock ?? new RealClock(),
      perform: async () => {
        await this.#performRead();
      },
      // Swallowing is not an option, and re-throwing into a timer callback reaches
      // nobody, so a read that threw past its own refusal handling lands in the
      // reading as a refusal — the pane then renders it instead of holding stale rows
      // behind a list that never answered.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          artifacts: {
            kind: "refused",
            refusal: refuse(
              ARTIFACT_READER_ORIGIN,
              "read-threw",
              `The artifact read failed before it could answer: ${describeFailure(error)}`,
            ),
          },
        });
      },
    });
  }

  /** What the pane renders right now. Stable identity between publishes. */
  public get snapshot(): ArtifactPaneReading {
    return this.#reading;
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  public subscribe(sink: (reading: ArtifactPaneReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read once.
   *
   * Idempotent for React's development double-mount, which would otherwise double every
   * read in exactly the environment where the budget is being watched.
   */
  public start(): void {
    if (this.#started || this.#disposed || this.#sessionId === undefined) {
      return;
    }
    this.#started = true;
    this.#scheduler.request("subscribe");
  }

  /**
   * Read again, because a participant asked. The only other reason there is.
   *
   * Routed through the scheduler rather than performed here, so a second press inside
   * the coalescing window costs no second read pair and a press made while a read is
   * outstanding becomes the NEXT read rather than a parallel one.
   *
   * THE REASON IS `subscribe` BECAUSE THE SET HAS NO BETTER MEMBER. `RefreshReason`
   * (`store/scheduling.ts`) is a closed five-member set — subscribe, window-focus,
   * reconnect, terminal-event, gap-repull — and a participant-requested re-read is
   * none of them. `subscribe` is the one whose meaning is not FALSE here: the press
   * asks for the same whole-pane read the subscription asked for. Naming it
   * `terminal-event` would fabricate a diagnostics reason, which that module's own
   * doc forbids.
   */
  public refresh(): void {
    if (this.#disposed || this.#sessionId === undefined) {
      return;
    }
    this.#scheduler.request("subscribe");
  }

  /** Terminal. No later completion can publish behind a pane that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#scheduler.dispose();
    this.#changes.clear();
  }

  async #performRead(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      return;
    }
    this.#generation += 1;
    const generation = this.#generation;

    // ENTERED ONCE, NEVER RE-ENTERED. Rule 8 separates "a read is in flight" from
    // "nobody asked", and a refresh that dropped the rows back to the in-flight
    // absence would blank a surface that has an answer on it while it re-reads.
    if (!this.#hasEnteredLoading) {
      this.#hasEnteredLoading = true;
      this.#publish({ ...this.#reading, artifacts: { kind: "loading" } });
    }

    const [artifacts, allowlist] = await Promise.all([
      this.#readArtifacts(sessionId),
      this.#readAllowlist(sessionId),
    ]);
    if (generation !== this.#generation) {
      return;
    }
    // ONE SNAPSHOT, BOTH LEGS. Publishing each leg as it lands would let a snapshot
    // hold a list from one refresh beside an allow-list from another.
    this.#publish({ artifacts, allowlist });
  }

  async #readArtifacts(sessionId: string): Promise<ArtifactsPanelState> {
    const answer = await this.#bridge.growth.artifactList({ sessionId });
    if (answer.status === "unavailable") {
      return { kind: "refused", refusal: answer };
    }
    // Served. `listed` with an empty array is a DIFFERENT arm from `not-checked` and
    // the reply's own length is what decides between them — a read that found none is
    // not a read nobody made.
    return { kind: "listed", rows: answer.value.map(artifactManifestRowFromSummary) };
  }

  async #readAllowlist(sessionId: string): Promise<ArtifactAllowlistReading> {
    const answer = await this.#bridge.growth.artifactAllowlistRead({ sessionId });
    if (answer.status === "unavailable") {
      return { ...SHIPPED_DEFAULT_ALLOWLIST, refusal: answer };
    }
    return {
      source: "effective",
      mediaTypes: answer.value.contentTypes,
      maximumByteLength: answer.value.maximumByteLength,
      refusal: undefined,
    };
  }

  #publish(reading: ArtifactPaneReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/** One sentence about a thrown value, without putting the value itself on screen. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : "the read threw a value that is not an error.";
}

/** What the hook hands the pane: the reading, and the one act that re-reads. */
export interface ArtifactPaneBinding {
  readonly reading: ArtifactPaneReading;
  readonly refresh: () => void;
}

/**
 * Bind one pane to its reader.
 *
 * Constructed in a hook and never in a render body, read through
 * `useSyncExternalStore` so a publish is one transition, and disposed on unmount.
 */
export function useArtifactPaneReading(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): ArtifactPaneBinding {
  const reader = useMemo(() => new ArtifactPaneReader({ bridge, sessionId }), [bridge, sessionId]);
  useEffect(() => {
    reader.start();
    return () => {
      reader.dispose();
    };
  }, [reader]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback(() => reader.snapshot, [reader]);
  const reading = useSyncExternalStore(subscribe, read, read);
  const refresh = useCallback(() => {
    reader.refresh();
  }, [reader]);
  return { reading, refresh };
}
