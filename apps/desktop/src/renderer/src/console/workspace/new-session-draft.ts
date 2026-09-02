// The new-session draft — a session that does not exist yet.
//
// `Spec-023 §Console Design (Meridian)` §4.8: "'+ New' creates a draft session
// placeholder with no daemon row: the person picks agents (by definition), a repo
// mount and mode, a posture, and a paying account per agent. The first send
// coalesces `session.create`, one `agent.attach` per agent, and `run.queueCreate`;
// a draft that is closed empty reverts to nothing and leaves no row."
//
// THREE PROPERTIES, AND EACH IS THE REASON THIS IS A CLASS RATHER THAN A FORM:
//
//   • **No daemon row until the first send.** Every selection lives in this
//     object's memory and nowhere else. `discard()` on an empty draft leaves
//     nothing behind — there is nothing to delete, which is the strongest form of
//     "leaves no row".
//   • **Nothing durable.** A draft is participant-authored content, and
//     `console/persistence/value-classes.ts` gives such content no durable home in
//     the renderer. This module never reaches the persistence door.
//   • **A partial send is reported, never rolled back.** §4.8 asks for "the calls
//     that succeeded named" and for the draft to stay editable. A renderer cannot
//     undo a `session.create` the daemon accepted, and pretending otherwise would
//     leave a real session the person believes was never made.
//
// ONE DRAFT OBJECT, AT MOST ONE SESSION. The three properties above make the draft
// editable after a send that only partly landed, which is what a person needs — and
// which means Send stays pressable with the same choices behind it. Without a
// memory of what a previous press already did, the next press would reach
// `session.create` again: a double-click would mint two daemon sessions, and a
// retry after the `wire-unregistered` partial would mint a third, none of them the
// one the person is looking at. So this class coalesces rather than refuses, on the
// deck writer's idiom: a send while one is in flight yields THAT send, and a send
// after a session has been created re-reports the same session instead of making
// another. The invariant is scoped to the object, so closing the draft — which
// drops it — is what makes the next "+ New" a genuinely new session.
//
// WIRE TRUTH. Of the three calls the coalesced send names, exactly one is reachable
// from the console today: `session.create`, which the shipped Tier-1 bootstrap
// already calls over `daemon.call`. `agent.attach` and `run.queueCreate` are
// registered nowhere in `@ai-sidekicks/contracts` and have no entry on the growth
// port, so the send performs the first and REFUSES the other two by name rather
// than inventing two method strings. Auto-pin is deliberately absent for the same
// reason: it fires on a first SUCCESSFUL send, and no send can succeed until those
// two wires land.

import type { ExecutionMode, ExecutionPosture } from "@ai-sidekicks/contracts";

import { type ConsoleBridge } from "../bridge/index.js";
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

/** Why a send could not complete. Closed, so a fourth cause is a decision. */
export const NEW_SESSION_DRAFT_REFUSAL_CODES = [
  "draft-empty",
  "session-create-failed",
  "wire-unregistered",
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
 * `completedCalls` carries the wire names verbatim and in order, because §4.8's
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

/** The two the coalesced send needs and the console cannot reach. */
const UNREGISTERED_SEND_CALLS: readonly string[] = ["agent.attach", "run.queueCreate"];

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
   * No wire call, on §4.8's terms: a draft has no daemon row, so discarding one is
   * a local act and issuing a delete would be asking the daemon to forget something
   * it was never told.
   */
  public discard(): void {
    this.#commit({ agents: [], repoMount: undefined, posture: undefined });
  }

  /**
   * The coalesced first send.
   *
   * Coalesced in TWO senses, and both are load-bearing. Across the three calls
   * §4.8 names, it is ordered rather than parallel: the two after `session.create`
   * need the session it returns, so issuing them together would mean inventing the
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
      return this.#unregisteredRemainder(this.#landedCreate.sessionId);
    }

    let sessionId: string | undefined;
    try {
      sessionId = readSessionId(await callDaemon(this.#bridge, SESSION_CREATE_METHOD, {}));
    } catch {
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

    this.#landedCreate = { sessionId };
    return this.#unregisteredRemainder(sessionId);
  }

  /**
   * What a send reports once the session exists and the rest cannot be issued.
   *
   * One function, reached by both the first send and every later one, because the
   * two must report the same thing: a retry that described the session differently
   * from the press that made it would read as a second session.
   *
   * Both remaining calls are unreachable — neither is registered in the contracts
   * package and neither has a growth-port operation, so there is no honest way to
   * issue them. The session exists, so the outcome is PARTIAL and says which call
   * landed, which is §4.8's "with the calls that succeeded named".
   */
  #unregisteredRemainder(sessionId: string | undefined): NewSessionSendResult {
    return {
      outcome: "partial",
      sessionId,
      completedCalls: [SESSION_CREATE_METHOD],
      refusal: refuseDraft(
        "wire-unregistered",
        `The session was created, but its sidekicks could not be attached and no first turn was queued — ${UNREGISTERED_SEND_CALLS.join(" and ")} are not available in this build.`,
      ),
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

/**
 * The one `DaemonMethod` brand cast in this family, in one place.
 *
 * `packages/contracts/src/desktop-bridge.ts` types `DaemonMethod` as a
 * `never`-shaped brand until Plan-007 narrows it to the real method-name union, so
 * no string literal is structurally assignable to it. The shipped Tier-1 bootstrap
 * makes the same cast for the same call and says the same thing. Confining it to
 * one function means the day that union lands there is one site to delete, and
 * until then no surface in this family holds a way to call an arbitrary method.
 */
async function callDaemon(
  bridge: ConsoleBridge,
  method: string,
  params: unknown,
): Promise<unknown> {
  const call = bridge.sidekicks.daemon.call as (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  return await call(method, params);
}

/**
 * The session id off a create response, or `undefined`.
 *
 * Read structurally rather than parsed against a schema: `DaemonResult<M>` is a
 * Plan-007 stub resolving to `unknown`, so there is no typed response to narrow
 * against yet, and a hand-written schema here would be a second declaration of a
 * shape the contracts package will own.
 */
function readSessionId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const candidate = (response as { sessionId?: unknown }).sessionId;
  return typeof candidate === "string" ? candidate : undefined;
}
