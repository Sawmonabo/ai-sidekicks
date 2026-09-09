// The scaffolding both absorbed-roster suites drive, written once.
//
// `node-roster-seam.test.tsx` and `node-roster-triggers.test.tsx` are two suites over
// one seam — what a read ANSWERED and when it is asked AGAIN — and they open the same
// way: a real fixture bridge over the settings deck, wound to the tick its roster names
// two machines at, and the one cast that turns a scenario's string session into the
// branded identifier the registered request takes. Restating either in the second file
// would be two claims about one fixture, and the copy is what goes stale.

import type { SessionId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../bridge/scenario/settings/settings.js";

/** The tick this scenario's roster names two machines at. */
export const BOTH_MACHINES_ONLINE_MS = 200;

/**
 * A scenario's session id, as the read seam is typed to take it.
 *
 * One cast in one place, matching the shipped mount's own `brandedSessionId`: a
 * scenario declares its session as a string and the registered request types it as a
 * brand, and spelling the cast at each call site would be a claim per site instead of
 * one.
 */
export function sessionIdOf(value: string): SessionId {
  return value as SessionId;
}

/** A real fixture bridge over the settings deck, wound to the tick its roster fills. */
export function bridgeWithRoster(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}
