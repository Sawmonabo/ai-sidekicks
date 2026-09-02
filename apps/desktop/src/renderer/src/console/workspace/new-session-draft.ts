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
   * Ordered rather than parallel, and that is the design: the two calls after
   * `session.create` need the session it returns, so issuing them together would
   * mean inventing the id before the daemon minted it.
   */
  public async send(): Promise<NewSessionSendResult> {
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

    // Both remaining calls are unreachable: neither is registered in the contracts
    // package and neither has a growth-port operation, so there is no honest way to
    // issue them. The session exists, so the outcome is PARTIAL and says which call
    // landed — §4.8's "with the calls that succeeded named".
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
