// One coordinator for every mutation this family offers, and one cast for the
// method brand it has to get past.
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
// WHY THE REFUSAL IS KEYED
//
// A section holds several rows and each can refuse differently: one membership
// answers `membership.last_owner` while its neighbour answers nothing at all.
// A single "last error" field would render the wrong row's refusal beside the
// right row's control. The key is whatever the caller uses to name the subject —
// a membership id or an invite id.
//
// WHERE THE BRAND CAST IS NOT
//
// `daemon.call<M extends DaemonMethod>` takes a Plan-007 brand no string literal
// is assignable to, so every caller in this repository casts — and this family
// already keeps that cast in one place, `wire-access.ts`. This module reaches the
// wire through it rather than repeating it: a second copy would be a second thing
// to change when the brand narrows, and the module whose whole subject is the cast
// would no longer be the only one that knows about it.

import { useCallback, useSyncExternalStore } from "react";

import { normalizeWireRejection } from "../../../../shared/wire-errors.js";
import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { callDaemonMethod } from "./wire-access.js";

/** The subsystem name every refusal this module raises carries. */
export const COLLABORATION_REFUSAL_ORIGIN = "collaboration";

/**
 * What one mutation call does.
 *
 * A function rather than a bridge handle, so a test drives the real coordinator
 * against a stub CALL instead of standing in for the coordinator itself.
 */
export type WireMutation<TRequest, TResponse> = (request: TRequest) => Promise<TResponse>;

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
  #snapshot: WireMutationSnapshot = NOTHING_IN_FLIGHT;
  /**
   * Which attempt is current, so a settled call that is no longer the latest
   * writes nothing. A generation counter rather than an `AbortController`: the
   * bridge exposes no cancellation, so the honest claim is that a superseded
   * reply is IGNORED, not that its call was stopped.
   */
  #generation = 0;

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
   */
  public async run(key: string, request: TRequest): Promise<TResponse | undefined> {
    const generation = (this.#generation += 1);
    this.#publish({
      pendingKey: key,
      // The prior refusal for THIS subject is dropped on the attempt rather than
      // on its settlement, so a person pressing again does not read last time's
      // reason beside this time's spinner.
      refusalByKey: withoutKey(this.#snapshot.refusalByKey, key),
      revision: this.#snapshot.revision + 1,
    });
    try {
      const response = await this.#perform(request);
      if (generation === this.#generation) {
        this.#publish({
          pendingKey: undefined,
          refusalByKey: this.#snapshot.refusalByKey,
          revision: this.#snapshot.revision + 1,
        });
      }
      return response;
    } catch (rejection: unknown) {
      if (generation === this.#generation) {
        this.#publish({
          pendingKey: undefined,
          refusalByKey: {
            ...this.#snapshot.refusalByKey,
            [key]: this.#asRefusal(rejection),
          },
          revision: this.#snapshot.revision + 1,
        });
      }
      return undefined;
    }
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
   * Widen any rejection into the console's one refusal shape.
   *
   * `normalizeWireRejection` puts the wire code on `Error.name` — that is the
   * repository's single normalizer for this seam and rewriting it here would be
   * the second copy `src/shared/wire-errors.ts` exists to prevent. `total`
   * because a rejection crossing the preload boundary is `unknown`, and the
   * surface whose job is to SHOW a refusal must not throw while rendering one.
   */
  #asRefusal(rejection: unknown): ConsoleRefusal {
    const normalized = normalizeWireRejection(rejection, { total: true });
    return refuse(
      COLLABORATION_REFUSAL_ORIGIN,
      normalized.name,
      `${this.#describeWhat} was not applied. ${normalized.message}`,
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
 * One daemon method, typed to its contract shapes.
 *
 * DAEMON-AS-GATEWAY, per the shipped `invite-accept-view.tsx`: the renderer
 * speaks one transport and the daemon proxies the control-plane `invite.*` and
 * `membership.*` methods behind it. `controlPlane.call` is deliberately not used
 * — it would open a second seam this client does not have, and the one shipped
 * caller of these wires established which side of that line they sit on.
 *
 * The method name stays a `string` because `DaemonMethod` is a Plan-007 brand
 * that no literal satisfies yet; the REQUEST and RESPONSE are pinned to the
 * contract types, so a caller passing the wrong payload still fails to compile.
 * Both facts belong to `wire-access.ts`, which this delegates to — what is added
 * here is only the shape the coordinator consumes, a request-to-response function
 * with the bridge and the method already bound.
 */
export function daemonMutation<TRequest, TResponse>(
  bridge: ConsoleBridge,
  method: string,
): WireMutation<TRequest, TResponse> {
  return async (request: TRequest): Promise<TResponse> =>
    await callDaemonMethod<TRequest, TResponse>(bridge, method, request);
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
