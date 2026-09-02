// What one worktree's change-proposal gate knows, who asked for it, and when it asks
// again.
//
// `ProposalGate.tsx` renders and does not read; this is the half that reads. One
// reader holds one worktree's gate state, so the two roots of a two-agent session
// carry two independent gates and neither can publish the other's refusal.
//
// EVERY READ GOES THROUGH THE CONSOLE'S ONE SCHEDULER. `Spec-023 §Console Design
// (Meridian)` §10.1 fixes the policy in a sentence — on panel focus, on reconnect,
// and on a `workspace.stale` frame, with no interval polling — so this class arms no
// timer of its own and re-reads on exactly the reasons `repo-mounts-reader.ts` beside
// it re-reads on: the first subscribe, a window focus, and the terminal event of an
// act the daemon accepted.
//
// ALL THREE OPERATIONS ARE GROWTH-PORT OPERATIONS, AND ALL THREE ARE UNREGISTERED.
// `bridge/growth-signatures.ts` carries the branch-context read, the preparation
// call, and the git action under one `gitflow-actions` slate row that `Spec-011`
// owns, and the live bridge refuses each of them by name. So the ordinary arm on a
// release build is `not-checked` carrying the port's own sentence — never an empty
// gate, and never a gate that looks prepared because nothing came back.
//
// WHAT THIS READER DELIBERATELY CANNOT PUBLISH, AND WHY IT IS A WIRE FACT
//
//   • `hosting-unavailable`. The arm needs a bundle path and a preparation state that
//     names the outage. The preparation reply carries `prPreparationId`, a state
//     closed at `draft | ready`, and an untyped blob — and the blob is display data
//     the console may never read as an instruction (`proposal-model.ts`), so there is
//     no honest route to the arm at all. Publishing it from a `draft` reply would
//     report an outage nothing observed; publishing a bundle path would invent a
//     filesystem location. The arm stays drawable for a caller that CAN state it.
//   • A `status` reading. The three trichotomies are facts about a proposal that
//     exists ON A HOST, and nothing in this console has talked to one — the
//     preparation call is explicitly the step before any remote mutation.
//   • `detectedHost`, `title`, `body`, `trailers`, `changedPaths`. Each is optional on
//     the shapes it belongs to, for the reason recorded there, and this reader
//     supplies exactly the ones a reply named.
//
// THE TARGET BRANCH IS THE CONTEXT'S AND NEVER A SELECTION. §10.7 forbids inferring
// base or head from a pane, a tab, or a focused view; the preparation call's
// `targetBranch` is therefore read off the served context's `baseBranch` and there is
// no parameter on this class through which a selection could reach it — the same
// prohibition `ProposalGate.tsx` makes structural on its own side.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import {
  Emitter,
  RealClock,
  refuse,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../core/index.js";
import { RefreshScheduler } from "../store/index.js";
import type { BranchContextReading } from "./branch-context-model.js";
import {
  GATE_SETTLEMENT_COPY,
  PROPOSAL_GATE_REFUSAL_ORIGIN,
  branchContextReadingFrom,
  type ProposalGateRefusalCode,
  type ProposalGateSubject,
} from "./proposal-gate-model.js";
import type { PreparedProposal, ProposalAction, ProposalGateState } from "./proposal-model.js";

/**
 * Everything one worktree's gate renders from, in one immutable value.
 *
 * `refusal` is a FIELD rather than a seventh arm because two of the six arms carry no
 * message of their own: `not-checked` is the arm a wire-unregistered refusal produces
 * and it says nothing about which wire, so the refusal travels beside it and the
 * surface renders it through the same `RefusalCard` the repos section uses for a
 * refused mount list. An arm that DOES carry its message — `refused` — leaves this
 * field undefined, so the same sentence is never printed twice.
 */
export interface ProposalGateReading {
  readonly state: ProposalGateState;
  /** The read's own failure, where the published arm admits no message. */
  readonly refusal: ConsoleRefusal | undefined;
  /** What the last press of each act produced. Rendered beside the control pressed. */
  readonly actionRefusals: ReadonlyMap<ProposalAction, ConsoleRefusal>;
  /**
   * One sentence naming what this gate settled on, or `undefined` before it has.
   *
   * Composed here rather than in the component so the announcement and the arm cannot
   * disagree: the sentence is a function of the same publish that moved the arm, and a
   * surface that announced from its own render body would speak once per render.
   */
  readonly settlement: string | undefined;
}

const NOTHING_ASKED: ProposalGateReading = {
  state: { kind: "not-checked" },
  refusal: undefined,
  actionRefusals: new Map(),
  settlement: undefined,
};

export interface ProposalGateReaderOptions {
  readonly bridge: ConsoleBridge;
  readonly subject: ProposalGateSubject;
  /** Injected so a test drives every read on frozen time with no real timers. */
  readonly clock?: ConsoleClock;
}

export class ProposalGateReader {
  readonly #bridge: ConsoleBridge;
  readonly #subject: ProposalGateSubject;
  readonly #scheduler: RefreshScheduler;
  readonly #changes = new Emitter<ProposalGateReading>("proposal gate reading");

  #reading: ProposalGateReading = NOTHING_ASKED;
  /**
   * The served context, held so an act can name the id and the branch it targets.
   *
   * Held beside the reading rather than read back out of it, because only the
   * `prepared` arm carries one and an act must not have to narrow an arm to find the
   * id it was given.
   */
  #context: BranchContextReading | undefined;
  #proposal: PreparedProposal | undefined;
  /** `preparing` is entered once. A refresh redraws the answer, never the wait. */
  #hasEnteredPreparing = false;
  #started = false;
  #disposed = false;
  #detachWindowFocus: (() => void) | undefined;

  public constructor(options: ProposalGateReaderOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock ?? new RealClock(),
      perform: async () => {
        await this.#performRead();
      },
      // A read that threw past its own refusal handling lands in the reading as the
      // `refused` arm. Re-throwing into a timer callback reaches nobody, and
      // swallowing would leave a gate showing the wait it never came out of.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          state: { kind: "refused", message: rejectionText(error) },
          refusal: undefined,
          settlement: GATE_SETTLEMENT_COPY.refused,
        });
      },
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
    this.#scheduler.request("subscribe");
    if (typeof window === "undefined") {
      return;
    }
    const onWindowFocus = (): void => {
      this.#scheduler.request("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    this.#detachWindowFocus = () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }

  /**
   * Send one of the three modelled acts.
   *
   * `prepare-proposal` goes to the preparation call, which mutates nothing remote;
   * the other two go to the git action the port already carries. A refused act
   * publishes beside the control that was pressed and changes no arm — the act did
   * not happen, so the gate still reports what it last read. An accepted act
   * re-reads, because what the act changed is what the next read will say.
   */
  public async requestAction(action: ProposalAction): Promise<void> {
    const context = this.#context;
    if (context === undefined) {
      // Structurally unreachable from the gate, which offers acts only on the
      // `prepared` arm — and recorded rather than dropped, because a press that
      // produced nothing at all is the silent no-op rule 8 forbids.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "no-served-context" satisfies ProposalGateRefusalCode,
          "This gate has read no branch context, so there is nothing to act on.",
        ),
      );
      return;
    }
    if (action === "prepare-proposal") {
      await this.#prepareProposal(context);
      return;
    }
    await this.#executeGitAction(action);
  }

  /** Terminal. No later event can re-arm a read behind a gate that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#detachWindowFocus?.();
    this.#detachWindowFocus = undefined;
    this.#changes.clear();
  }

  async #prepareProposal(context: BranchContextReading): Promise<void> {
    const outcome = await this.#bridge.growth.gitflowPrPrepare({
      branchContextId: context.branchContextId,
      // The context's own base branch, never a selection: there is no parameter on
      // this class through which one could arrive.
      targetBranch: context.baseBranch,
    });
    if (this.#disposed) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#recordActionRefusal("prepare-proposal", outcome);
      return;
    }
    this.#proposal = {
      baseBranch: context.baseBranch,
      headBranch: context.headBranch,
      state: outcome.value.state,
      blob: outcome.value.proposalBlob,
    };
    // Re-read rather than publish the proposal beside a context this call did not
    // re-establish: one read is the source of the arm, so the proposal joins the arm
    // the next read publishes and the console holds no second copy of the context.
    this.#scheduler.request("terminal-event");
  }

  async #executeGitAction(action: ProposalAction): Promise<void> {
    const outcome = await this.#bridge.growth.gitActionExecute({
      workspaceId: this.#subject.workspaceId,
      action,
    });
    if (this.#disposed) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#recordActionRefusal(action, outcome);
      return;
    }
    if (!outcome.value.accepted) {
      // A served answer that did not take the act. Rendered rather than treated as a
      // success: the wire said `accepted: false`, and the sentence says exactly that
      // rather than guessing at a reason the reply does not carry.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "action-not-accepted" satisfies ProposalGateRefusalCode,
          `The daemon answered this action without accepting it. Nothing was ${action === "commit" ? "recorded" : "sent"}.`,
        ),
      );
      return;
    }
    this.#scheduler.request("terminal-event");
  }

  async #performRead(): Promise<void> {
    if (!this.#hasEnteredPreparing) {
      this.#hasEnteredPreparing = true;
      this.#publish({ ...this.#reading, state: { kind: "preparing" }, refusal: undefined });
    }

    const outcome = await this.#bridge.growth.gitflowBranchContextRead({
      workspaceId: this.#subject.workspaceId,
      worktreeId: this.#subject.worktreeId,
    });
    if (this.#disposed) {
      return;
    }

    if (outcome.status === "unavailable") {
      this.#context = undefined;
      this.#proposal = undefined;
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

    const branchContext = outcome.value.branchContext;
    if (branchContext === undefined) {
      this.#context = undefined;
      this.#proposal = undefined;
      this.#publish({
        ...this.#reading,
        state: { kind: "no-context", executionMode: this.#subject.executionMode },
        refusal: undefined,
        settlement: GATE_SETTLEMENT_COPY["no-context"],
      });
      return;
    }

    const context = branchContextReadingFrom(branchContext, this.#subject.executionMode);
    this.#context = context;
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

  #recordActionRefusal(action: ProposalAction, refusal: ConsoleRefusal): void {
    const actionRefusals = new Map(this.#reading.actionRefusals);
    actionRefusals.set(action, refusal);
    this.#publish({ ...this.#reading, actionRefusals });
  }

  #publish(reading: ProposalGateReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/** What a thrown read says, without asserting a shape the throw may not have. */
function rejectionText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the hook hands a surface: the reading, and the one act it sends. */
export interface ProposalGateBinding {
  readonly reading: ProposalGateReading;
  readonly requestAction: (action: ProposalAction) => void;
}

/**
 * Bind one worktree's gate to its reader.
 *
 * The reader is constructed in a hook and never in a render body, subscribed through
 * `useSyncExternalStore` so a publish is a single transition, and disposed on unmount
 * — the three properties `apps/desktop/AGENTS.md` requires of anything holding state
 * beside a component. The subject is destructured into the dependency list rather
 * than depended on as an object, because a caller composing it inline would otherwise
 * mint a new reader on every render.
 */
export function useProposalGate(
  bridge: ConsoleBridge,
  subject: ProposalGateSubject,
): ProposalGateBinding {
  const { workspaceId, worktreeId, executionMode } = subject;
  const reader = useMemo(
    () => new ProposalGateReader({ bridge, subject: { workspaceId, worktreeId, executionMode } }),
    [bridge, workspaceId, worktreeId, executionMode],
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
  const requestAction = useCallback(
    (action: ProposalAction) => {
      void reader.requestAction(action);
    },
    [reader],
  );
  return { reading, requestAction };
}
