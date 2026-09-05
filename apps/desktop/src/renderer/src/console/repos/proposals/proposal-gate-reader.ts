// What one execution root's change-proposal gate READ, who asked for it, and when it
// asks again.
//
// `ProposalGate.tsx` renders and does not read; this is the half that reads,
// `proposal-gate-actions.ts` is the half that acts, and `proposal-gate-binding.ts` is
// the half that holds one of these beside a component. One reader holds one root's
// gate state, so the two roots of a two-agent session carry two independent gates and
// neither can publish the other's refusal.
//
// THE ACTS ARE NEXT DOOR, AND THIS CLASS IS THEIR HOST. `requestAction` delegates to
// `ProposalGateActions`, which is handed the seven operations `ProposalGateActionHost`
// names and nothing else: the standing reading, the served context, the caller's own
// participant id, the publish, the two writes to the held proposal, and the refresh an
// accepted act asks for. So an act cannot start a read and this class cannot decide
// what an act sends.
//
// THE CALLER-IDENTITY READ IS `caller-participant-read.ts`, HELD HERE. An act carries
// the participant who pressed it as the registered request's `causationParticipantId`,
// which is a read — but a lazy, unscheduled, unpublished one, so it is that module's and
// this class holds one of them and hands its answer through the act seam.
//
// EVERY READ GOES THROUGH THE CONSOLE'S ONE SCHEDULER, AND EVERY REASON THROUGH ONE
// TRIGGER CLASS. `Spec-023 §Rules every console surface obeys` fixes the policy —
// "Reads happen on subscribe, on window focus, on reconnect, and on the terminal events
// the owning spec names", under "No interval polling" — so this class arms no timer of
// its own and owns no listener of
// its own either: it builds a `RepoRefreshTriggers` over its own scheduler exactly as
// `repo-mounts-reader.ts` beside it does, which is what makes all four reasons reach
// a gate rather than only window focus. A daemon that reconnected, or a `workspace.stale`
// frame arriving in an already-focused window, used to leave the branch context and
// the prepared proposal standing with `push` still offered against them.
//
// The reader supplies one terminal event of its own beside the section's `workspace.stale`
// one: an act the daemon accepted, which the acts ask for through the host because they
// are the only observer of that act.
//
// NOT EVERY ROOT CAN BE ASKED ABOUT, AND THE ONES THAT CANNOT SAY SO. A gate is built
// for any of the three writable execution roots, and only one of them has a key the
// registered request takes: `proposal-gate-model.ts` resolves that once per reader as a
// read plan, an `unaddressable` plan publishes `not-checked` carrying its own reason,
// and no call is made and no refresh trigger is armed for it. The alternative was the
// one this family refuses everywhere else — asking under a key the read does not
// take, and rendering whatever came back as a reading.
//
// ALL THREE OPERATIONS ARE GROWTH-PORT OPERATIONS, AND ALL THREE ARE UNREGISTERED.
// `bridge/growth-signatures.ts` carries the branch-context read, the preparation
// call, and the git action under one `gitflow-actions` slate row that `Spec-011`
// owns, and the live bridge refuses each of them by name. So the ordinary arm on a
// release build is `not-checked` carrying the port's own sentence — never an empty
// gate, and never a gate that looks prepared because nothing came back.
//
// A SERVED REPLY IS A CONTEXT, AND "THERE IS NONE" IS A REFUSAL. The registered
// `BranchContextReadResponse` returns the context's fields directly, so there is no
// envelope member for an absence to ride: a `(workspace, worktree)` pair that resolves
// no row refuses on that wire, and the daemon's own sentence lands on the `refused`
// arm. This reader therefore publishes no "no context" state of its own — the arm it
// used to publish whenever an envelope member was absent, which a contract-shaped
// reply made true on every single read.
//
// WHAT NO READ CAN PUBLISH is recorded on the arms themselves, in
// `proposal-gate-state.ts`: three things a registered reply names nowhere.

import type { ConsoleBridge } from "../../bridge/index.js";
import { CallerParticipantRead } from "./caller-participant-read.js";
import { Emitter, refuse, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import { RefreshScheduler, type SessionStore } from "../../store/index.js";
import type { BranchContextReading } from "../mounts/branch-context-model.js";
import { ProposalGateActions } from "./proposal-gate-actions.js";
import type { ProposalGateActionHost } from "./proposal-gate-action-host.js";
import {
  GATE_SETTLEMENT_COPY,
  NOTHING_ASKED_GATE_READING,
  PROPOSAL_GATE_REFUSAL_ORIGIN,
  SUBJECT_NOT_ADDRESSABLE,
  branchContextReadPlanFor,
  branchContextReadingFrom,
  type BranchContextReadPlan,
  type ProposalGateReading,
  type ProposalGateSubject,
} from "./proposal-gate-model.js";
import {
  proposalContextKeyOf,
  proposalContextKeysMatch,
  type PreparedProposal,
  type ProposalContextKey,
} from "./prepared-proposal.js";
import type { ProposalAction } from "./proposal-actions.js";
import { repoCallRefusal } from "../repo-reads.js";
import { RepoRefreshTriggers } from "../mounts/repo-refresh-triggers.js";

/**
 * Re-exported from the module that declares it, because every importer names it here.
 *
 * The declaration sits in `proposal-gate-model.ts` so the reader and the acts can both
 * publish one without importing each other; this line is what keeps that move invisible
 * to `proposal-gate-binding.ts` and `ProposalGateDisclosure.tsx`, which read the gate's
 * value through the object that produces it.
 */
export type { ProposalGateReading };

/** The wire this reader asks on, named once so a refusal can say which call failed. */
const BRANCH_CONTEXT_READ_CALL = "gitflow.branchContextRead";

export interface ProposalGateReaderOptions {
  readonly bridge: ConsoleBridge;
  readonly subject: ProposalGateSubject;
  /** The session whose repair edge and whose frames are two of the three reasons to re-read. */
  readonly sessionStore: SessionStore;
  /**
   * The clock this gate's reads are scheduled on. Supplied, never defaulted.
   *
   * REQUIRED FOR `repo-mounts-reader.ts`'s REASON: `consoleClockFor` is the one answer
   * to which clock a window runs on, and a gate that fell back to a `RealClock` of its
   * own would coalesce its refresh window on wall time while the section it is mounted
   * inside advanced on the scenario's frozen clock. A reader without a clock is a
   * construction error rather than a reader on the machine's clock.
   */
  readonly clock: ConsoleClock;
}

export class ProposalGateReader {
  readonly #bridge: ConsoleBridge;
  readonly #subject: ProposalGateSubject;
  /** The session the caller-identity read is asked under. The store's own, never minted. */
  /** Resolved once: whether this root can be asked about, and with what. */
  readonly #readPlan: BranchContextReadPlan;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: RepoRefreshTriggers;
  readonly #actions: ProposalGateActions;
  readonly #callerParticipant: CallerParticipantRead;
  readonly #changes = new Emitter<ProposalGateReading>("proposal gate reading");

  #reading: ProposalGateReading = NOTHING_ASKED_GATE_READING;
  /**
   * The served context, held so an act can name the id and the branch it targets.
   *
   * Held beside the reading rather than read back out of it, because only the
   * `prepared` arm carries one and an act must not have to narrow an arm to find the
   * id it was given.
   */
  #context: BranchContextReading | undefined;
  #proposal: PreparedProposal | undefined;
  /** The context the held proposal was prepared AGAINST. `prepared-proposal.ts` says why. */
  #proposalPreparedFor: ProposalContextKey | undefined;
  /** `preparing` is entered once. A refresh redraws the answer, never the wait. */
  #hasEnteredPreparing = false;
  #started = false;
  #disposed = false;

  public constructor(options: ProposalGateReaderOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#readPlan = branchContextReadPlanFor(options.subject);
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
      },
      // A read that threw past its own refusal handling lands in the reading as the
      // `refused` arm. Re-throwing into a timer callback reaches nobody, and
      // swallowing would leave a gate showing the wait it never came out of.
      // The daemon's own refusal, normalized rather than stringified. A scripted or
      // live rejection arrives as the wire's `{code, message}` envelope, which is not
      // an `Error` — so a bare `String(error)` printed `[object Object]` on exactly
      // the path that now carries "this workspace has no branch context".
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          state: {
            kind: "refused",
            message: repoCallRefusal(BRANCH_CONTEXT_READ_CALL, error).detail,
          },
          refusal: undefined,
          settlement: GATE_SETTLEMENT_COPY.refused,
        });
      },
    });
    // The three reasons to read again. They reach this reader only through the scheduler.
    this.#triggers = new RepoRefreshTriggers({
      scheduler: this.#scheduler,
      sessionStore: options.sessionStore,
    });
    this.#callerParticipant = new CallerParticipantRead({
      bridge: options.bridge,
      sessionId: options.sessionStore.sessionId,
    });
    this.#actions = new ProposalGateActions({
      bridge: options.bridge,
      // The mount, because that is the one identity the registered git-action request
      // takes. Which root inside it an act runs in is said in the request's `params`,
      // off the context this reader served.
      repoMountId: options.subject.repoMountId,
      host: this.#actionHost(),
    });
  }

  /** What this gate renders right now. Stable identity between publishes. */
  public get snapshot(): ProposalGateReading {
    return this.#reading;
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  public subscribe(sink: (reading: ProposalGateReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Begin reading, and keep listening for the reasons to read again.
   *
   * Idempotent for `repo-mounts-reader.ts`'s reason: React mounts an effect twice in
   * development strict mode, and a gate that armed twice would double every read in
   * exactly the environment where the budget is being watched.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    if (this.#readPlan.kind === "unaddressable") {
      // NOTHING TO SCHEDULE AND NOTHING TO RE-READ. There is no arm of the registered
      // request this root can fill, so a focus, a reconnect, and a `workspace.stale`
      // frame would all produce the same answer — and producing it costs a read burst
      // each time. The arm is published once, here, and this reader arms no timer and
      // no listener at all.
      this.#publishUnaddressable(this.#readPlan.reason);
      return;
    }
    this.#scheduler.request("subscribe");
    this.#triggers.start();
  }

  /**
   * Send one of the three modelled acts.
   *
   * Delegated whole to `proposal-gate-actions.ts`, which owns the register, the
   * settlement rule, and every refusal an act can produce. The method stays on this
   * class because the reader is the one object a surface holds — a binding that had to
   * reach a second object to press a control would put the gate's own composition into
   * every caller.
   */
  public async requestAction(action: ProposalAction): Promise<void> {
    await this.#actions.request(action);
  }

  /** Terminal. No later event can re-arm a read behind a gate that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    // The acts are disposed too, so a call still in flight settles into nothing rather
    // than into a register whose surface has gone.
    this.#actions.dispose();
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  /**
   * This reader's half of the act seam, as the one object the acts are given.
   *
   * AN ADAPTER RATHER THAN A PUBLIC `implements` CLAUSE, because every member writes
   * state this class owns — `publish` alone would let any caller put an arbitrary
   * reading on the gate — and implementing the port on the class would have to make
   * all six public to do it. The port stays one declaration, the acts stay unable to
   * reach anything it does not name, and this class's public surface is what it was.
   */
  #actionHost(): ProposalGateActionHost {
    return {
      currentReading: () => this.#reading,
      servedContext: () => this.#context,
      callerParticipantId: async () => await this.#callerParticipant.read(),
      publish: (reading: ProposalGateReading) => {
        this.#publish(reading);
      },
      holdPreparedProposal: (proposal: PreparedProposal, preparedFor: BranchContextReading) => {
        this.#proposal = proposal;
        this.#proposalPreparedFor = proposalContextKeyOf(preparedFor);
      },
      discardProposal: () => {
        this.#discardProposal();
      },
      requestRefreshAfterAct: () => {
        this.#scheduler.request("terminal-event");
      },
    };
  }

  async #performRead(): Promise<void> {
    const plan = this.#readPlan;
    if (plan.kind === "unaddressable") {
      // `start` short-circuits before scheduling one of these, so this is reached only
      // if some other path asks for a read. It publishes the same honest arm rather
      // than returning silently, which would leave a gate showing whatever it showed.
      this.#publishUnaddressable(plan.reason);
      return;
    }
    if (!this.#hasEnteredPreparing) {
      this.#hasEnteredPreparing = true;
      this.#publish({ ...this.#reading, state: { kind: "preparing" }, refusal: undefined });
    }

    const outcome = await this.#bridge.growth.gitflowBranchContextRead(plan.request);
    if (this.#disposed) {
      return;
    }

    if (outcome.status === "unavailable") {
      this.#context = undefined;
      this.#discardProposal();
      // The port's two refusal classes are two different facts and get two different
      // arms. `wire-unregistered` means the question could not be put at all, which
      // is `not-checked` — and that arm carries no message, so the refusal travels
      // beside it. A scripted reply that never arrived means the question WAS put and
      // the answer did not come, which is a failure the `refused` arm states.
      if (outcome.code === "wire-unregistered") {
        this.#publish({
          ...this.#reading,
          state: { kind: "not-checked" },
          refusal: outcome,
          settlement: outcome.detail,
        });
        return;
      }
      this.#publish({
        ...this.#reading,
        state: { kind: "refused", message: outcome.detail },
        refusal: undefined,
        settlement: GATE_SETTLEMENT_COPY.refused,
      });
      return;
    }

    // A SERVED REPLY IS A CONTEXT. `BranchContextReadResponse` is flat and carries no
    // member on which "there is none" could ride: a `(workspace, worktree)` pair that
    // resolves no row REFUSES, and that refusal lands on the arm above carrying the
    // daemon's own sentence. So there is nothing to test for here, and the arm this
    // reader used to publish for an absent envelope member — which a contract-shaped
    // reply produced on every read — is gone with the envelope.
    const context = branchContextReadingFrom(outcome.value, this.#subject.executionMode);
    this.#context = context;
    // A REFRESHED CONTEXT NEVER CARRIES A PROPOSAL PREPARED FOR A DIFFERENT ONE. An
    // external checkout or a repair can move the base or the head between reads, and a
    // proposal on this arm is exactly what offers the remote act — so a mismatch
    // discards it rather than publishing it beside a context it was not built against.
    if (
      this.#proposalPreparedFor !== undefined &&
      !proposalContextKeysMatch(this.#proposalPreparedFor, context)
    ) {
      this.#discardProposal();
    }
    const proposal = this.#proposal;
    this.#publish({
      ...this.#reading,
      state: {
        kind: "prepared",
        context,
        ...(proposal === undefined ? {} : { proposal }),
      },
      refusal: undefined,
      settlement:
        proposal === undefined
          ? GATE_SETTLEMENT_COPY.prepared
          : GATE_SETTLEMENT_COPY["prepared-with-proposal"],
    });
  }

  /**
   * Say that this root cannot be asked about, and why.
   *
   * `not-checked` and never `refused`: the question was not PUT, which is a different
   * fact from a daemon that refused one — and the arm carries no message of its own, so
   * the reason travels beside it as the refusal the surface renders. The refusal is the
   * reader's own, because nothing refused it: no call was made.
   */
  #publishUnaddressable(reason: string): void {
    this.#context = undefined;
    this.#discardProposal();
    this.#publish({
      ...this.#reading,
      state: { kind: "not-checked" },
      refusal: refuse(PROPOSAL_GATE_REFUSAL_ORIGIN, SUBJECT_NOT_ADDRESSABLE, reason),
      settlement: reason,
    });
  }

  /** Drop the held proposal and the context it was prepared for, which are one fact. */
  #discardProposal(): void {
    this.#proposal = undefined;
    this.#proposalPreparedFor = undefined;
  }

  #publish(reading: ProposalGateReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
