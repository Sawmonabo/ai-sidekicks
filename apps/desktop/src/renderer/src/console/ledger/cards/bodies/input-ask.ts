// The input ask, read off a row's open payload — and what the card may not decide.
//
// WHY THIS IS A READER AND NOT A PARSE. The four `driver_ask.*` types are registered
// in the event taxonomy and NO payload variant is registered for them, so a timeline
// row carries the ask as the open `Record<string, unknown>` every projected row
// carries. `wire-payload.ts` states the discipline for exactly this case: two typed
// readers over an open record, an absent or wrongly-typed member reading as
// `undefined`, and the surface rendering the named absence rather than a coerced
// value. This module is that discipline applied to the ask's own members.
//
// THE THREE THINGS THE CARD MUST NEVER DO, and this module is where two of them are
// made structurally impossible:
//
//   • Never settle a terminal locally. The state is read from the row's own event
//     TYPE, wire-verbatim, and there is no code path here that computes one. A
//     countdown that reaches zero changes nothing about the state — the surface
//     waits for the `driver_ask.expired` row, because an input ask that expires
//     parks its run and a card that decided it had timed out could show a park that
//     never happened.
//   • Never synthesize `options`. The member is additive-optional and its absence
//     means the provider offered no choice set the driver could represent. The
//     reader below drops a malformed entry rather than repairing it, and a set that
//     reads as nothing is a set that renders as nothing.
//   • Never render a permission-kind ask here. Permission asks ride the approvals
//     surface; `isInputAsk` is the filter, and it is a positive test on the literal
//     rather than "not permission", so an ask whose kind this build does not know is
//     excluded rather than admitted by default.
//
// THE EXPIRY IS A DISPLAY OF A STAMP AND NEVER A SECOND CLOCK. `expiresAt` is read
// verbatim and handed to the caller; nothing here compares it to a time. The card
// renders the remaining interval from the console's own clock and says "waiting for
// the daemon" once it reaches zero, which is a statement about what the surface is
// doing rather than about what the ask has become.

import {
  driverAskIdentitySegments,
  readWireString,
  structuralKey,
  type ConsoleRefusal,
} from "../../../core/index.js";
import type { OwnerSlotContract } from "../../../seats/index.js";
import type { RunId, TimelineRow } from "@ai-sidekicks/contracts";
import { projectedPayload } from "../wire-payload.js";

/**
 * Who owns the ask body, what this card owes it, and where the shell dies.
 *
 * Developer-facing and never rendered. The obligation names the ingress explicitly
 * because it is the one thing about this surface that is easy to get wrong: the
 * answer travels an ALREADY-REGISTERED method, so no wire is minted for it and no
 * growth-slate row is owed.
 */
export const INPUT_ASK_SLOT: OwnerSlotContract = {
  owningTask: "the timeline plan's input-ask card (the structured-input ask surface)",
  mountObligation:
    "the ask row's body, given the ask read wire-verbatim off the row, a dispatcher for the registered driver answer method, and where the answer that dispatcher last sent has got to — the card composes the answer, renders what the wire said about it, and never invents the ask's state",
  deleteShellIn:
    "the change that authors the ask card deletes this shell rather than leaving it beside the body",
};

/** The four event types this surface renders, and the only ones it renders. */
export const DRIVER_ASK_EVENT_TYPES = [
  "driver_ask.requested",
  "driver_ask.responded",
  "driver_ask.expired",
  "driver_ask.canceled",
] as const;

/** One ask state. Derived from the event types, never restated as a second union. */
export type DriverAskState = "requested" | "responded" | "expired" | "canceled";

/**
 * The state each event type names. Total over the four types by construction, so a
 * fifth type added to the tuple above fails to compile here rather than reaching a
 * card that renders it as a pending ask.
 */
const STATE_BY_EVENT_TYPE: Readonly<
  Record<(typeof DRIVER_ASK_EVENT_TYPES)[number], DriverAskState>
> = {
  "driver_ask.requested": "requested",
  "driver_ask.responded": "responded",
  "driver_ask.expired": "expired",
  "driver_ask.canceled": "canceled",
};

/** One offered answer, as the provider declared it. */
export interface DriverAskOption {
  readonly value: string;
  /** The provider's own label, where it supplied one. Never composed from `value`. */
  readonly label: string | undefined;
}

/** One input ask, as much of it as the row's payload actually carries. */
export interface DriverAskReading {
  readonly askId: string;
  /**
   * The run this ask blocks, off the row's own arm — `undefined` on a row attributing
   * none.
   *
   * CARRIED BECAUSE `askId` ALONE IS NOT AN IDENTITY. The id is the provider's, minted
   * per provider session, so two runs answering in parallel legitimately raise asks
   * under one id; the registered answer request addresses a run AND a request for the
   * same reason. It is read off the row rather than off the payload because the row is
   * where the projection attributes a run, and the ask row and the answer this surface
   * dispatches then name the same one by construction.
   */
  readonly runId: RunId | undefined;
  readonly state: DriverAskState;
  /** The provider's question. `undefined` where the ask carried none. */
  readonly prompt: string | undefined;
  /** The declared choice set, or empty where the ask offered none. Never synthesized. */
  readonly options: readonly DriverAskOption[];
  /** The daemon's stamped deadline, verbatim. `undefined` on a pre-stamp row. */
  readonly expiresAt: string | undefined;
  /** The delivered answer, rendered verbatim on the `responded` row alone. */
  readonly deliveredAnswer: string | undefined;
}

/**
 * Where the answer this surface last dispatched has got to.
 *
 * A DIFFERENT FACT FROM `DriverAskState`, AND THE CARD MAY NEVER CONFUSE THE TWO. That
 * state is read from the row's own event type and says what the DAEMON has recorded;
 * this says what the console did with a press and what came back off the wire. So
 * `accepted` means the answer reached the driver and the surface is waiting for the
 * `driver_ask.responded` row — the same sentence the countdown says past zero, about
 * the console rather than about the ask — and nothing here ever renders a terminal.
 *
 * WHY THE REPLY IS HELD AT ALL, which is the defect this shape answers. The dispatch
 * used to be fire-and-forget: a refused call — a transport that was down, a daemon
 * that rejected the request, a reply the registered schema does not admit — was
 * discarded, the free-text arm cleared its draft the instant it dispatched, and an
 * option press changed nothing on screen. The run stayed blocked on an ask nobody had
 * answered and the user was told none of it.
 *
 * THE RESPONSE TRAVELS ON EVERY ARM PAST `unsent` because two arms need it: `refused`
 * is what a retry re-sends and what keeps a draft that was never delivered, and
 * `delivering` is what a second press is refused against.
 */
export type DriverAskDelivery =
  | { readonly status: "unsent" }
  | { readonly status: "delivering"; readonly response: string }
  | { readonly status: "accepted"; readonly response: string }
  | {
      readonly status: "refused";
      readonly response: string;
      readonly refusal: ConsoleRefusal;
    };

/** Nothing dispatched. The state every ask starts in, as one frozen value. */
export const ASK_ANSWER_UNSENT: DriverAskDelivery = Object.freeze({ status: "unsent" });

/**
 * Read one row as an input ask, or answer that it is not one.
 *
 * `undefined` covers three distinct rejections and deliberately renders as the same
 * "this is not an ask row" for the caller: a row of another type, a permission-kind
 * ask, and an ask row carrying no usable `askId`. None of the three is a surface the
 * ledger's ask card may draw, and a caller that wanted to tell them apart would be
 * asking this reader to classify rows it does not own.
 */
export function readDriverAsk(row: TimelineRow): DriverAskReading | undefined {
  const state = STATE_BY_EVENT_TYPE[row.type as (typeof DRIVER_ASK_EVENT_TYPES)[number]];
  if (state === undefined) {
    return undefined;
  }
  const payload = projectedPayload(row);
  if (readWireString(payload["kind"]) !== "input") {
    return undefined;
  }
  const askId = readWireString(payload["askId"]);
  if (askId === undefined) {
    return undefined;
  }
  return {
    askId,
    // The `run` arm is the only one carrying an attribution, and the `general` arm is
    // the non-run arm by construction — so this narrows on `kind` rather than guessing
    // a run out of a payload member.
    runId: row.kind === "run" ? row.runId : undefined,
    state,
    prompt: readWireString(payload["prompt"]),
    options: readAskOptions(payload["options"]),
    expiresAt: readWireString(payload["expiresAt"]),
    // Only on the `responded` row, which is where the contract puts it. Reading it
    // on any other state would render a delivered answer for an ask that has none.
    deliveredAnswer: state === "responded" ? readWireString(payload["response"]) : undefined,
  };
}

/**
 * The terminal one ask reached, out of the terminals a window holds.
 *
 * The READ half of {@link driverAskIdentity}, and a plain function rather than the
 * hook's own body so the fold and the lookup are one seam a test can drive with no
 * tree at all. An absent map is an ask rendered outside a ledger, which is the row's
 * own reading being the whole truth about it.
 */
export function askTerminalIn(
  terminalsByAskIdentity: ReadonlyMap<string, DriverAskReading> | undefined,
  ask: DriverAskReading,
): DriverAskReading | undefined {
  const identity = driverAskIdentity(ask);
  return identity === undefined ? undefined : terminalsByAskIdentity?.get(identity);
}

/**
 * The terminal each ask in one window reached, keyed by run and ask id.
 *
 * WHY THIS IS A WINDOW FOLD AND NOT A ROW READ. The four `driver_ask.*` types are four
 * ROWS, not four states of one row: the request stays in the log exactly where it was
 * asked, and the answer, the expiry or the cancellation arrives later as a row of its
 * own. A card that read only its own row therefore kept offering answer controls beside
 * a terminal that had already landed — immediately for an answer delivered from another
 * window, and after any remount for one delivered from this one, because the delivery
 * state that had been standing in for the terminal is local to a mount and resets with
 * it. Neither the request row nor the reader over it can see the later row, so the
 * question is the WINDOW's and is answered once per window here.
 *
 * FIRST TERMINAL WINS. An ask settles once; a second terminal row for one ask is
 * either a duplicate delivery or a log that contradicts itself, and in both readings
 * the row that settled the ask is the first one. Taking the last would let a late
 * `canceled` overwrite the answer a user actually gave.
 *
 * AND THE KEY IS THE RUN'S AS WELL AS THE ASK'S. A provider mints its ask ids per
 * provider session, so two runs blocked at once legitimately raise `ask-1` each; keyed
 * on that id alone, one run's answer settled the other's card — it read as responded,
 * expired or canceled and lost its answer controls while its own run stayed blocked
 * with nobody able to answer it.
 */
export function deriveDriverAskTerminals(
  rows: readonly TimelineRow[],
): ReadonlyMap<string, DriverAskReading> {
  const terminalsByAskIdentity = new Map<string, DriverAskReading>();
  for (const row of rows) {
    const reading = readDriverAsk(row);
    if (reading === undefined || reading.state === "requested") {
      continue;
    }
    const identity = driverAskIdentity(reading);
    // A terminal attributing no run settles nothing: it cannot be matched to a request
    // without inventing an attribution, and a run-less key would be reachable from
    // every unattributed ask in the window at once.
    if (identity !== undefined && !terminalsByAskIdentity.has(identity)) {
      terminalsByAskIdentity.set(identity, reading);
    }
  }
  return terminalsByAskIdentity;
}

/**
 * One ask as its own row read it, settled by the terminal the window later holds.
 *
 * THE QUESTION STAYS THE REQUEST'S AND THE DISPOSITION COMES FROM THE TERMINAL. Only
 * `state` and `deliveredAnswer` are taken from the terminal row, because those are the
 * only two members that row is authoritative about: a `driver_ask.expired` payload
 * carries no prompt and no option set, so taking the whole reading would blank the
 * question a reader is looking at and replace it with the card's named absence.
 *
 * A reading that is already terminal is returned UNCHANGED rather than merged with
 * itself — the terminal row draws its own disposition, which is what it always did.
 */
export function askSettledBy(
  ask: DriverAskReading,
  terminal: DriverAskReading | undefined,
): DriverAskReading {
  if (terminal === undefined || ask.state !== "requested") {
    return ask;
  }
  return { ...ask, state: terminal.state, deliveredAnswer: terminal.deliveredAnswer };
}

/**
 * The key one ask is filed under inside a window: its run AND its ask id.
 *
 * PRIVATE, AND THE ONE PLACE THIS FAMILY'S KEY IS COMPOSED. The fold below writes with
 * it and {@link askTerminalIn} reads with it, so the two halves of the seam cannot
 * disagree about what "the same ask" is — which is the whole defect a second spelling
 * causes here, silently, on a screen that then removes a blocked run's answer controls.
 *
 * WHICH MEMBERS, AND IN WHICH ORDER, IS NOT THIS FAMILY'S QUESTION. It is
 * `core/driver-ask-identity.ts`', because the session header keys driver asks in a fold of
 * its own and a second answer there is the same defect pointing the other way. What is
 * this family's is the ENCODING, and it goes through `structuralKey` — the console's
 * one tuple-to-key encoder — rather than through a join of its own: a separator is
 * injective only while no segment can contain it, and both segments here are wire
 * strings this console did not author.
 *
 * `undefined` where the row attributed no run, which is that module's REFUSAL to
 * identify rather than a run-less key: an ask nothing attributes cannot be answered —
 * the registered answer request names a run — so filing one would make an unanswerable
 * ask able to settle an answerable one.
 */
function driverAskIdentity(ask: DriverAskReading): string | undefined {
  const segments = driverAskIdentitySegments(ask.runId, ask.askId);
  return segments === undefined ? undefined : structuralKey(segments);
}

/**
 * The declared choice set, with anything unreadable dropped.
 *
 * DROPPED AND NOT REPAIRED. An entry whose `value` is not a present wire string names
 * no answer this card could send, so offering it would put a control on screen that
 * cannot be pressed correctly. An entry with a `value` and no `label` is kept and
 * renders by its value — the label is the provider's and the console composes none.
 */
function readAskOptions(value: unknown): readonly DriverAskOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: DriverAskOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const optionValue = readWireString(record["value"]);
    if (optionValue !== undefined) {
      options.push({ value: optionValue, label: readWireString(record["label"]) });
    }
  }
  return options;
}
