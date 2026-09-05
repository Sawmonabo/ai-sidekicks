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
// AND THE TWO LEGS OF ONE READ FAIL SEPARATELY, WHICH IS NOT THE SAME AS PUBLISHING
// SEPARATELY. They are joined so a snapshot never holds a list from one refresh beside
// an allow-list from another — but the join used to be over two calls that could
// REJECT, so a bridge that dropped only the bounds read took the whole refresh down:
// the scheduler's error handler marked `artifacts` refused, and a session's manifests
// and the allow-list's own fallback were both discarded because an unrelated read had
// no answer. Both legs live in `artifact-pane-reads.ts` now — what a served answer
// MEANS is a question about the wire and not about scheduling — and each goes through
// `readGrowthAnswer` (`growth-call.ts`), so a rejection becomes THAT leg's refusal
// before the join sees it, neither leg can reject, and a bounds outage costs exactly
// the bounds.
//
// THE ACTS ARE NEXT DOOR, AND THIS CLASS IS THEIR HOST. `readManifest`, `fetchPayload`
// and `deleteArtifact` delegate to `ArtifactPaneActions`, which is handed the five
// operations `ArtifactActionHost` names and nothing else — three calls with three
// different concurrency rules, none of them this scheduler's. The methods stay on this
// class because the reader is the one object a surface holds: a binding that had to
// reach a second object to press a control would put the pane's own composition into
// every caller.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import { Emitter, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import {
  GenerationLatch,
  RefreshScheduler,
  SessionRefreshTriggers,
  type SessionStore,
} from "../../store/index.js";
import { ArtifactPaneActions } from "./artifact-actions.js";
import { type ArtifactActionHost } from "./artifact-action-host.js";
import {
  NOTHING_READ_YET,
  type ArtifactDeleteOutcome,
  type ArtifactPaneReading,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import { readFailureRefusal } from "./artifact-pane-refusals.js";
import type { ArtifactPayloadOutcome } from "./artifact-payload.js";
import { readArtifactAllowlist, readArtifactList } from "./artifact-pane-reads.js";

/** The namespace every frame about an artifact is registered under. */
const ARTIFACT_EVENT_NAMESPACE_PREFIX = "artifact.";

/**
 * Every registered frame that names an artifact.
 *
 * DERIVED FROM THE CONTRACT'S OWN CENSUS rather than hand-listed, on
 * `repos/repo-refresh-triggers.ts`'s shape and for its reason: the three kinds this
 * used to spell out are a snapshot of a registry that grows, so a fourth
 * `artifact.*` kind — a retention sweep, a re-publication — would have reached this
 * pane and been ignored, with the list on screen going stale and nothing anywhere
 * saying why. `SESSION_EVENT_CATEGORY_BY_TYPE` is the canonical type registry and its
 * keys are the whole census, so a kind is watched the day it is registered and a kind
 * renamed stops matching nothing silently rather than compiling and doing so.
 *
 * THE SELECTOR IS THE NAMESPACE AND NOT THE CATEGORY, which is the question this pane
 * is actually asking. Both of its reads are about artifacts, so any frame that names
 * one changes what one of them would answer — while `artifact_publication`, the
 * category the three live in, also holds `diff.created`, `pr.prepared`, and
 * `pr.submitted`, which are publications of other entities and change neither read. It
 * deliberately does not infer a category from the prefix either, which
 * `packages/contracts/src/event.ts` warns against: a type's category is the registry's
 * to state, and this set never reads one.
 *
 * The annotation is explicit rather than inferred, because `isolatedDeclarations`
 * requires one on every exported binding.
 */
export const ARTIFACT_TERMINAL_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType) => eventType.startsWith(ARTIFACT_EVENT_NAMESPACE_PREFIX));

/**
 * The one key this pane's scheduled read is claimed under.
 *
 * ONE KEY AND NOT ONE PER ARTIFACT, because a scheduled read re-reads the whole list:
 * there is a single round in flight at a time and every act comparing against it is
 * asking the same question. The acts' own single flight is keyed by artifact id, in
 * `artifact-actions.ts`, and the header there says why the two registers are separate.
 */
const SCHEDULED_READ_KEY = "scheduled-read";

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
  /**
   * The clock this reader's scheduler and every stamp it publishes run on.
   *
   * REQUIRED, AND THE BINDING READS IT OFF THE BRIDGE. It used to default to a fresh
   * `RealClock`, so a pane composed under the fixture coalesced its reads against wall
   * time while the scenario advanced on frozen time — the two clocks racing inside one
   * window, with whichever ran first deciding what a screenshot caught.
   * `consoleClockFor` is the one answer to which clock a window runs on, and a default
   * here is what let a call site skip asking it.
   */
  readonly clock: ConsoleClock;
}

export class ArtifactPaneReader {
  readonly #bridge: ConsoleBridge;
  readonly #clock: ConsoleClock;
  readonly #sessionStore: SessionStore | undefined;
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
   * The console's one generation register rather than a counter of this file's own:
   * a read takes the key, so a completion asks whether its own round is still the one
   * the key is on. Superseded when a read starts AND when the reader is disposed, so
   * one question answers both "this answer was superseded" and "this answer outlived
   * its pane". A second boolean beside it would be two mechanisms for one question.
   */
  readonly #reads = new GenerationLatch();

  public constructor(options: ArtifactPaneReaderOptions) {
    this.#bridge = options.bridge;
    this.#clock = options.clock;
    // Stamped at construction rather than left at the declaration's own placeholder,
    // so every reading a surface can reach carries an instant somebody took.
    this.#reading = { ...NOTHING_READ_YET, readAtMilliseconds: this.#clock.now() };
    this.#sessionStore = options.sessionStore;
    this.#sessionId = options.sessionStore?.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
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

  /**
   * Whether this reader is still the right one for a render holding that store.
   *
   * ASKED RATHER THAN REMEMBERED, on `AttachmentCarrier.isDisposed`'s reason: the
   * binding that owns this reader's lifetime has exactly one question before it calls
   * `start()`, and a flag kept beside the reader would be a copy of what the reader
   * already knows.
   *
   * TWO CONJUNCTS, AND THEY ARE TWO DIFFERENT FACTS. A DISPOSED reader is terminal —
   * `start()` returns at once — and React's development double-mount produces exactly
   * one, by running the seam's disposal and then replaying the setup on the same
   * committed value; without this the pane would come back from that replay having
   * read nothing, forever. A reader built against a DIFFERENT store is not broken,
   * it is looking at a projection this render has replaced: the subject-scoped seam
   * keys on the artifact, which names its session and so cannot separate two readings
   * of one session, and a store rebuilt across a reconnect is exactly that. Both
   * answers mean the same act — mint a fresh reader — which is why one question
   * carries them.
   */
  public isCurrentFor(sessionStore: SessionStore | undefined): boolean {
    return !this.#disposed && this.#sessionStore === sessionStore;
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
    this.#reads.supersedeAll();
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
      scheduledReadClaim: () => this.#reads.currentClaim(this, SCHEDULED_READ_KEY),
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
    // A scheduled read always runs and always supersedes the one before it: the
    // rows it is about to re-read are the same rows, so the older answer has nothing
    // left to say about them.
    const readRound = this.#reads.supersedeAndClaim(this, SCHEDULED_READ_KEY);

    // ENTERED ONCE, NEVER RE-ENTERED. Rule 8 separates "a read is in flight" from
    // "nobody asked", and a refresh that dropped the rows back to the in-flight
    // absence would blank a surface that has an answer on it while it re-reads.
    if (!this.#hasEnteredLoading) {
      this.#hasEnteredLoading = true;
      this.#publish({ ...this.#reading, artifacts: { kind: "loading" } });
    }

    // NEITHER LEG CAN REJECT, so the join is a join and not a fuse: each read below
    // ends on its own refused reading, and one that did not answer says so beside a
    // sibling that did.
    const [artifacts, allowlist] = await Promise.all([
      readArtifactList(this.#bridge, sessionId),
      readArtifactAllowlist(this.#bridge, sessionId),
    ]);
    if (!readRound.isCurrent) {
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
      // Carried for the same reason, and it is the acts' register rather than this
      // read's: a row whose re-read is still on the wire is still holding its control,
      // and a publish that rebuilt the set would offer it back mid-flight.
      manifestReadInFlightArtifactIds: this.#reading.manifestReadInFlightArtifactIds,
      refusalByArtifactId: this.#reading.refusalByArtifactId,
    });
  }

  /**
   * Put one reading on the pane, stamped with the instant it was put there.
   *
   * THE STAMP IS TAKEN HERE AND NOWHERE ELSE. Every publish this reader makes — the
   * read's own pair, the scheduler's error arm, and all three acts through the action
   * host — comes through this method, so stamping here is what makes the instant a
   * property of the publish rather than of whichever producer remembered to take one.
   * A producer that spread a previous reading forward gets this publish's instant,
   * which is correct: the reading changed, and that is when.
   *
   * WHICH IS WHY THE PARAMETER OMITS IT. A producer cannot supply the stamp, so the
   * type does not ask it to — and one that spreads a stamped reading forward passes
   * through unchanged, because the member this method writes is written last.
   */
  #publish(reading: Omit<ArtifactPaneReading, "readAtMilliseconds">): void {
    const stamped: ArtifactPaneReading = { ...reading, readAtMilliseconds: this.#clock.now() };
    this.#reading = stamped;
    this.#changes.emit(stamped);
  }
}
