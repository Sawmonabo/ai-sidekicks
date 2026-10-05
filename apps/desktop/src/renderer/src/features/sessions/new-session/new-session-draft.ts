// The new-session draft: a session that does not exist yet, held in memory only (a draft has no
// durable home in the renderer). One draft object mints at most one session and makes each call
// at most once: a send while one runs joins it, a later send resumes at the first call not yet
// made, and every create carries the draft's one idempotency key. A create whose reply could not
// be read may have made a session it cannot name, so every later send answers from memory with
// nothing on the wire. `send.ts` owns what the choices become on the wire.

import type { AgentProviderBinding } from "@ai-sidekicks/contracts/agent/definition";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { FirstTurnQueueCall } from "./control-contract.js";
import { sendNewSessionDraft, type DraftRepoMount } from "./send.js";
import {
  refuseAmbiguousCreate,
  refuseNewSessionDraft,
  type NewSessionSendResult,
} from "./settlement.js";

/** What the draft control renders. A fresh object per mutation, so `Object.is` decides. */
export interface NewSessionDraftState {
  readonly repoMount: DraftRepoMount | undefined;
  /** The session's first message, verbatim. Never trimmed; only tested for blankness. */
  readonly firstTurn: string;
  /** True while nothing has been chosen — the arm that reverts to nothing. */
  readonly isEmpty: boolean;
  readonly revision: number;
}

/** A session that does not exist yet: the choices, the coalesced first send and its memory. */
export class NewSessionDraft {
  readonly #bridge: PlatformBridge;
  readonly #queueFirstTurn: FirstTurnQueueCall;
  readonly #lead: AgentProviderBinding;
  /** The key every create this draft sends carries, so a repeat names the session made. */
  readonly #clientIdempotencyKey: string = crypto.randomUUID();
  readonly #changes = new Emitter<NewSessionDraftState>("new session draft change");
  /**
   * The send that is running, while one is. Held rather than counted, so a concurrent caller
   * receives the same promise and result. Private: the guard is structural, so a keyboard
   * path or a test is safe without consulting a flag.
   */
  #sendInFlight: Promise<NewSessionSendResult> | undefined;
  /**
   * What this draft has already landed. Not cleared by {@link discard}: the invariant is one
   * session per draft object, and re-composing an emptied draft into a second create would
   * be the same defect by a longer route.
   */
  readonly #landed: LandedCalls = {
    hasCreatedSession: false,
    sessionId: undefined,
    hasUnreadableCreate: false,
    hasQueuedFirstTurn: false,
  };
  #state: NewSessionDraftState = {
    repoMount: undefined,
    firstTurn: "",
    isEmpty: true,
    revision: 0,
  };

  public constructor(options: {
    readonly bridge: PlatformBridge;
    readonly queueFirstTurn: FirstTurnQueueCall;
    /** The lead the session starts on, as the composition that mounts the draft chose it. */
    readonly lead: AgentProviderBinding;
  }) {
    this.#bridge = options.bridge;
    this.#queueFirstTurn = options.queueFirstTurn;
    this.#lead = options.lead;
  }

  /** The draft as it stands now; a fresh object after every change. */
  public snapshot(): NewSessionDraftState {
    return this.#state;
  }

  /** Be told each new state the draft commits. */
  public subscribe(listener: (state: NewSessionDraftState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** The project the session works in; `undefined` makes it a chat. */
  public setRepoMount(repoMount: DraftRepoMount | undefined): void {
    this.#commit({ repoMount });
  }

  /**
   * What this session's first message says. Kept verbatim so the wire gets the user's own
   * bytes; blankness is tested by trimming where the send asks, not by editing the text.
   */
  public setFirstTurn(firstTurn: string): void {
    this.#commit({ firstTurn });
  }

  /** Throw the draft away. Local only: a draft has no daemon row, so nothing is deleted. */
  public discard(): void {
    this.#commit({ repoMount: undefined, firstTurn: "" });
  }

  /**
   * The coalesced first send. The two calls are ordered, because the turn needs the id
   * `session.create` returns. Repeated presses are coalesced: a concurrent call joins the
   * running send and a later one resumes at the first call not yet made. Neither refuses, as
   * a refusal would put a code in front of a person whose press did what they meant.
   */
  public send(): Promise<NewSessionSendResult> {
    // `??=` starts a send only when none is running, and assigns before the first `await`, so
    // a second synchronous call finds the promise.
    this.#sendInFlight ??= this.#performSend().finally(() => {
      this.#sendInFlight = undefined;
    });
    return this.#sendInFlight;
  }

  async #performSend(): Promise<NewSessionSendResult> {
    if (this.#landed.hasUnreadableCreate) {
      // The structural half of the ambiguous arm: a create this build could not read may have
      // made a session, and a second dispatch would return the same unreadable reply. A press
      // that bypasses the disabled control puts nothing on the wire and gets the same
      // settlement. It read no composition, so it names no revision.
      return refuseAmbiguousCreate(undefined);
    }
    if (this.#state.isEmpty) {
      return {
        outcome: "refused",
        sessionId: undefined,
        completedCalls: [],
        // An empty draft reaches no wire, so no composition was carried.
        sentRevision: undefined,
        refusal: refuseNewSessionDraft("draft-empty", "Type the first message before sending."),
      };
    }

    const progress = await sendNewSessionDraft({
      bridge: this.#bridge,
      queueFirstTurn: this.#queueFirstTurn,
      // The session this draft already created is the one it sends to; the create is skipped.
      sessionId: this.#landed.hasCreatedSession ? this.#landed.sessionId : undefined,
      firstTurnAlreadyQueued: this.#landed.hasQueuedFirstTurn,
      repoMount: this.#state.repoMount,
      lead: this.#lead,
      clientIdempotencyKey: this.#clientIdempotencyKey,
      firstTurn: this.#state.firstTurn,
      // Captured with the words it describes, from the same `#state` read, so a settlement can
      // be measured against the draft as it stands when the reply arrives. The draft is
      // editable throughout: `send()` returns before the create does.
      draftRevision: this.#state.revision,
    });

    // Recorded whatever the outcome: legs that landed are landed. The unreadable arm is
    // recorded first and separately, since `hasCreatedSession` with no `sessionId` would look
    // like a skipped create, and the resume path reads exactly that pair.
    this.#landed.hasUnreadableCreate ||= progress.createAnsweredUnreadably;
    if (progress.result.outcome === "sent" || progress.result.outcome === "partial") {
      this.#landed.hasCreatedSession = true;
      this.#landed.sessionId = progress.sessionId;
    }
    this.#landed.hasQueuedFirstTurn ||= progress.firstTurnQueued;
    return progress.result;
  }

  #commit(change: Partial<Omit<NewSessionDraftState, "isEmpty" | "revision">>): void {
    const next = { ...this.#state, ...change };
    this.#state = {
      ...next,
      isEmpty: next.repoMount === undefined && next.firstTurn.trim().length === 0,
      revision: this.#state.revision + 1,
    };
    this.#changes.emit(this.#state);
  }
}

/** What one draft has already put on the wire, so a repeat press resumes rather than repeats. */
interface LandedCalls {
  /**
   * The session this draft created, once it has. Set only where the reply was read, so this
   * member and `sessionId` move together. An unreadable create is recorded beside it in
   * {@link hasUnreadableCreate}, since it cannot be resumed from but must stop a second create.
   */
  hasCreatedSession: boolean;
  sessionId: string | undefined;
  /**
   * Whether the create answered with a reply this build could not read. A session may exist
   * with no id to address it, so the draft can neither resume nor safely mint another; every
   * later press answers from memory.
   */
  hasUnreadableCreate: boolean;
  hasQueuedFirstTurn: boolean;
}
