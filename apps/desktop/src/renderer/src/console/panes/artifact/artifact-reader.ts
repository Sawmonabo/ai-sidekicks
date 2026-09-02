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
// NO TIMER AND NO POLL. The reads run once when the pane mounts and again when the
// participant asks, through the same act that asked the first time. `Spec-023`'s
// refresh rule allows focus, reconnect, and a stale frame; a pane that armed an
// interval would be spending the budget on a wire that refuses.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  ATTACHMENT_BYTE_CAP_DEFAULT,
  Emitter,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
import {
  artifactManifestRowFromSummary,
  type ArtifactsPanelState,
} from "../../repos/artifact-model.js";

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

const NOTHING_READ_YET: ArtifactPaneReading = {
  artifacts: { kind: "not-checked" },
  allowlist: {
    source: "shipped-default",
    mediaTypes: ATTACHMENT_ALLOWLIST_DEFAULT,
    maximumByteLength: ATTACHMENT_BYTE_CAP_DEFAULT,
    refusal: undefined,
  },
};

export interface ArtifactPaneReaderOptions {
  readonly bridge: ConsoleBridge;
  /**
   * The session to read. ABSENT on a bare route, where the deck has a pane and no
   * session behind it — and a reader that read anyway would have to invent a session
   * id, so it reads nothing and the pane renders the absence that says nobody asked.
   */
  readonly sessionId: string | undefined;
}

export class ArtifactPaneReader {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string | undefined;
  readonly #changes = new Emitter<ArtifactPaneReading>("artifact pane reading");

  #reading: ArtifactPaneReading = NOTHING_READ_YET;
  #started = false;
  #disposed = false;

  public constructor(options: ArtifactPaneReaderOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
  }

  /** What the pane renders right now. Stable identity between publishes. */
  public get snapshot(): ArtifactPaneReading {
    return this.#reading;
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
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    void this.refresh();
  }

  /** Read again, because a participant asked. The only other reason there is. */
  public async refresh(): Promise<void> {
    if (this.#disposed || this.#sessionId === undefined) {
      return;
    }
    this.#publish({ ...this.#reading, artifacts: { kind: "loading" } });
    await Promise.all([this.#readArtifacts(this.#sessionId), this.#readAllowlist(this.#sessionId)]);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#changes.clear();
  }

  async #readArtifacts(sessionId: string): Promise<void> {
    const answer = await this.#bridge.growth.artifactList({ sessionId });
    if (this.#disposed) {
      return;
    }
    if (answer.status === "unavailable") {
      this.#publish({ ...this.#reading, artifacts: { kind: "refused", refusal: answer } });
      return;
    }
    // Served. `listed` with an empty array is a DIFFERENT arm from `not-checked` and
    // the reply's own length is what decides between them — a read that found none is
    // not a read nobody made.
    this.#publish({
      ...this.#reading,
      artifacts: {
        kind: "listed",
        rows: answer.value.map(artifactManifestRowFromSummary),
      },
    });
  }

  async #readAllowlist(sessionId: string): Promise<void> {
    const answer = await this.#bridge.growth.artifactAllowlistRead({ sessionId });
    if (this.#disposed) {
      return;
    }
    if (answer.status === "unavailable") {
      this.#publish({
        ...this.#reading,
        allowlist: {
          source: "shipped-default",
          mediaTypes: ATTACHMENT_ALLOWLIST_DEFAULT,
          maximumByteLength: ATTACHMENT_BYTE_CAP_DEFAULT,
          refusal: answer,
        },
      });
      return;
    }
    this.#publish({
      ...this.#reading,
      allowlist: {
        source: "effective",
        mediaTypes: answer.value.contentTypes,
        maximumByteLength: answer.value.maximumByteLength,
        refusal: undefined,
      },
    });
  }

  #publish(reading: ArtifactPaneReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
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
    void reader.refresh();
  }, [reader]);
  return { reading, refresh };
}
