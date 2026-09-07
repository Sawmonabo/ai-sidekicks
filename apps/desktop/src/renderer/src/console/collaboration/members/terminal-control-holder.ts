// Who holds this session's one shared-terminal write lease.
//
// A WIRE FIELD, WHICH IS THE WHOLE RULE. `Spec-023 §Console Design (Meridian)` 8.8
// forbids deriving the holder from the last observed claim: a lease is taken,
// released, and auto-released for three different reasons, and a surface that folded
// whichever transition it happened to have seen would state a holder nobody sent it.
// So the holder is read, and the read is the registered `controlHolder` member.
//
// AND `null` IS AN ANSWER. The registered member resolves to null both when the lease
// is free and when the holding node reads offline, and the surface draws that state
// distinctly from "not read yet" — a lease nobody holds is a fact about the session,
// and a console that rendered it as an absence would leave a person unable to tell
// whether they may claim the shell.
//
// WHY THE ROSTER READS IT AT ALL. 8.8 puts the holder "wherever presence renders, so
// the holder is visible from the roster without opening the pane". The terminal pane
// is a different view family and its own surface; nothing here reaches into it, and
// nothing here offers a claim — the two lease verbs are the pane's, and a second
// place to press them would be a second place to be refused.
//
// WHICH IS EXACTLY WHY THE READ HAS TO BE PUSH-DRIVEN. The lease is claimed and
// released from a surface this one cannot see, so a read taken once at mount answers
// a question whose answer changes without this section moving: the roster stayed on
// the holder it read on the frame it opened, and a take, a release, and both
// automatic releases — the holder's node disconnecting, the holder losing
// authorization — left it naming somebody who had let the shell go, or saying nobody
// held a shell somebody was typing into, for the rest of the visit. Neither is a
// slower reading of the truth; both are the console asserting a session state that
// has stopped being true, which is the one thing 8.8's wire-field rule exists to
// stop. So the answer is refreshed by the transition's own registered event, through
// the seat that owns subscribe-then-read: one read per burst on the refresh
// chokepoint, no poll, no second copy of the publisher's model, and no flicker back
// to the unread state while a refresh is in flight.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import {
  PushDrivenRead,
  servedGrowthValueOrRaise,
  type PushDrivenReadState,
} from "../../seats/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleClock, ConsoleRefusal } from "../../core/index.js";
import { subscribeToSessionEventKinds, type SessionStore } from "../../store/index.js";

/** Names this read in a refusal the call itself did not name. */
export const TERMINAL_CONTROL_HOLDER_ORIGIN = "terminal-control-holder";

/**
 * The registered kind that moves the lease, and the only signal this read takes.
 *
 * One kind and not a set, because one kind carries every transition: a take, an
 * operator's release, and the three automatic releases all reach the session stream as
 * `pty.control_changed` with their reason on the payload — which this read never
 * opens, because the push is a signal and the holder is what the read answers.
 *
 * Typed against the contract's own `SessionEventType` union rather than as a string,
 * so a kind the wire does not register is a compile error here rather than a signal
 * that silently never fires. The terminal family names the same wire string for a
 * different job — it READS a transition out of the log — and the union both derive
 * from is the single declaration of the vocabulary; view families are siblings and
 * may not import each other, so neither could take the other's constant.
 */
const TERMINAL_CONTROL_EVENT_KINDS: readonly SessionEventType[] = ["pty.control_changed"];

/** What one `terminalControlHolderRead` call answers. */
export interface TerminalControlHolderValue {
  readonly controlHolder: string | null;
}

/** The roster's live reading of the session's one lease. */
export type TerminalControlHolderRead = PushDrivenRead<TerminalControlHolderValue>;

/** What the roster holds for that read at any moment. */
export type TerminalControlHolderState = PushDrivenReadState<TerminalControlHolderValue>;

/**
 * Build the lease read for one session.
 *
 * Constructed by whoever owns its lifetime — the collaboration model holder, never a
 * render body — and disposed with that owner, exactly as the presence roster and the
 * channel directory beside it are.
 *
 * One read for the whole roster rather than one per row: the lease is session-scoped,
 * so a per-row read would ask the same question once per person and answer every one
 * of them the same way.
 */
export function createTerminalControlHolder(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly clock: ConsoleClock;
}): TerminalControlHolderRead {
  const { bridge, sessionStore, clock } = options;
  return new PushDrivenRead<TerminalControlHolderValue>({
    clock,
    origin: TERMINAL_CONTROL_HOLDER_ORIGIN,
    read: async () =>
      servedGrowthValueOrRaise(
        await bridge.growth.terminalControlHolderRead({ sessionId: sessionStore.sessionId }),
      ),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, TERMINAL_CONTROL_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * What the read said about the lease.
 *
 * Three values and not two, because the states are three: a participant holds it, the
 * read said nobody holds it, or nothing has been read. `unheld` is what makes the
 * middle one renderable at all — `null` and "nothing yet" would otherwise both arrive
 * at a row as "no holder" and the row could not tell a free lease from an unasked
 * question.
 */
export type TerminalControlHolding =
  | { readonly kind: "held"; readonly participantId: string }
  | { readonly kind: "unheld" }
  | { readonly kind: "unread" };

/**
 * The holding, read off the current state.
 *
 * A failed read and a read that has not landed are both `unread`: neither says
 * anything about who holds the lease, and rendering either as an unheld lease would
 * be the console asserting a session state on the strength of its own failure.
 */
export function terminalControlHolding(state: TerminalControlHolderState): TerminalControlHolding {
  if (state.kind !== "loaded") {
    return { kind: "unread" };
  }
  const { controlHolder } = state.value;
  return controlHolder === null
    ? { kind: "unheld" }
    : { kind: "held", participantId: controlHolder };
}

/** Why the holder is not here, or `undefined` where it is or is still coming. */
export function terminalControlHolderRefusal(
  state: TerminalControlHolderState,
): ConsoleRefusal | undefined {
  return state.kind === "failed" ? state.refusal : undefined;
}
