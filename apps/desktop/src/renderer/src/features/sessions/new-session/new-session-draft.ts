// The new-session draft: a session that does not exist yet. "+ New" creates a placeholder
// with no daemon row, the first send coalesces `session.create` and `run.queueCreate`, and a
// draft closed empty leaves no row. This file owns what a person chose and the coalescing
// that keeps one draft to one session; `new-session-send.ts` owns what the choices become on
// the wire.
//
// Every selection lives in this object's memory: a draft is user-authored content, which has
// no durable home in the renderer (`store/persistence/persisted-value-classes.ts`), so this
// module never reaches the persistence store. A partial send is reported, never rolled back,
// because a renderer cannot undo a `session.create` the daemon accepted, and the draft stays
// editable.
//
// One draft object mints at most one session, and each call at most once. Send stays pressable
// after a partial send, so without a per-leg memory a double-click would mint two sessions and
// a retry would queue the words twice. A send while one is in flight yields that send (as
// `coalescing-layout-writer.ts` does), and a later send resumes at the first call not yet
// made. Closing the draft drops it, which is what makes the next "+ New" a new session.
//
// Every create carries the draft's one idempotency key, minted with the draft, so a create
// that reached the daemon and is sent again names the session already made.
//
// A create answered with a reply this build cannot read may have made a session and names
// none, so there is nothing to resume against and a repeat would return the same reply. The
// draft remembers that and answers every later send from memory with nothing on the wire; the
// sentence tells the person to look at the sessions list.
//
// The first turn is the draft's, because `run.queueCreate` takes the turn's body. A blank
// first turn is the one refusal that is a choice rather than a fact about the build: the
// session exists and nothing has been said.

import type { AgentProviderBinding, ExecutionPosture } from "@ai-sidekicks/contracts";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import type { FirstTurnQueueCall } from "./new-session-control-contract.js";
import { sendNewSessionDraft, type DraftRepoMount } from "./new-session-send.js";
import {
  refuseAmbiguousCreate,
  refuseNewSessionDraft,
  type NewSessionSendResult,
} from "./new-session-settlement.js";

/**
 * The posture axis a person picks, taken off the wire type. The picker chooses only its
 * `mode`; the rest of `ExecutionPosture` is composed where the run is admitted.
 */
export type DraftPostureMode = ExecutionPosture["mode"];

/** What the draft control renders. A fresh object per mutation, so `Object.is` decides. */
export interface NewSessionDraftState {
  readonly repoMount: DraftRepoMount | undefined;
  readonly posture: DraftPostureMode | undefined;
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
    posture: undefined,
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

  public snapshot(): NewSessionDraftState {
    return this.#state;
  }

  public subscribe(listener: (state: NewSessionDraftState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  public setRepoMount(repoMount: DraftRepoMount | undefined): void {
    this.#commit({ repoMount });
  }

  /** The posture this session works under. Held but not sent: neither call has a member for it. */
  public setPosture(posture: DraftPostureMode | undefined): void {
    this.#commit({ posture });
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
    this.#commit({ repoMount: undefined, posture: undefined, firstTurn: "" });
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
      isEmpty:
        next.repoMount === undefined &&
        next.posture === undefined &&
        next.firstTurn.trim().length === 0,
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
