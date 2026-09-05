// The new-session draft — a session that does not exist yet.
//
// THIS CONSOLE'S OWN RULE, because no committed document states it — `Spec-023 §Scope`
// leaves each surface's composition to "the console's own code and fixture scenarios":
// "+ New" creates a draft session placeholder with no daemon row, and the person picks
// agents (by definition), a repo mount and mode, a posture, and a paying account per
// agent. The first send coalesces `session.create`, one `agent.attach` per agent, and
// `run.queueCreate`; a draft that is closed empty reverts to nothing and leaves no row.
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
// ONE DRAFT OBJECT, AT MOST ONE SESSION. The three properties above make the draft
// editable after a send that only partly landed, which is what a person needs — and
// which means Send stays pressable with the same choices behind it. Without a
// memory of what a previous press already did, the next press would reach
// `session.create` again: a double-click would mint two daemon sessions, and a
// retry after the partial would mint a third, none of them the
// one the person is looking at. So this class coalesces rather than refuses, on the
// deck writer's idiom: a send while one is in flight yields THAT send, and a send
// after a session has been created re-reports the same session instead of making
// another. The invariant is scoped to the object, so closing the draft — which
// drops it — is what makes the next "+ New" a genuinely new session.
//
// WIRE TRUTH. Of the three calls the coalesced send names, exactly one is issued
// from here: `session.create`, over the bridge's own call door, which parses the
// request before sending and the reply after. The other two are not sent, for
// different reasons — and the refusal CODE is which of the two it was, not a single
// word covering both. `agent.attach` is registered nowhere in
// `@ai-sidekicks/contracts` and has no entry on the growth port, so there is no shape
// to send: that is `wire-unregistered`, and it is a fact about this build.
// `run.queueCreate` IS registered and callable — what is missing is the first turn's
// own body, which lives in the composer and not in a draft that holds agents, a mount
// and a posture; inventing a payload for it here would be this console sending words
// nobody typed. That is `first-turn-missing`, and it is a fact about this draft.
// Which one a send reports follows from the draft itself, because the send is ordered
// and a draft that named no sidekicks has no attach to make. Auto-pin is deliberately
// absent for the same reason it always was: it fires on a first SUCCESSFUL send, and
// no send is complete while either call is unmade.

import type { ExecutionMode, ExecutionPosture } from "@ai-sidekicks/contracts";
import { callDaemon, type ConsoleBridge } from "../bridge/index.js";
import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";

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
  /** True while nothing has been chosen — the arm that reverts to nothing. */
  readonly isEmpty: boolean;
  readonly revision: number;
}

/** Why a send could not complete. Closed, so a fifth cause is a decision. */
export const NEW_SESSION_DRAFT_REFUSAL_CODES = [
  "draft-empty",
  "session-create-failed",
  // The two remaining calls are unreachable for DIFFERENT reasons, and a person who
  // pastes a code into an issue is telling somebody which of the two it was.
  // `agent.attach` has no registered shape at all; `run.queueCreate` has one and no
  // first turn to put in it, which is a fact about this draft rather than about the
  // build it is running in.
  "wire-unregistered",
  "first-turn-missing",
] as const;

/** One draft refusal code. Derived, so the vocabulary is declared once. */
export type NewSessionDraftRefusalCode = (typeof NEW_SESSION_DRAFT_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const NEW_SESSION_DRAFT_REFUSAL_ORIGIN = "new-session-draft";

/** A typed draft refusal — `core`'s one refusal shape, narrowed on `code`. */
export interface NewSessionDraftRefusal extends ConsoleRefusal {
  readonly code: NewSessionDraftRefusalCode;
}

function refuseDraft(code: NewSessionDraftRefusalCode, detail: string): NewSessionDraftRefusal {
  return { ...refuse(NEW_SESSION_DRAFT_REFUSAL_ORIGIN, code, detail), code };
}

/**
 * What the coalesced send did.
 *
 * `completedCalls` carries the wire names verbatim and in order, because this module's
 * requirement is that the error slot NAMES the calls that succeeded — a person who
 * has to decide whether to retry needs to know a session already exists.
 */
export interface NewSessionSendResult {
  readonly outcome: "sent" | "partial" | "refused";
  /** Present once `session.create` answered, whatever happened after it. */
  readonly sessionId: string | undefined;
  readonly completedCalls: readonly string[];
  readonly refusal: NewSessionDraftRefusal | undefined;
}

/** The one wire name this module sends, spelled once. */
const SESSION_CREATE_METHOD = "session.create";

/**
 * What a send says when the draft named sidekicks it cannot attach.
 *
 * `agent.attach` has no request or response pair in the contracts package and no
 * growth-port operation, so there is no shape to send. The send is ordered, so the
 * turn behind it is not attempted either — said here rather than left for the reader
 * to infer from a call that is not mentioned.
 */
const ATTACH_UNAVAILABLE_WORDS =
  "agent.attach is not available in this build, so run.queueCreate was not attempted either";

/**
 * What a send says when the only call left is the first turn.
 *
 * `run.queueCreate` IS registered and callable, so "unregistered" would be the wrong
 * word for it: what is missing is the turn's own body, which lives in the composer
 * and not in a draft that holds agents, a mount and a posture. A draft that named no
 * sidekicks reaches this and nothing else, because zero agents is zero attaches.
 */
const FIRST_TURN_MISSING_WORDS =
  "run.queueCreate is registered and callable, and a draft holds agents, a repository and a " +
  "posture: the turn's own words are the composer's";

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
   * The create this draft already landed, once it has.
   *
   * Keyed on the CALL having returned rather than on an id having been read: a
   * create the daemon accepted made a session whether or not its response carried
   * a readable `sessionId`, so a memory that only remembered ids would let an
   * unreadable response mint a second session on the next press. One field, so
   * "the create landed" and "this is what we know of it" cannot disagree.
   *
   * Deliberately not cleared by {@link discard}: the invariant is one session per
   * draft OBJECT, and a draft that could be emptied and re-composed into a second
   * `session.create` would be the same defect reached by a longer route. The
   * control drops the object on close, which is where a new session comes from.
   */
  #landedCreate: { readonly sessionId: string | undefined } | undefined;
  #state: NewSessionDraftState = {
    agents: [],
    repoMount: undefined,
    posture: undefined,
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
   * Throw the draft away.
   *
   * No wire call, on this module's own terms: a draft has no daemon row, so discarding
   * one is a local act and issuing a delete would be asking the daemon to forget
   * something it was never told.
   */
  public discard(): void {
    this.#commit({ agents: [], repoMount: undefined, posture: undefined });
  }

  /**
   * The coalesced first send.
   *
   * Coalesced in TWO senses, and both are load-bearing. Across the three calls the rule
   * above names, it is ordered rather than parallel: the two after `session.create` need
   * the session it returns, so issuing them together would mean inventing the
   * id before the daemon minted it. Across repeated presses, it is idempotent in
   * the only way a renderer can make a create idempotent — by remembering. A
   * concurrent call joins the running send; a later call re-reports the session the
   * first one made. Neither refuses, because a refusal here would put a fourth code
   * in front of a person whose press did exactly what they meant it to.
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
          "Pick at least one sidekick, a repository, or a posture before sending.",
        ),
      };
    }

    // A session this draft already created is the session this draft sends to. The
    // create is skipped rather than repeated, and the SAME partial is re-reported,
    // because nothing about the outcome has changed: the session still exists and
    // the two calls that would have finished the send are still unregistered.
    if (this.#landedCreate !== undefined) {
      return this.#remainderAfterCreate(this.#landedCreate.sessionId);
    }

    // Through the bridge's one call door, which parses the request before sending
    // and the reply after and never throws: the reply's `sessionId` is read off the
    // method's own registered response shape rather than sniffed out of `unknown`.
    const reply = await callDaemon(this.#bridge, SESSION_CREATE_METHOD, {});
    if (reply.status === "refused") {
      // The daemon's own message is not console copy — it crosses an IPC boundary,
      // may be a stack, and describes a subsystem the person cannot act on. The
      // code names which call failed, which is what a person pastes into an issue.
      return {
        outcome: "refused",
        sessionId: undefined,
        completedCalls: [],
        refusal: refuseDraft(
          "session-create-failed",
          "The session could not be created. Nothing was sent, and the draft is still here.",
        ),
      };
    }

    const sessionId = reply.value.sessionId;
    this.#landedCreate = { sessionId };
    return this.#remainderAfterCreate(sessionId);
  }

  /**
   * What a send reports once the session exists and the rest cannot be issued.
   *
   * One function, reached by both the first send and every later one, because the
   * two must report the same thing: a retry that described the session differently
   * from the press that made it would read as a second session.
   *
   * WHICH CODE IT CARRIES IS DECIDED BY THE DRAFT, not by the build. The send is
   * ordered — create, then one attach per agent, then the turn — so it stops at the
   * first call it cannot make, and which one that is depends on whether this draft
   * named any sidekicks at all. A draft that named none has no attach to make, and
   * reporting one as unavailable would name a call its send was never going to
   * issue. The session exists either way, so the outcome is PARTIAL and says which
   * call landed, which is this module's "with the calls that succeeded named".
   */
  #remainderAfterCreate(sessionId: string | undefined): NewSessionSendResult {
    const refusal =
      this.#state.agents.length > 0
        ? refuseDraft(
            "wire-unregistered",
            `The session was created, but its sidekicks could not be attached — ${ATTACH_UNAVAILABLE_WORDS}.`,
          )
        : refuseDraft(
            "first-turn-missing",
            `The session was created, but no first turn was queued — ${FIRST_TURN_MISSING_WORDS}.`,
          );
    return {
      outcome: "partial",
      sessionId,
      completedCalls: [SESSION_CREATE_METHOD],
      refusal,
    };
  }

  #commit(change: Partial<Omit<NewSessionDraftState, "isEmpty" | "revision">>): void {
    const next = { ...this.#state, ...change };
    this.#state = {
      ...next,
      isEmpty:
        next.agents.length === 0 && next.repoMount === undefined && next.posture === undefined,
      revision: this.#state.revision + 1,
    };
    this.#changes.emit(this.#state);
  }
}
