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
//
// THE ACTS ARE NEXT DOOR, AND THIS CLASS IS THEIR HOST. `readManifest`, `fetchPayload`
// and `deleteArtifact` delegate to `ArtifactPaneActions`, which is handed the five
// operations `ArtifactActionHost` names and nothing else — three calls with three
// different concurrency rules, none of them this scheduler's. The methods stay on this
// class because the reader is the one object a surface holds: a binding that had to
// reach a second object to press a control would put the pane's own composition into
// every caller.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import { Emitter, RealClock, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import {
  artifactManifestRowFromSummary,
  type ArtifactsPanelState,
} from "../../repos/artifact-model.js";
import { RefreshScheduler, SessionRefreshTriggers, type SessionStore } from "../../store/index.js";
import { ArtifactPaneActions, type ArtifactActionHost } from "./artifact-actions.js";
import {
  NOTHING_READ_YET,
  SHIPPED_DEFAULT_ALLOWLIST,
  growthAnswerReading,
  readFailureRefusal,
  type ArtifactAllowlistReading,
  type ArtifactDeleteOutcome,
  type ArtifactPaneReading,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import type { ArtifactPayloadOutcome } from "./artifact-payload.js";

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
  readonly #actions: ArtifactPaneActions;
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
    this.#actions = new ArtifactPaneActions({ bridge: options.bridge, host: this.#actionHost() });
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
   * Delegated whole to `artifact-actions.ts`, which owns what the call sends and what
   * each answer writes. The three act methods stay on this class for the reason its
   * header gives: the reader is the one object a surface holds.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    return this.#actions.readManifest(artifactId);
  }

  /** Ask for one artifact's bytes. Single-flight; `artifact-actions.ts` says why. */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    return this.#actions.fetchPayload(artifactId);
  }

  /** Delete one artifact, after the participant confirmed the consequence. */
  public async deleteArtifact(artifactId: string): Promise<ArtifactDeleteOutcome> {
    return this.#actions.deleteArtifact(artifactId);
  }

  /** Terminal. No later completion, frame, or focus can reach a pane that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    // The acts are disposed too, so a fetch still in flight settles into nothing
    // rather than into a register whose surface has gone.
    this.#actions.dispose();
    this.#scheduler.dispose();
    this.#triggers?.dispose();
    this.#changes.clear();
  }

  /**
   * This reader's half of the act seam, as the one object the acts are given.
   *
   * AN ADAPTER RATHER THAN A PUBLIC `implements` CLAUSE, on
   * `repos/proposal-gate-reader.ts`'s reason: every member reads or writes state this
   * class owns — `publish` alone would let any caller put an arbitrary reading on the
   * pane — and implementing the port on the class would have to make all five public
   * to do it. The port stays one declaration, the acts stay unable to reach anything
   * it does not name, and this class's public surface is what it was.
   */
  #actionHost(): ArtifactActionHost {
    return {
      currentReading: () => this.#reading,
      publish: (reading: ArtifactPaneReading) => {
        this.#publish(reading);
      },
      scheduledReadGeneration: () => this.#generation,
      isDisposed: () => this.#disposed,
      requestRefreshAfterAct: () => {
        this.#scheduler.request("terminal-event");
      },
    };
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
    const answer = growthAnswerReading(
      "The artifact list",
      await this.#bridge.growth.artifactList({ sessionId }),
    );
    if (answer.status === "refused") {
      return { kind: "refused", refusal: answer.refusal };
    }
    // Read. `listed` with an empty array is a DIFFERENT arm from `not-checked` and
    // the reply's own length is what decides between them — a read that found none is
    // not a read nobody made.
    return { kind: "listed", rows: answer.value.map(artifactManifestRowFromSummary) };
  }

  /**
   * The deployment's own bounds, or the shipped defaults and why they are showing.
   *
   * THE REFUSAL IS A DESIGNED ARM OF THIS READING AND NOT A FAILURE OF IT. A
   * deployment that does not serve its bounds is the ordinary case on this build —
   * the wire is unregistered — so the hint falls back to what the console ships and
   * says which of the two a participant is looking at. Reading the refusal off the
   * reply's own shape is what keeps it on that arm: read as served, it took the
   * whole pane read down with a `TypeError` and reported the console as broken.
   */
  async #readAllowlist(sessionId: string): Promise<ArtifactAllowlistReading> {
    const answer = growthAnswerReading(
      "The attachment allow-list read",
      await this.#bridge.growth.artifactAllowlistRead({ sessionId }),
    );
    if (answer.status === "refused") {
      return { ...SHIPPED_DEFAULT_ALLOWLIST, refusal: answer.refusal };
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
