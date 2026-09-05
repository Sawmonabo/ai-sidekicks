// The approvals surface's state, and the only object in it that talks to a wire.
//
// A class with private fields rather than a pile of `useState` calls, because the
// rules this surface has to keep are rules about a MACHINE and not about a render:
//
//   • **Two reads, one scheduler.** Both the projection read and the standing-rule
//     list refresh through `store/scheduling.ts`'s `RefreshScheduler`, which is the
//     console's one refresh chokepoint (`Spec-023 §Rules every console surface
//     obeys`). Nothing here arms a timer of its own and nothing polls.
//   • **A control is disabled while ITS call is in flight, and only that one.**
//     THIS SURFACE'S OWN RULE, because no committed document states it: exactly one
//     call per answer. A single global busy flag would also disable the other cards,
//     and a per-record set is what says which card is actually waiting.
//   • **Silence never grants.** No arm of this class settles an approval locally.
//     The only writer of a record's state is the next projection read.
//   • **Refusals are values, not exceptions.** Every rejection is normalised into
//     the console's one `ConsoleRefusal` shape and kept beside the record it
//     belongs to, so `primitives/Refusal` renders it without translating anything.
//
// WHAT IT DOES NOT DO. It never filters by state — the history rule
// `approvals-wire.ts` states is that the read is unfiltered and the surface drops
// nothing. It never decodes a lifecycle
// payload: `noteLifecycleSignal` takes a wire-verbatim kind and asks for a re-read,
// which is the whole of what those five events are for.

import {
  ConsoleRefusalError,
  Emitter,
  isConsoleRefusal,
  refuse,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { RefreshScheduler, type RefreshReason } from "../../store/index.js";
import { wireRejectionToError } from "../../../../../shared/wire-errors.js";
import {
  type ApprovalRecord,
  type GrowthOutcome,
  type ParsedRows,
  type RememberedRule,
} from "../../bridge/index.js";
import {
  readApprovals,
  readRememberedRules,
  resolveApproval,
  revokeRememberedRule,
  type ApprovalResolveRequest,
} from "./approvals-wire.js";

/** The subsystem name every refusal this surface raises carries. */
export const APPROVALS_REFUSAL_ORIGIN = "approvals";

/**
 * Where one read has got to.
 *
 * Four arms because these are four different sentences and `Spec-023 §Meridian, the
 * design language` rule 8 forbids collapsing any two — "A renderer that collapses
 * two of these into one is wrong": nobody has asked, a read is in flight, a read
 * answered (with however many rows, including none), and a read was refused.
 */
export type ReadPhase<TRow> =
  | { readonly status: "not-checked" }
  | { readonly status: "loading" }
  | {
      readonly status: "answered";
      readonly rows: readonly TRow[];
      readonly unreadableCount: number;
    }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Everything a render of this surface reads. One immutable value per transition. */
export interface ApprovalsSnapshot {
  readonly approvals: ReadPhase<ApprovalRecord>;
  readonly rules: ReadPhase<RememberedRule>;
  /** Records whose resolve call is in flight. Their two actions are disabled. */
  readonly resolvingApprovalIds: ReadonlySet<string>;
  readonly resolveRefusalByApprovalId: ReadonlyMap<string, ConsoleRefusal>;
  /** Rules whose revoke call is in flight. */
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly revokeRefusalByRuleId: ReadonlyMap<string, ConsoleRefusal>;
}

export interface ApprovalsReaderOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /**
   * The clock every timer this surface arms is minted through.
   *
   * Required rather than defaulted, so a caller cannot accidentally leave the
   * fixture reading the wall clock — §The fixture bridge makes the frozen clock the
   * only clock the renderer reads in fixture mode.
   */
  readonly clock: ConsoleClock;
}

const EMPTY_SNAPSHOT: ApprovalsSnapshot = {
  approvals: { status: "not-checked" },
  rules: { status: "not-checked" },
  resolvingApprovalIds: new Set(),
  resolveRefusalByApprovalId: new Map(),
  revokingRuleIds: new Set(),
  revokeRefusalByRuleId: new Map(),
};

export class ApprovalsReader {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #scheduler: RefreshScheduler;
  readonly #changes = new Emitter<ApprovalsSnapshot>("approvals snapshot");
  #snapshot: ApprovalsSnapshot = EMPTY_SNAPSHOT;
  #disposed = false;

  public constructor(options: ApprovalsReaderOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performReads();
      },
      // A read that rejects is already recorded as a refusal on the phase it
      // belongs to, so re-throwing here would only surface the same fact a second
      // time as an unhandled rejection.
      onError: () => undefined,
    });
  }

  /** The value a render reads. Stable between transitions, so `Object.is` works. */
  public get snapshot(): ApprovalsSnapshot {
    return this.#snapshot;
  }

  /** Subscribe to transitions. Returns an idempotent unsubscribe. */
  public subscribe(sink: (snapshot: ApprovalsSnapshot) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Ask for a read.
   *
   * `subscribe` on mount, `window-focus` when the window regains it, `reconnect`
   * when the session store's degraded flag clears, and `terminal-event` for a
   * lifecycle signal — the four reasons the section this module's header cites
   * names, and no interval.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    if (this.#snapshot.approvals.status === "not-checked") {
      this.#update({ approvals: { status: "loading" }, rules: { status: "loading" } });
    }
    this.#scheduler.request(reason);
  }

  /**
   * Answer one request. Exactly one call, and the record's controls stay disabled
   * until it settles.
   *
   * A repeated call for a record already in flight is dropped rather than sent:
   * the one-call-per-answer rule above, and a double click is the most ordinary way
   * to send two.
   */
  public resolve(request: ApprovalResolveRequest): void {
    if (this.#disposed || this.#snapshot.resolvingApprovalIds.has(request.approvalRequestId)) {
      return;
    }
    this.#update({
      resolvingApprovalIds: withMember(
        this.#snapshot.resolvingApprovalIds,
        request.approvalRequestId,
      ),
      resolveRefusalByApprovalId: withoutKey(
        this.#snapshot.resolveRefusalByApprovalId,
        request.approvalRequestId,
      ),
    });
    void resolveApproval(this.#bridge, request).then((outcome) => {
      // Deliberately nothing about the record's state on the served arm. The reply
      // confirms the request; what the record BECAME is the next projection read's
      // answer, and a card that settled itself here would be the renderer deciding
      // an authorization outcome.
      this.#clearResolving(request.approvalRequestId);
      if (outcome.status === "unavailable") {
        this.#update({
          resolveRefusalByApprovalId: withEntry(
            this.#snapshot.resolveRefusalByApprovalId,
            request.approvalRequestId,
            outcome,
          ),
        });
      }
      // A concurrent resolver's `approval.already_resolved` drops the card on the
      // next signal re-read, so the surface asks for one on BOTH arms rather than
      // leaving a stale pending card beside a refusal that explains why it is stale.
      this.requestRead("terminal-event");
    });
  }

  /** Revoke one standing permission. Fired only by a confirming click. */
  public revokeRule(ruleId: string): void {
    if (this.#disposed || this.#snapshot.revokingRuleIds.has(ruleId)) {
      return;
    }
    this.#update({
      revokingRuleIds: withMember(this.#snapshot.revokingRuleIds, ruleId),
      revokeRefusalByRuleId: withoutKey(this.#snapshot.revokeRefusalByRuleId, ruleId),
    });
    void revokeRememberedRule(this.#bridge, ruleId).then((outcome) => {
      this.#clearRevoking(ruleId);
      if (outcome.status === "unavailable") {
        this.#update({
          revokeRefusalByRuleId: withEntry(this.#snapshot.revokeRefusalByRuleId, ruleId, outcome),
        });
      }
      this.requestRead("terminal-event");
    });
  }

  /** Terminal. The scheduler is dropped, so no read can outlive the pane. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#changes.clear();
  }

  async #performReads(): Promise<void> {
    // `Promise.all` rather than `allSettled`: the port never rejects, so a settled
    // wrapper here would be a second failure vocabulary over a seam that already has
    // exactly one, and the two `unavailable` arms below are what a refusal is.
    const [approvals, rules] = await Promise.all([
      readApprovals(this.#bridge, this.#sessionId),
      readRememberedRules(this.#bridge, this.#sessionId),
    ]);
    if (this.#disposed) {
      return;
    }
    this.#update({
      approvals: readPhaseFor(approvals),
      rules: readPhaseFor(rules),
    });
  }

  #clearResolving(approvalRequestId: string): void {
    this.#update({
      resolvingApprovalIds: withoutMember(this.#snapshot.resolvingApprovalIds, approvalRequestId),
    });
  }

  #clearRevoking(ruleId: string): void {
    this.#update({ revokingRuleIds: withoutMember(this.#snapshot.revokingRuleIds, ruleId) });
  }

  #update(patch: Partial<ApprovalsSnapshot>): void {
    if (this.#disposed) {
      return;
    }
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#changes.emit(this.#snapshot);
  }
}

/**
 * One growth outcome, as the phase a render reads.
 *
 * The port answers `served` or `unavailable` and NEVER rejects, so there is no
 * rejection to normalize here and no third arm to guard against. `GrowthUnavailable`
 * extends `ConsoleRefusal` structurally, which is why the refused arm carries the
 * outcome itself: the refusal a person reads still names the operation that refused
 * and the document that owes its wire, rather than a sentence this surface composed.
 */
function readPhaseFor<TRow>(outcome: GrowthOutcome<ParsedRows<TRow>>): ReadPhase<TRow> {
  return outcome.status === "unavailable"
    ? { status: "refused", refusal: outcome }
    : { status: "answered", ...outcome.value };
}

function withMember(held: ReadonlySet<string>, member: string): ReadonlySet<string> {
  const next = new Set(held);
  next.add(member);
  return next;
}

function withoutMember(held: ReadonlySet<string>, member: string): ReadonlySet<string> {
  const next = new Set(held);
  next.delete(member);
  return next;
}

function withEntry<TValue>(
  held: ReadonlyMap<string, TValue>,
  key: string,
  value: TValue,
): ReadonlyMap<string, TValue> {
  const next = new Map(held);
  next.set(key, value);
  return next;
}

function withoutKey<TValue>(
  held: ReadonlyMap<string, TValue>,
  key: string,
): ReadonlyMap<string, TValue> {
  if (!held.has(key)) {
    return held;
  }
  const next = new Map(held);
  next.delete(key);
  return next;
}
