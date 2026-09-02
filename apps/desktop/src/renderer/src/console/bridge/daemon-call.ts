// The one place the console widens the daemon namespace's two branded signatures.
//
// `SidekicksBridge.daemon.call` takes `DaemonMethod` — a `never`-shaped brand
// standing in for Plan-007's method union — and answers `DaemonResult<M>`, which
// resolves to `unknown` until that union lands; `daemon.subscribe` is branded the
// same way. Every caller therefore has to widen the signature, and callers widening
// it independently would be several subtly different claims about one wire.
//
// WHY IT LIVES IN `bridge/` AND NOT IN A CALLER'S FAMILY. It was written first
// inside `shell/composer/accessories/daemon-calls.ts`, which was correct while the
// composer accessories were the only callers. The approvals pane is the second
// family to need it, and `apps/desktop/AGENTS.md` says a helper used by two modules
// is hoisted on the second use, to the lowest family in the DAG that both can
// reach. That family is this one: `bridge/` owns the bridge, sits below every view
// family, and is where a claim about the bridge's own signatures belongs. The
// composer's module keeps its method-name constants and reaches these two through
// this door, so no accessory's import path moves.
//
// WHAT THE WIDENING ADMITS, AND WHAT IT DOES NOT. The method or stream name is
// pinned to `string` — the genuinely untypeable half — and the reply is left
// `unknown`, which is honest: a tighter reply type here would be a fiction, and
// every caller narrows through a schema before rendering a figure from it. Nothing
// here invents a name; each caller quotes a row of a registry the corpus publishes.
//
// Both take the BRIDGE rather than a raw namespace, so `window.sidekicks` stays
// inside `BridgeProvider.tsx` and every caller reaches the wire through a value it
// was handed.

import type { Unsubscribe } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** Call one daemon method. The reply is `unknown` and the caller narrows it. */
export function callDaemon(
  bridge: ConsoleBridge,
  method: string,
  params: unknown,
): Promise<unknown> {
  const call = bridge.sidekicks.daemon.call as (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  return call(method, params);
}

/** Subscribe to one daemon stream. Widened the same way and for the same reason. */
export function subscribeDaemon(
  bridge: ConsoleBridge,
  streamName: string,
  handler: (payload: unknown) => void,
): Unsubscribe {
  const subscribe = bridge.sidekicks.daemon.subscribe as (
    event: string,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  return subscribe(streamName, handler);
}
