// One coordinator for every mutation this family offers.
//
// WHY IT IS ONE CLASS AND NOT ONE PER SURFACE
//
// The membership ledger changes a role, suspends, reactivates, and revokes; the
// sent-invite ledger revokes. Five controls, one shape: exactly one
// may be in flight at a time, the pressed control settles in place, the daemon's
// refusal renders against the row that asked for it, and nothing is applied
// locally before the call returns. Written per surface that is two copies of a
// state machine whose bug — a stale refusal surviving the next attempt — is
// invisible until somebody presses twice. Hoisted on its second use, per
// `apps/desktop/AGENTS.md`.
//
// ONE AT A TIME IS ENFORCED HERE AND NOT ONLY DRAWN
//
// A surface disables the controls it knows about, and a surface is not the only
// caller: a second press that arrived before the first re-render, a second body
// mounted against the same coordinator, or a control a later change forgets to
// disable would each start a second call. So `run` refuses rather than calls
// while one is unsettled. It refuses AUDIBLY, against the key that was attempted,
// because a press that vanishes is indistinguishable from one the daemon ignored.
// It does not queue: a membership change held and applied later is a second act
// nobody re-confirmed, against a row whose state may have moved underneath it.
//
// WHY THE REFUSAL IS KEYED
//
// A section holds several rows and each can refuse differently: one membership
// answers `membership.last_owner` while its neighbour answers nothing at all.
// A single "last error" field would render the wrong row's refusal beside the
// right row's control. The key is whatever the caller uses to name the subject —
// a membership id or an invite id.
//
// AND WHY THE SUBJECT MOVING IS A DIFFERENT QUESTION FROM A SECOND PRESS
//
// A key names one ROW. The surface that holds those rows has a subject of its own —
// the session the ledger belongs to — and that subject can move out from under a
// call already in flight, which no keyed refusal can express: the row the reply
// names does not exist in the session now on screen, and the latch it releases
// would be releasing a control nobody in this session ever pressed. So a holder
// whose subject moves calls `supersede`, and the round in flight stops being able
// to publish anything at all. Nothing is cancelled — nothing behind the bridge is
// cancellable — the reply simply installs nowhere. `store/generation-latch.ts` is
// the console's one mechanism for that and is used here rather than re-counted.
//
// WHERE THE PARSE IS NOT
//
// This module holds no reading of a reply and no reading of a rejection. Both are
// `bridge/daemon/daemon-reply.ts`, which parses the request before it goes and the reply
// when it lands and answers one closed value either way — so what arrives here is
// already `served` or `refused`, and there is nothing left for a coordinator to
// narrow, cast, or catch. What it adds is the part that is genuinely its own: which
// subject key a refusal belongs to, and the console's own rule that a second press
// while one act is unsettled is answered rather than sent.

import { useCallback, useSyncExternalStore } from "react";

import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import { GenerationLatch } from "../store/index.js";
import {
  callDaemon,
  type ConsoleBridge,
  type ConsoleDaemonMethod,
  type DaemonReply,
  type DaemonRequestOf,
  type DaemonResponseOf,
} from "../bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const COLLABORATION_REFUSAL_ORIGIN = "collaboration";

/**
 * The code a press refused for arriving while another mutation is unsettled.
 *
 * Console-local rather than a wire code, and named so it reads as one: nothing was
 * sent, so no daemon namespace may be quoted here. A refusal wearing
 * `membership.conflict` would attribute this console's own rule to the daemon.
 */
const MUTATION_IN_FLIGHT_CODE = "mutation-in-flight";

/**
 * What one mutation call does.
 *
 * A function rather than a bridge handle, so a test drives the real coordinator
 * against a stub CALL instead of standing in for the coordinator itself.
 *
 * It answers a {@link DaemonReply} rather than resolving or rejecting, because that
 * is what the call door answers: a refusal is a value on the way back, never a
 * throw, so the coordinator has no `catch` in which to invent a second reading of
 * one. A stub written for a test answers the same closed value for the same reason.
 */
export type WireMutation<TRequest, TResponse> = (
  request: TRequest,
) => Promise<DaemonReply<TResponse>>;

/** What a surface renders the coordinator's state from. */
export interface WireMutationSnapshot {
  /** The subject key whose control is in flight, or `undefined` when none is. */
  readonly pendingKey: string | undefined;
  /** The last refusal per subject key. Cleared when that subject is attempted again. */
  readonly refusalByKey: Readonly<Record<string, ConsoleRefusal>>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_IN_FLIGHT: WireMutationSnapshot = {
  pendingKey: undefined,
  refusalByKey: {},
  revision: 0,
};

/**
 * The key the whole coordinator's round is on.
 *
 * One key for the whole subject rather than one per row, because that IS the rule:
 * what supersedes an attempt is the subject moving, and the subject moves once for
 * every row at a time.
 */
const MUTATION_ROUND_KEY = "mutation-round";

/**
 * A mutation surface's state: what is in flight, and what refused.
 *
 * The snapshot is rebuilt on transition and held, rather than composed on each
 * read, because `useSyncExternalStore` compares snapshot identity — a getter
 * returning a fresh object each call renders forever.
 */
export class WireMutationCoordinator<TRequest, TResponse> {
  readonly #perform: WireMutation<TRequest, TResponse>;
  readonly #describeWhat: string;
  readonly #changes = new Emitter<WireMutationSnapshot>("wire mutation change");
  /**
   * Which round of mutations the holder's SUBJECT is on.
   *
   * ONE KEY, JOINED AND NEVER TAKEN. Advanced only by {@link supersede}, never by
   * an attempt: two presses against one subject are ordered by the pending key on
   * the snapshot, and a round that also moved on every press would make the first
   * call's own refusal stale — which is the defect `mutation-coordinator.test.ts`
   * pins. Claiming the key per attempt would put "is something in flight" in a
   * second place beside the pending key this snapshot has to carry anyway for the
   * row that renders the spinner, and two registers of one fact is what the
   * single-flight rule cannot afford.
   */
  readonly #rounds = new GenerationLatch();
  #snapshot: WireMutationSnapshot = NOTHING_IN_FLIGHT;

  public constructor(options: {
    readonly perform: WireMutation<TRequest, TResponse>;
    /** One noun for the refusal sentence — "the role change", "the invite". */
    readonly describeWhat: string;
  }) {
    this.#perform = options.perform;
    this.#describeWhat = options.describeWhat;
  }

  public snapshot(): WireMutationSnapshot {
    return this.#snapshot;
  }

  /**
   * Round keys this coordinator still holds. The release assertion, counted.
   *
   * A settled round gives its key back, and a reader that never gave one back would
   * hold it for this coordinator's whole life — which refuses every later act on the
   * key the moment anything else claims one. That is a property of the latch rather
   * than of anything on screen, so it is counted here in the shape
   * `seats/push-driven-read.ts` counts its reads: an instrument on the object that
   * owns the fact, never a second copy of it.
   */
  public get heldRoundCount(): number {
    return this.#rounds.heldKeyCount(this);
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Attempt one mutation against one subject.
   *
   * Resolves with the response when the daemon applied it and `undefined` when it
   * refused — the refusal is on the snapshot by then, so a caller that only needs
   * to know whether to move on reads the return value and a caller that renders
   * the reason reads the snapshot. Nothing is applied locally either way: this
   * class holds no copy of the subject it mutated.
   *
   * A call arriving while another is unsettled makes NO wire call. It takes the
   * refused arm, keyed to the subject it was attempted against, so the press is
   * answered on the row it came from.
   *
   * A call whose round was superseded while it was in flight resolves `undefined`
   * and publishes NOTHING — not its response, not its refusal. That is the same
   * arm a refused call takes, and it is the right one: the caller has no subject
   * left to install into, and a response is not a refusal to render either.
   */
  public async run(key: string, request: TRequest): Promise<TResponse | undefined> {
    const unsettledKey = this.#snapshot.pendingKey;
    if (unsettledKey !== undefined) {
      this.#publish({
        pendingKey: unsettledKey,
        refusalByKey: {
          ...this.#snapshot.refusalByKey,
          [key]: this.#refuseForUnsettled(unsettledKey),
        },
        revision: this.#snapshot.revision + 1,
      });
      return undefined;
    }
    const round = this.#rounds.currentClaim(this, MUTATION_ROUND_KEY);
    this.#publish({
      pendingKey: key,
      // The prior refusal for THIS subject is dropped on the attempt rather than
      // on its settlement, so a person pressing again does not read last time's
      // reason beside this time's spinner.
      refusalByKey: withoutKey(this.#snapshot.refusalByKey, key),
      revision: this.#snapshot.revision + 1,
    });
    // No `try`, because there is nothing to catch: the call door answers a refusal
    // as a value and never as a throw, so both arms below are the same settlement
    // read two ways rather than one path and one accident.
    const reply = await this.#perform(request);
    // THROUGH the round on both arms rather than beside it. `currentClaim` mints a
    // round on a free key, and a minted round releases that key inside `settle`'s own
    // `finally` and nowhere else — so reading `isCurrent` and publishing outside it
    // held `MUTATION_ROUND_KEY` under this coordinator for the coordinator's whole
    // life. That is benign only while nothing else claims on this latch, and it is
    // exactly the reader-holds-a-key failure `store/generation-latch.ts` names. Going
    // through `settle` installs and releases in one act, and answers whether the
    // install happened, so the superseded arm needs no second predicate.
    if (reply.status === "refused") {
      round.settle(() => {
        this.#publish({
          pendingKey: undefined,
          refusalByKey: { ...this.#snapshot.refusalByKey, [key]: reply.refusal },
          revision: this.#snapshot.revision + 1,
        });
      });
      return undefined;
    }
    const wasInstalled = round.settle(() => {
      this.#publish({
        pendingKey: undefined,
        refusalByKey: this.#snapshot.refusalByKey,
        revision: this.#snapshot.revision + 1,
      });
    });
    // A superseded round resolves `undefined` for the same reason it publishes
    // nothing: the caller has no subject left to install the response into.
    return wasInstalled ? reply.value : undefined;
  }

  /**
   * Abandon whatever is in flight, for the holder whose SUBJECT moved.
   *
   * What was running can no longer publish a settlement, a refusal, or a released
   * latch, and every keyed refusal already on the snapshot is dropped with it —
   * those refusals name rows of the subject being left, and rendering one against
   * the subject arriving would attribute a refusal to a row nobody there pressed.
   *
   * Idempotent and never terminal: superseding twice supersedes once, and a holder
   * that supersedes in a teardown is usable again on the next mount.
   */
  public supersede(): void {
    this.#rounds.supersedeAll();
    const held = this.#snapshot;
    if (held.pendingKey === undefined && Object.keys(held.refusalByKey).length === 0) {
      return;
    }
    this.#publish({ pendingKey: undefined, refusalByKey: {}, revision: held.revision + 1 });
  }

  /** Drop one subject's refusal — the dismiss a person presses on the notice. */
  public dismiss(key: string): void {
    if (!Object.hasOwn(this.#snapshot.refusalByKey, key)) {
      return;
    }
    this.#publish({
      pendingKey: this.#snapshot.pendingKey,
      refusalByKey: withoutKey(this.#snapshot.refusalByKey, key),
      revision: this.#snapshot.revision + 1,
    });
  }

  #publish(next: WireMutationSnapshot): void {
    this.#snapshot = next;
    this.#changes.emit(next);
  }

  /**
   * The refusal a press earns for arriving while another one is unsettled.
   *
   * It names the subject still running rather than saying "one at a time" and
   * leaving a person to work out which row is holding the surface — on a ledger of
   * many rows that is the whole of the answer.
   */
  #refuseForUnsettled(unsettledKey: string): ConsoleRefusal {
    return refuse(
      COLLABORATION_REFUSAL_ORIGIN,
      MUTATION_IN_FLIGHT_CODE,
      `${this.#describeWhat} was not applied. A change to ${unsettledKey} is still being applied, and only one runs at a time — wait for it to settle, then press again.`,
    );
  }
}

/** Read a coordinator's state inside a component. */
export function useWireMutation<TRequest, TResponse>(
  coordinator: WireMutationCoordinator<TRequest, TResponse>,
): WireMutationSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => coordinator.subscribe(onStoreChange),
    [coordinator],
  );
  const read = useCallback(() => coordinator.snapshot(), [coordinator]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * One registered daemon method, as the shape a coordinator consumes.
 *
 * DAEMON-AS-GATEWAY, per the shipped `invite-accept-view.tsx`: the renderer speaks
 * one transport and the daemon proxies the control-plane `invite.*` and
 * `membership.*` methods behind it. `controlPlane.call` is deliberately not used —
 * it would open a second seam this client does not have, and the one shipped caller
 * of these wires established which side of that line they sit on.
 *
 * The method is a member of the call door's own registry, so the request and the
 * response types are READ OFF IT rather than declared here: a caller naming a method
 * the registry does not bind does not compile, and one passing the wrong payload
 * does not either. Everything this adds is the binding — the bridge and the method
 * closed over — and nothing about what a reply means.
 */
export function daemonMutation<MethodName extends ConsoleDaemonMethod>(
  bridge: ConsoleBridge,
  method: MethodName,
): WireMutation<DaemonRequestOf<MethodName>, DaemonResponseOf<MethodName>> {
  return async (request) => await callDaemon(bridge, method, request);
}

function withoutKey(
  refusalByKey: Readonly<Record<string, ConsoleRefusal>>,
  key: string,
): Readonly<Record<string, ConsoleRefusal>> {
  if (!Object.hasOwn(refusalByKey, key)) {
    return refusalByKey;
  }
  const remaining: Record<string, ConsoleRefusal> = {};
  for (const [heldKey, refusal] of Object.entries(refusalByKey)) {
    if (heldKey !== key) {
      remaining[heldKey] = refusal;
    }
  }
  return remaining;
}
