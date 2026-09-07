// The new-session draft — a session that does not exist yet.
//
// THIS CONSOLE'S OWN RULE, because no committed document states it — `Spec-023 §Scope`
// leaves each surface's composition to "the console's own code and fixture scenarios":
// "+ New" creates a draft session placeholder with no daemon row, and the person picks
// agents (by definition), a repo mount and mode, a posture, and a paying account per
// agent. The first send coalesces `session.create`, one `agent.attach` per agent, and
// `run.queueCreate`; a draft that is closed empty reverts to nothing and leaves no row.
//
// WHAT IS HERE AND WHAT IS NEXT DOOR. This file owns what a person has CHOSEN and the
// coalescing that keeps one draft to one session. What those choices become on the
// wire, and what the result of sending them says, is `new-session-send.ts` — it holds
// no state, so its rules can be checked without constructing a draft.
//
// THREE PROPERTIES, AND EACH IS THE REASON THIS IS A CLASS RATHER THAN A FORM:
//
//   • **No daemon row until the first send.** Every selection lives in this
//     object's memory and nowhere else. `discard()` on an empty draft leaves
//     nothing behind — there is nothing to delete, which is the strongest form of
//     "leaves no row".
//   • **Nothing durable.** A draft is participant-authored content, and
//     `Spec-023 §Persistence on the renderer scheme` gives such content no durable home
//     in the renderer: "a draft lives in its window's in-memory store for that window's
//     lifetime, is gone when the window closes". `console/persistence/value-classes.ts`
//     is the enforcement; this module never reaches the persistence door.
//   • **A partial send is reported, never rolled back.** The rule above asks for the
//     calls that succeeded to be named and for the draft to stay editable. A renderer
//     cannot undo a `session.create` the daemon accepted, and pretending otherwise
//     would leave a real session the person believes was never made.
//
// ONE DRAFT OBJECT, AT MOST ONE SESSION — AND EACH CALL AT MOST ONCE. The three
// properties above make the draft editable after a send that only partly landed, which
// is what a person needs, and which means Send stays pressable with the same choices
// behind it. Without a memory of what a previous press already did, the next press
// would reach `session.create` again: a double-click would mint two daemon sessions,
// and a retry after the partial would mint a third, none of them the one the person is
// looking at. The same argument applies one leg down, which is why the memory is
// per-leg rather than one flag — a retry that re-attached a sidekick already on the
// session would put two agents there for one the person chose once, and one that
// re-queued the turn would send their words twice. So this class coalesces rather than
// refuses, on the deck writer's idiom: a send while one is in flight yields THAT send,
// and a later send resumes at the first call that has not been made. The invariant is
// scoped to the object, so closing the draft — which drops it — is what makes the next
// "+ New" a genuinely new session.
//
// THE FIRST TURN IS THE DRAFT'S, because the draft is what sends it. `run.queueCreate`
// is registered and callable and takes the turn's own body, so a draft holding agents,
// a mount and a posture and no words could not compose one — which is why this used to
// refuse the leg by name. A person composing a session says what it is for in the same
// act, and a first turn that is still blank is the one refusal here that is a CHOICE
// rather than a fact about the build: the session and its sidekicks exist, and nothing
// has been said yet.
//
// AUTO-PIN IS STILL ABSENT, and now for a reason that can be discharged rather than a
// wire that cannot: it fires on a first SUCCESSFUL send, whose five conjuncts include
// facts about how the session was opened that no reply here carries.

import type { ExecutionMode, ExecutionPosture } from "@ai-sidekicks/contracts";
import { type ConsoleBridge } from "../../bridge/index.js";
import { Emitter, type Unsubscribe } from "../../core/index.js";
import { refuseDraft, sendNewSessionDraft, type NewSessionSendResult } from "./new-session-send.js";

/**
 * The posture axis a person picks, taken off the wire type rather than restated.
 *
 * `ExecutionPosture` is a structured value with cross-field invariants encoded in
 * its shape; the draft's picker chooses only its `mode`, and the rest is composed
 * where the run is admitted. Deriving the union from the contract means a fourth
 * mode reaches this picker without an edit here — and cannot reach it as a string
 * the wire does not know.
 */
export type DraftPostureMode = ExecutionPosture["mode"];

/** One agent the draft will attach, by definition, with the account that pays. */
export interface DraftAgentSelection {
  /** The sidekick definition's daemon-minted opaque id — never its mutable name. */
  readonly definitionId: string;
  /** The account this agent's spend lands on, where the person picked one. */
  readonly providerAccountId: string | undefined;
}

/** The repo this session works in, and how. */
export interface DraftRepoMount {
  readonly repoId: string;
  readonly executionMode: ExecutionMode;
}

/** What the draft surface renders. A fresh object per mutation, so `Object.is` decides. */
export interface NewSessionDraftState {
  readonly agents: readonly DraftAgentSelection[];
  readonly repoMount: DraftRepoMount | undefined;
  readonly posture: DraftPostureMode | undefined;
  /** The session's first message, verbatim. Never trimmed; only tested for blankness. */
  readonly firstTurn: string;
  /** True while nothing has been chosen — the arm that reverts to nothing. */
  readonly isEmpty: boolean;
  readonly revision: number;
}

/** What one draft has already put on the wire, so a repeat press resumes rather than repeats. */
interface LandedCalls {
  /**
   * The session this draft created, once it has.
   *
   * Keyed on the CALL having returned rather than on an id having been read: a create
   * the daemon accepted made a session whether or not its response carried a readable
   * `sessionId`, so a memory that only remembered ids would let an unreadable response
   * mint a second session on the next press.
   */
  hasCreatedSession: boolean;
  sessionId: string | undefined;
  readonly attachedDefinitionIds: Set<string>;
  hasQueuedFirstTurn: boolean;
}

export class NewSessionDraft {
  readonly #bridge: ConsoleBridge;
  readonly #changes = new Emitter<NewSessionDraftState>("new session draft change");
  /**
   * The send that is running, while one is.
   *
   * Held rather than counted, so a concurrent caller receives the SAME promise and
   * therefore the same result — a double-click yields one create and one settlement
   * rather than one create and a second caller left waiting on nothing.
   *
   * Private, and no reader is offered one: the guard is structural, so a caller
   * that is not a button — a keyboard path, a test, a later surface — is safe
   * without consulting anything. A surface that wants to disable an affordance
   * meanwhile knows it pressed, which is `NewSessionControl`'s own flag.
   */
  #sendInFlight: Promise<NewSessionSendResult> | undefined;
  /**
   * What this draft has already landed.
   *
   * Deliberately not cleared by {@link discard}: the invariant is one session per
   * draft OBJECT, and a draft that could be emptied and re-composed into a second
   * `session.create` would be the same defect reached by a longer route. The control
   * drops the object on close, which is where a new session comes from.
   */
  readonly #landed: LandedCalls = {
    hasCreatedSession: false,
    sessionId: undefined,
    attachedDefinitionIds: new Set<string>(),
    hasQueuedFirstTurn: false,
  };
  #state: NewSessionDraftState = {
    agents: [],
    repoMount: undefined,
    posture: undefined,
    firstTurn: "",
    isEmpty: true,
    revision: 0,
  };

  public constructor(options: { readonly bridge: ConsoleBridge }) {
    this.#bridge = options.bridge;
  }

  public snapshot(): NewSessionDraftState {
    return this.#state;
  }

  public subscribe(listener: (state: NewSessionDraftState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Add an agent by definition. A second add of the same definition replaces it. */
  public selectAgent(selection: DraftAgentSelection): void {
    const agents = [
      ...this.#state.agents.filter((agent) => agent.definitionId !== selection.definitionId),
      selection,
    ];
    this.#commit({ agents });
  }

  public deselectAgent(definitionId: string): void {
    const agents = this.#state.agents.filter((agent) => agent.definitionId !== definitionId);
    if (agents.length === this.#state.agents.length) {
      return;
    }
    this.#commit({ agents });
  }

  /** Which account pays for one already-selected agent. Unknown ids change nothing. */
  public setPayingAccount(definitionId: string, providerAccountId: string | undefined): void {
    if (!this.#state.agents.some((agent) => agent.definitionId === definitionId)) {
      return;
    }
    this.#commit({
      agents: this.#state.agents.map((agent) =>
        agent.definitionId === definitionId ? { ...agent, providerAccountId } : agent,
      ),
    });
  }

  public setRepoMount(repoMount: DraftRepoMount | undefined): void {
    this.#commit({ repoMount });
  }

  public setPosture(posture: DraftPostureMode | undefined): void {
    this.#commit({ posture });
  }

  /**
   * What this session's first message says.
   *
   * Kept verbatim: the wire receives the participant's own bytes, so pasted code keeps
   * its indentation and a deliberately separated block keeps its separation. Blankness
   * is decided by trimming where the send asks the question, which is a test of the
   * text rather than an edit of it.
   */
  public setFirstTurn(firstTurn: string): void {
    this.#commit({ firstTurn });
  }

  /**
   * Throw the draft away.
   *
   * No wire call, on this module's own terms: a draft has no daemon row, so discarding
   * one is a local act and issuing a delete would be asking the daemon to forget
   * something it was never told.
   */
  public discard(): void {
    this.#commit({ agents: [], repoMount: undefined, posture: undefined, firstTurn: "" });
  }

  /**
   * The coalesced first send.
   *
   * Coalesced in TWO senses, and both are load-bearing. Across the three calls, it is
   * ordered rather than parallel: the two after `session.create` need the session it
   * returns, so issuing them together would mean inventing the id before the daemon
   * minted it. Across repeated presses, it is idempotent in the only way a renderer can
   * make a create idempotent — by remembering. A concurrent call joins the running
   * send; a later call resumes at the first call that has not been made. Neither
   * refuses, because a refusal here would put a code in front of a person whose press
   * did exactly what they meant it to.
   */
  public send(): Promise<NewSessionSendResult> {
    // `??=` short-circuits, so the send is started only when none is running, and
    // the assignment happens before the first `await` inside it — a second
    // synchronous call therefore always finds the promise rather than a gap.
    this.#sendInFlight ??= this.#performSend().finally(() => {
      this.#sendInFlight = undefined;
    });
    return this.#sendInFlight;
  }

  async #performSend(): Promise<NewSessionSendResult> {
    if (this.#state.isEmpty) {
      return {
        outcome: "refused",
        sessionId: undefined,
        completedCalls: [],
        refusal: refuseDraft(
          "draft-empty",
          "Pick at least one sidekick, a repository, or a posture, or type the first message, before sending.",
        ),
      };
    }

    const progress = await sendNewSessionDraft({
      bridge: this.#bridge,
      // The session this draft already created is the session this draft sends to, so
      // the create leg is skipped rather than repeated.
      sessionId: this.#landed.hasCreatedSession ? this.#landed.sessionId : undefined,
      agents: this.#state.agents,
      alreadyAttachedDefinitionIds: this.#landed.attachedDefinitionIds,
      firstTurnAlreadyQueued: this.#landed.hasQueuedFirstTurn,
      firstTurn: this.#state.firstTurn,
      executionPostureMode: this.#state.posture,
    });

    // Recorded whatever the outcome was: the legs that landed are landed, and a
    // partial that forgot them would repeat them on the next press.
    if (progress.result.outcome !== "refused") {
      this.#landed.hasCreatedSession = true;
      this.#landed.sessionId = progress.sessionId;
    }
    for (const definitionId of progress.attachedDefinitionIds) {
      this.#landed.attachedDefinitionIds.add(definitionId);
    }
    this.#landed.hasQueuedFirstTurn ||= progress.firstTurnQueued;
    return progress.result;
  }

  #commit(change: Partial<Omit<NewSessionDraftState, "isEmpty" | "revision">>): void {
    const next = { ...this.#state, ...change };
    this.#state = {
      ...next,
      isEmpty:
        next.agents.length === 0 &&
        next.repoMount === undefined &&
        next.posture === undefined &&
        next.firstTurn.trim().length === 0,
      revision: this.#state.revision + 1,
    };
    this.#changes.emit(this.#state);
  }
}
