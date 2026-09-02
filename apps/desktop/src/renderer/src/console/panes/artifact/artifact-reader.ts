// What the artifact pane knows, who asked for it, and what it refuses to invent.
//
// `Spec-023 §Console Design (Meridian)` §10.4. Two reads, both on `Plan-023 §Console
// growth slate` and both refused by name today: `artifactList` and `artifactRead`
// against `artifact-ingest-and-crud`, `artifactAllowlistRead` against
// `artifact-allowlist-and-abort`.
//
// THE ONE DECISION IN THIS FILE IS WHAT TO DO WITH A SERVED LIST. The growth port's
// `artifactList` answers `GrowthArtifactSummary` — `artifactId`, `name`, `byteLength`,
// `contentType` — and §10.4's row renders the MANIFEST ENVELOPE: `state`, `visibility`,
// `digest`, `replicationStatus`, `createdAt`, `annotations`, `subject`. Those are not
// the same value, and none of the missing members is derivable from the four that are
// present. So a served list is REFUSED with the console's own code rather than mapped:
// synthesising a `state` or a `visibility` would put a fact on screen that no read
// established, which is the one thing rule 8 forbids outright. The refusal names the
// gap so the day the shape lands the fix is a mapping and not an archaeology.
//
// NO TIMER AND NO POLL. The reads run once when the pane mounts and again when the
// participant asks, through the same act that asked the first time. `Spec-023`'s
// refresh rule allows focus, reconnect, and a stale frame; a pane that armed an
// interval would be spending the budget on a wire that refuses.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import {
  ATTACHMENT_ALLOWLIST_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
} from "../../repos/attachment-model.js";
import type { ArtifactsPanelState } from "../../repos/artifact-model.js";

/** The subsystem every refusal this module raises names as its author. */
export const ARTIFACT_READS_ORIGIN = "artifacts";

/**
 * The console's own code for a reply whose shape cannot become a manifest row.
 *
 * Console-owned and deliberately outside the `artifact.*` daemon namespace, on
 * `repo-reads.ts`'s rule: a daemon refusal keeps its code verbatim, and the console
 * names only the failures that are its own to describe.
 */
export const ARTIFACT_LIST_SHAPE_UNMAPPED_CODE = "list-shape-unmapped";

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
    // Served, and unmappable — see the header. The count is named because it is the one
    // true thing the reply carries, and stating it keeps the refusal from reading as
    // "the list failed" when what failed is the console's ability to render it.
    this.#publish({
      ...this.#reading,
      artifacts: {
        kind: "refused",
        refusal: refuse(
          ARTIFACT_READS_ORIGIN,
          ARTIFACT_LIST_SHAPE_UNMAPPED_CODE,
          `The artifact list answered with ${String(answer.value.length)} payload summaries rather than manifest rows. A row renders state, visibility, digest, replication status, and provenance, none of which a summary carries, and the console will not supply them from nothing.`,
        ),
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
