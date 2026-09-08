// What the console knows about a session it started, and what a first send did about it.
//
// `auto-pin.ts` beside this file is the RULE — the five conjuncts, and nothing else.
// This is the seam the rule needed in order to fire at all, and until it existed the
// switch on the sessions destination changed its own persisted value and no session's
// placement: `autoPinDecision` had exactly two readers, the explanatory sentences
// under that switch and its own suite.
//
// THE TWO HALVES OF ONE ACT LIVE IN TWO FAMILIES, AND NEITHER MAY IMPORT THE OTHER.
// Only the sessions destination can report where a session came from — it authored
// the session, which is the one origin this console holds in full rather than guesses
// — and only the composer knows a first send happened, because the send path is the
// composer's. The composer is `src/renderer/src/shell/`, which sits above the whole
// console DAG and reaches it through family doors only; the sessions family is a view
// family, and view families are siblings with no edge between them. So the record
// they meet on is here, in the lowest family both can import, exactly as the pane,
// composer, sidebar, timeline-row and inline-card contracts are.
//
// KEYED ON THE BRIDGE, AND THAT IS WHAT MAKES IT SAFE RATHER THAN TIDY. The durable
// half of the rule — the persisted switch and the pin map — lives in a `UiStateStore`
// that `frame/ui-state-lifecycle.ts` mints once per bridge and REPLACES when the
// bridge or the scenario moves. A record that outlived that replacement would answer
// a first send by writing into a database nothing reads. Keyed on the bridge, the
// whole record goes when the bridge does: the markers, the settlements, and the
// durable authority retire together, and a session started under a superseded bridge
// answers `origin-unreported` — which is true, since nothing this window can reach
// still reports where that session came from. `absorbed-surfaces.ts` and
// `session-directory.ts` key their own per-bridge state the same way and for the same
// reason.
//
// A `WeakMap` rather than a `Map` because the key is the whole lifetime: a superseded
// bridge is unreachable the moment the provider drops it and its record goes with it,
// rather than accumulating one entry per scenario swap for the life of the window.
//
// THE PER-SESSION LEDGER IS A RECORD AND NOT A CACHE. Nothing in it is re-derivable
// from anywhere else — the origin markers exist nowhere on the wire, which is the
// whole reason the rule fails closed for every session the console did not start —
// so there is nothing to evict and re-read. It holds one small entry per START PRESS
// under one bridge and nothing for any other session: a directory row that reaches
// the composer settles `origin-unreported` and writes no entry at all. That keeps the
// record proportional to the acts a person performed, which is the rule the pin map
// itself follows one family over.
//
// THE DURABLE AUTHORITY IS INJECTED AND IS NEVER REACHED FOR. This family sits below
// the sessions family, so it cannot import the pin store or the preference store, and
// it must not mint its own: a second `SessionPinStore` over the same record would be
// two writers of one durable map. So the destination that holds both bindings hands
// them in as two verbs at the moment it stamps a session, and both verbs are LIVE —
// each resolves the current binding through the durable holder's own `acquire` on
// every call — so a settlement reads the switch as it stands when the send lands
// rather than as it stood when the session was started, and a pin written after the
// destination has unmounted still lands in the store this window is running on.

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  autoPinDecision,
  type AutoPinRefusalReason,
  type SessionOriginEvidence,
} from "./auto-pin.js";

/**
 * Why a send did not pin: the rule's own reasons, plus the one gate this port owns.
 *
 * Derived from the rule's union rather than restated, so a conjunct added there is a
 * compile error at every reader here. The added member is not a conjunct and could
 * not be one: the rule is a predicate over a session's origin, and whether this is
 * the FIRST send is a fact about the ledger below rather than about the session.
 */
export type AutoPinSettlementReason = AutoPinRefusalReason | "not-the-first-send";

/** What a send did about the session it was sent into. */
export type AutoPinSettlement =
  | { readonly pinned: true }
  | { readonly pinned: false; readonly because: AutoPinSettlementReason };

/**
 * The durable half of the rule, as two verbs the party that owns it hands in.
 *
 * A READER and not a value for the switch, deliberately. A boolean captured when the
 * session was started would be a second copy of a durable record — the shape the
 * persistence chokepoint exists to prevent — and it would answer a send made after
 * somebody turned the switch off with the state it had before they did.
 */
export interface SessionAutoPinAuthority {
  /** The persisted switch, read now rather than when the session was started. */
  readAutoPinOnFirstSend(): boolean;
  /** Put one session on the front tier. The pin store's own write, and never a copy. */
  pinToFront(sessionId: string): void;
}

/** The session was pinned. Frozen at module level, so a settlement is one object. */
const PINNED: AutoPinSettlement = { pinned: true };

/**
 * Nothing this window can reach reports where the session came from.
 *
 * The answer for every session the console did not start, and for one it started
 * under a bridge that has since been replaced. It is the rule's own fail-closed arm
 * rather than a reason of this module's, because it is the same fact: a marker that
 * cannot be read is not evidence that the session has an ordinary origin.
 */
const ORIGIN_UNREPORTED: AutoPinSettlement = { pinned: false, because: "origin-unreported" };

/** The send is not the first one into this session, so the rule has already answered. */
const NOT_THE_FIRST_SEND: AutoPinSettlement = { pinned: false, because: "not-the-first-send" };

/**
 * One bridge's record: what it started, what it settled, and who writes durably for it.
 *
 * A class with private fields rather than three maps on the port above, because the
 * three move together and the invariant is over the set of them — a session with
 * markers and no authority is a session this port must not answer for, and that is
 * only checkable where the three have one owner.
 */
class BridgeAutoPinRecord {
  readonly #originBySessionId = new Map<string, SessionOriginEvidence>();
  readonly #settlementBySessionId = new Map<string, AutoPinSettlement>();
  #authority: SessionAutoPinAuthority | undefined;

  /**
   * Stamp one session's origin, and take the durable verbs with it.
   *
   * The authority is REPLACED on every stamp rather than kept from the first. Both
   * verbs resolve through a durable holder that a later mount of the sessions
   * destination re-mints, and the newest one is the one whose holder is live — so a
   * window that has been back to the list twice writes through the binding it is
   * holding now.
   */
  public record(
    sessionId: string,
    origin: SessionOriginEvidence,
    authority: SessionAutoPinAuthority,
  ): void {
    this.#originBySessionId.set(sessionId, origin);
    this.#authority = authority;
  }

  /** What a send already settled for this session, or `undefined` while none has. */
  public settlementFor(sessionId: string): AutoPinSettlement | undefined {
    return this.#settlementBySessionId.get(sessionId);
  }

  /**
   * Settle one send against the rule, and perform the pin where it says to.
   *
   * THE SETTLEMENT IS RECORDED BEFORE THE WRITE, so a second send can never re-put a
   * pin whichever way the first one went. The ledger is the gate rather than the pin
   * map: a person who moved the session back to the rear tier themselves has made a
   * decision, and re-pinning it on their next message would overwrite it.
   */
  public settleFirstSend(sessionId: string): AutoPinSettlement {
    const settled = this.#settlementBySessionId.get(sessionId);
    if (settled !== undefined) {
      return NOT_THE_FIRST_SEND;
    }
    const origin = this.#originBySessionId.get(sessionId);
    const authority = this.#authority;
    if (origin === undefined || authority === undefined) {
      return ORIGIN_UNREPORTED;
    }
    const decision = autoPinDecision({
      isSettingEnabled: authority.readAutoPinOnFirstSend(),
      origin,
    });
    const settlement: AutoPinSettlement = decision.pins
      ? PINNED
      : { pinned: false, because: decision.because };
    this.#settlementBySessionId.set(sessionId, settlement);
    if (decision.pins) {
      authority.pinToFront(sessionId);
    }
    return settlement;
  }
}

/**
 * This window's auto-pin records, one per bridge.
 *
 * A class with private fields rather than a module-level `Map`, on the rule
 * `apps/desktop/AGENTS.md` §State and views states and the precedent
 * `absorbed-surfaces.ts` sets in this family: module scope is WINDOW scope here,
 * since an auxiliary window is its own renderer process and no channel joins two
 * windows' module graphs.
 */
class SessionAutoPinPort {
  readonly #recordByBridge = new WeakMap<ConsoleBridge, BridgeAutoPinRecord>();

  public record(
    bridge: ConsoleBridge,
    sessionId: string,
    origin: SessionOriginEvidence,
    authority: SessionAutoPinAuthority,
  ): void {
    const held = this.#recordByBridge.get(bridge) ?? new BridgeAutoPinRecord();
    held.record(sessionId, origin, authority);
    this.#recordByBridge.set(bridge, held);
  }

  public settleFirstSend(bridge: ConsoleBridge, sessionId: string): AutoPinSettlement {
    return this.#recordByBridge.get(bridge)?.settleFirstSend(sessionId) ?? ORIGIN_UNREPORTED;
  }

  public settlementFor(bridge: ConsoleBridge, sessionId: string): AutoPinSettlement | undefined {
    return this.#recordByBridge.get(bridge)?.settlementFor(sessionId);
  }
}

/** This window's port. Not exported: the three doors below are the way in. */
const sessionAutoPinPort = new SessionAutoPinPort();

/**
 * Record that this console started a session, with the markers only it can assert.
 *
 * FOR A SETTLED CREATE AND NEVER FOR A PRESS, on the rule
 * `requestSessionDirectoryRead` states one module over: the caller has the session
 * the daemon minted, so the markers are stamped against a session that exists rather
 * than against a call still in flight.
 */
export function recordConsoleStartedSession(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly origin: SessionOriginEvidence;
  readonly authority: SessionAutoPinAuthority;
}): void {
  sessionAutoPinPort.record(options.bridge, options.sessionId, options.origin, options.authority);
}

/**
 * Settle the auto-pin rule for one send, and pin where the rule says to.
 *
 * Called on every settled send rather than only on ones the caller believes are
 * first: which send is the first is this port's own ledger to answer, and a composer
 * deciding for itself would be a second record of a fact that has one home.
 */
export function settleFirstSendAutoPin(
  bridge: ConsoleBridge,
  sessionId: string,
): AutoPinSettlement {
  return sessionAutoPinPort.settleFirstSend(bridge, sessionId);
}

/** What a send settled for one session, or `undefined` while none has been settled. */
export function firstSendAutoPinSettlement(
  bridge: ConsoleBridge,
  sessionId: string,
): AutoPinSettlement | undefined {
  return sessionAutoPinPort.settlementFor(bridge, sessionId);
}
