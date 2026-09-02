// Who asks the artifact pane's reads, when they are asked again, and what is refused.
//
// Three reads, all on `Plan-023 §Console
// growth slate` and all refused by name today: `artifactList` and `artifactRead`
// against `artifact-ingest-and-crud`, `artifactAllowlistRead` against
// `artifact-allowlist-and-abort`.
//
// THE ONE DECISION IN THIS FILE IS WHAT TO DO WITH A SERVED LIST, AND IT HAS CHANGED.
// The growth port's `artifactList` used to answer a four-member payload summary —
// `artifactId`, `name`, `byteLength`, `contentType` — while the row
// `repos/artifact-model.ts` builds renders the MANIFEST ENVELOPE, and none of the
// missing members was derivable from the four that
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
// what makes the discard explicit — every completion carries the stamp it was issued
// under, a completion whose stamp is no longer current is dropped, and the two legs of
// one generation publish as ONE snapshot rather than two.
//
// AND ALL FOUR OF THE REFRESH RULE'S REASONS ARE WIRED, not one. `Spec-023 §Rules
// every console surface obeys` allows subscribe, window focus, reconnect, and the
// terminal events the owning spec names — and this reader used to have the first and
// a participant's press and nothing else. A pane left open through a daemon reconnect,
// or through an `artifact.published` / `artifact.superseded` /
// `artifact.visibility_updated` frame, held a manifest list and an effective
// allow-list that were stale indefinitely and looked exactly like fresh ones. The
// other three reasons now reach the same scheduler through
// `store/refresh-triggers.ts`, which is the mechanism the repos section's two readers
// already use; the KINDS are this pane's own, because those three frames are what
// `Spec-006 §Artifact and Diff Publication (artifact_publication)` names as terminal
// for an artifact. A `workspace.stale` frame is deliberately not among them: it says a
// path went stale, which is a fact about a workspace and no evidence at all about this
// session's artifacts.
//
// Still no interval, and still no timer of this reader's own: a pane that armed one
// would be spending the budget on a wire that refuses.

import type { SessionEventType } from "@ai-sidekicks/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  Emitter,
  RealClock,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import {
  artifactManifestRowFromSummary,
  type ArtifactsPanelState,
} from "../../repos/artifact-model.js";
import { RefreshScheduler, SessionRefreshTriggers, type SessionStore } from "../../store/index.js";
import {
  NOTHING_READ_YET,
  SHIPPED_DEFAULT_ALLOWLIST,
  artifactPayloadReadingFrom,
  readFailureRefusal,
  withReplacedRow,
  withRowRefusal,
  withoutRow,
  withoutRowRefusal,
  type ArtifactAllowlistReading,
  type ArtifactDeleteOutcome,
  type ArtifactPaneReading,
  type ArtifactPayloadOutcome,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";

/**
 * The three frames this pane re-reads on.
 *
 * `satisfies SessionEventType` rather than bare strings: the type is the contract's
 * own census (`packages/contracts/src/event.ts`), so a kind renamed on the wire fails
 * to compile here instead of silently matching nothing for the life of the release.
 * All three, because each changes what one of this pane's two reads would answer — a
 * publish or a supersession changes the list, and a visibility update changes a row's
 * class, which is a member the row draws.
 */
const ARTIFACT_TERMINAL_EVENT_KINDS = [
  "artifact.published",
  "artifact.superseded",
  "artifact.visibility_updated",
] satisfies readonly SessionEventType[];

export interface ArtifactPaneReaderOptions {
  readonly bridge: ConsoleBridge;
  /**
   * The session to read, and three of the four reasons to read again.
   *
   * The STORE rather than a bare session id, on `repos/repo-mounts-reader.ts`'s
   * reason: the artifact frames and the repair edge that stands for reconnect are
   * both transitions of this object, and a reader handed only an id could observe
   * neither. The id is read off it, so the pane and the store can never name two
   * sessions.
   *
   * ABSENT on a bare route, where the deck has a pane and no session behind it — and
   * a reader that read anyway would have to invent a session id, so it reads nothing,
   * listens for nothing, and the pane renders the absence that says nobody asked.
   */
  readonly sessionStore: SessionStore | undefined;
  /** Injected so a test drives every read on frozen time with no real timers. */
  readonly clock?: ConsoleClock;
}

export class ArtifactPaneReader {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string | undefined;
  readonly #scheduler: RefreshScheduler;
  /** Absent on a bare route: with no session there is nothing to observe. */
  readonly #triggers: SessionRefreshTriggers | undefined;
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
    this.#sessionId = options.sessionStore?.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock ?? new RealClock(),
      perform: async () => {
        await this.#performRead();
      },
      // Swallowing is not an option, and re-throwing into a timer callback reaches
      // nobody, so a read that threw past its own refusal handling lands in the
      // reading as a refusal — the pane renders it instead of holding stale rows
      // behind a list that never answered.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          artifacts: { kind: "refused", refusal: readFailureRefusal(error) },
        });
      },
    });
    // The other three reasons to read again. They reach this reader only through the
    // scheduler, so a burst of frames still costs one read pair.
    this.#triggers =
      options.sessionStore === undefined
        ? undefined
        : new SessionRefreshTriggers({
            scheduler: this.#scheduler,
            sessionStore: options.sessionStore,
            terminalEventKinds: ARTIFACT_TERMINAL_EVENT_KINDS,
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
   * Read once, and keep listening for the reasons to read again.
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
    this.#triggers?.start();
  }

  /**
   * Read again, because a participant asked. The only other reason there is.
   *
   * Routed through the scheduler rather than performed here, so a second press inside
   * the coalescing window costs no second read pair and a press made while a read is
   * outstanding becomes the NEXT read rather than a parallel one.
   *
   * THE REASON IS `participant-request`, WHICH THE SET NOW NAMES. `RefreshReason`
   * (`store/scheduling.ts`) is a closed SIX-member set — subscribe, window-focus,
   * reconnect, terminal-event, gap-repull, participant-request — and the last of
   * those is exactly this press. This call used to request `subscribe`, because at
   * the time the set had five members and none of them was true: `subscribe` was the
   * one whose meaning was not FALSE, since the press asks for the same whole-pane
   * read the subscription asked for. That reasoning ends the moment the honest member
   * exists, and it has to end here rather than merely read oddly: a diagnostics trail
   * that recorded a person's press as a subscription would report a surface opening
   * that never opened, which is the fabricated reason that module's own doc forbids.
   */
  public refresh(): void {
    if (this.#disposed || this.#sessionId === undefined) {
      return;
    }
    this.#scheduler.request("participant-request");
  }

  /**
   * Re-read one artifact's manifest, and put what came back on its row.
   *
   * THIS ASKS FOR NO BYTES, WHICH IS WHY IT IS NOT A DOWNLOAD. `artifactRead` answers
   * a `GrowthArtifactRead` — the manifest NESTED beside a way to reach the payload —
   * and takes an `includePayload` request member, so the two halves of
   * `api-payload-contracts.md §Plan-014`'s `ArtifactReadResponse` are both on the
   * port. This call omits that member, which lands the reply on the DEFERRED arm: a
   * handle and no bytes. Fetching them is `fetchPayload` below — a second act, with
   * its own affordance and its own bound — and this one is a re-read of what a row
   * SAYS.
   *
   * So the served answer is used for the only thing this surface wants from it: the
   * `manifest` REPLACES the listed row, member for member, and any refusal standing
   * against that row clears, because the read just answered for it.
   *
   * A SUPERSEDED RE-READ IS DROPPED HERE, AND THAT ASYMMETRY WITH `deleteArtifact`
   * IS DELIBERATE. This read establishes what one row currently SAYS, and the
   * refresh that superseded it is already re-reading that same row from the list —
   * so the answer that lands is the fresher one either way and there is nothing to
   * reconcile. A delete establishes that the row is GONE, which no in-flight list
   * read can discover, which is why that one reconciles instead of returning.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    const generation = this.#generation;
    const answer = await this.#bridge.growth.artifactRead({ artifactId });
    if (generation !== this.#generation) {
      return { status: "superseded" };
    }
    if (answer.status === "unavailable") {
      return this.#recordRowRefusal(artifactId, answer);
    }
    this.#publish({
      ...this.#reading,
      // The reply NESTS the envelope beside the payload members, so the row is built
      // from `manifest` and not from the reply: a read is a manifest plus a way to
      // reach the bytes, and this surface renders the first of those two.
      artifacts: withReplacedRow(
        this.#reading.artifacts,
        artifactManifestRowFromSummary(answer.value.manifest),
      ),
      refusalByArtifactId: withoutRowRefusal(this.#reading.refusalByArtifactId, artifactId),
    });
    return { status: "settled" };
  }

  /**
   * Ask for one artifact's bytes, because the participant pressed for them.
   *
   * THE SAME METHOD AS `readManifest`, TOLD APART BY `includePayload`. That member is
   * the wire's own discriminator, so this is not a second operation and there is no
   * second refusal to register: one call, two requests, and the reply's own union says
   * which of the two served answers came back.
   *
   * EXPLICIT, ALWAYS, AND NEVER ON MOUNT. A payload is bounded only by the ingest cap,
   * so a fetch that ran because a pane opened would spend a hundred megabytes of
   * somebody's link on a surface they were passing through. It runs when it is asked
   * for and at no other time, which is why it is a control and not an effect.
   *
   * NOT ROUTED THROUGH THE SCHEDULER, and that asymmetry with the pane's two other
   * reads is the point: the scheduler coalesces the reads that RE-ESTABLISH the pane,
   * and a payload fetch establishes something the pane did not have. Coalescing it
   * with a list refresh would mean a refresh silently re-fetched bytes, which is the
   * automatic download this act exists to avoid.
   *
   * ONE AT A TIME, AND A SUPERSEDED ANSWER IS DROPPED. The reading holds one payload,
   * so a fetch that lands while the participant has asked for another artifact's would
   * put one artifact's bytes under another's name. The stamp answers that, and it
   * answers disposal in the same comparison.
   */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    const generation = this.#generation;
    this.#publish({ ...this.#reading, payload: { status: "fetching", artifactId } });
    const answer = await this.#bridge.growth.artifactRead({ artifactId, includePayload: true });
    if (generation !== this.#generation) {
      return { status: "superseded" };
    }
    if (answer.status === "unavailable") {
      this.#publish({
        ...this.#reading,
        payload: { status: "refused", artifactId, refusal: answer },
      });
      return { status: "refused", refusal: answer };
    }
    const payload = artifactPayloadReadingFrom(artifactId, answer.value);
    this.#publish({
      ...this.#reading,
      // The reply also carries the manifest, and it is used for what it is: a fresher
      // reading of the row this fetch was about. Dropping it would leave the row
      // stating what an older read said while the bytes beside it came from this one.
      artifacts: withReplacedRow(
        this.#reading.artifacts,
        artifactManifestRowFromSummary(answer.value.manifest),
      ),
      payload,
      refusalByArtifactId: withoutRowRefusal(this.#reading.refusalByArtifactId, artifactId),
    });
    return { status: "settled", payload };
  }

  /**
   * Delete one artifact, after the participant confirmed the consequence.
   *
   * A SERVED DELETE ESTABLISHES THREE FACTS, AND ALL THREE ARE READ. The reply is a
   * `GrowthArtifactDeleteReceipt` — `payloadDisposition`, `rePublishForeclosed`, and
   * `deletedAt`, every member required (`api-payload-contracts.md §Plan-014`) — and
   * this method used to discard it and publish only the removal, which left the
   * panel's receipt strip permanently unsupplied and its announcement saying the
   * reply carried no disposition. It carries one. The receipt goes onto the reading,
   * where the panel draws it and the pane announces it; the row goes off the list,
   * because leaving it would let a participant keep acting on a manifest the daemon
   * has already destroyed; and the list is read again.
   *
   * The re-read is `terminal-event` because that is what it is: an act completed
   * and what it changed is what the next read will say. It is the same reason
   * `repos/repo-mounts-reader.ts` gives its post-mutation re-read.
   *
   * A SERVED DELETE NEVER RETURNS WITHOUT RECONCILING, WHICH IS WHY DISPOSAL AND
   * SUPERSESSION ARE ASKED SEPARATELY HERE. `#generation` answers both questions at
   * once, and for this act they have opposite answers. A participant who confirms
   * Delete and then presses "Read again" bumps the generation, and the list read
   * that press starts can easily have observed the artifact BEFORE the daemon
   * destroyed it — so returning early on the bumped stamp left the destroyed
   * manifest on screen, republished by the racing read and still carrying its
   * controls, until somebody refreshed by hand. Disposal is `#disposed` and is the
   * only reason to publish nothing: no pane is behind this reader. A live reader
   * whose stamp merely moved still applies the removal and still schedules the
   * re-read, because the fact the answer established is true regardless of which
   * refresh was in flight, and that re-read is the thing that takes the row back
   * off the screen the racing list put it on.
   */
  public async deleteArtifact(artifactId: string): Promise<ArtifactDeleteOutcome> {
    const generation = this.#generation;
    const answer = await this.#bridge.growth.artifactDelete({ artifactId });
    if (answer.status === "unavailable") {
      // A refusal records an act that did NOT happen, so a stamp that moved under it
      // means the row it was about has since been re-read and the refusal has nothing
      // left to stand beside.
      if (generation !== this.#generation) {
        return { status: "superseded" };
      }
      this.#recordRowRefusal(artifactId, answer);
      return { status: "refused", refusal: answer };
    }
    if (this.#disposed) {
      return { status: "superseded" };
    }
    const receipt = answer.value;
    this.#publish({
      ...this.#reading,
      artifacts: withoutRow(this.#reading.artifacts, artifactId),
      lastDeleteReceipt: receipt,
      // A payload reading about the artifact just destroyed describes bytes that are
      // gone, so it goes with the row rather than sitting under a manifest the list
      // no longer holds.
      payload:
        this.#reading.payload.status !== "not-checked" &&
        this.#reading.payload.artifactId === artifactId
          ? { status: "not-checked" }
          : this.#reading.payload,
      refusalByArtifactId: withoutRowRefusal(this.#reading.refusalByArtifactId, artifactId),
    });
    this.#scheduler.request("terminal-event");
    return generation === this.#generation
      ? { status: "settled", receipt }
      : { status: "reconciling", receipt };
  }

  /** Terminal. No later completion, frame, or focus can reach a pane that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#scheduler.dispose();
    this.#triggers?.dispose();
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
    // hold a list from one refresh beside an allow-list from another. The row
    // refusals carry forward: a refusal records an ACT that did not happen, and a
    // read that did not re-attempt the act does not answer for it.
    this.#publish({
      artifacts,
      allowlist,
      // CLEARED BY THE LIST THAT FOLLOWS IT. The receipt is about a row this read has
      // just answered for — by not returning it — so a consequence left standing would
      // read as a fact about the list now on screen.
      lastDeleteReceipt: undefined,
      // The payload survives: it is about an artifact this read either returned or did
      // not, and either way nothing here re-fetched bytes to answer for it.
      payload: this.#reading.payload,
      refusalByArtifactId: this.#reading.refusalByArtifactId,
    });
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

  #recordRowRefusal(artifactId: string, refusal: ConsoleRefusal): ArtifactRowActOutcome {
    this.#publish({
      ...this.#reading,
      refusalByArtifactId: withRowRefusal(this.#reading.refusalByArtifactId, artifactId, refusal),
    });
    return { status: "refused", refusal };
  }

  #publish(reading: ArtifactPaneReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/** What the hook hands the pane: the reading, and the acts it can put to the port. */
export interface ArtifactPaneBinding {
  readonly reading: ArtifactPaneReading;
  readonly refresh: () => void;
  readonly readManifest: (artifactId: string) => Promise<ArtifactRowActOutcome>;
  readonly fetchPayload: (artifactId: string) => Promise<ArtifactPayloadOutcome>;
  readonly deleteArtifact: (artifactId: string) => Promise<ArtifactDeleteOutcome>;
}

/**
 * Bind one pane to its reader.
 *
 * Constructed in a hook and never in a render body, read through
 * `useSyncExternalStore` so a publish is one transition, and disposed on unmount.
 */
export function useArtifactPaneReading(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): ArtifactPaneBinding {
  const reader = useMemo(
    () => new ArtifactPaneReader({ bridge, sessionStore }),
    [bridge, sessionStore],
  );
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
  const readManifest = useCallback(
    (artifactId: string) => reader.readManifest(artifactId),
    [reader],
  );
  const fetchPayload = useCallback(
    (artifactId: string) => reader.fetchPayload(artifactId),
    [reader],
  );
  const deleteArtifact = useCallback(
    (artifactId: string) => reader.deleteArtifact(artifactId),
    [reader],
  );
  return { reading, refresh, readManifest, fetchPayload, deleteArtifact };
}
