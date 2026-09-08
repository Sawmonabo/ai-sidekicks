// Recording the GROWTH seam of a fixture bridge, for cases that assert an absence.
//
// Its counterpart for the daemon seam is `withDaemonCall`, next door in
// `bridge.test-support.ts`, and this would sit beside it but for one fact:
// that module is already past the package's line ceiling, and the four growth helpers
// it still carries are what a later split moves out. This file is where they go, so
// adding the fifth here pays that split down instead of deepening it.

import type { ConsoleBridge } from "../../console-bridge.js";
import type { GrowthOperationId } from "../../growth-port/growth-entry.js";
import type { GrowthPort } from "../../growth-port/growth-port.js";

/** One bridge whose growth port records what it was asked, and that record. */
export interface GrowthPortUnderTest {
  readonly bridge: ConsoleBridge;
  /** Every growth operation this bridge was asked for, in the order it was asked. */
  readonly operationIds: readonly GrowthOperationId[];
}

/**
 * Wrap every operation on one bridge's growth port, so a case can assert an ABSENCE.
 *
 * `withDaemonCall`'s counterpart for the other seam, and here for the same reason: a
 * surface that must dispatch NOTHING is proved by a record of what it did dispatch, and
 * a suite that hand-built a port to count with would be asserting against a bridge no
 * window builds. Every operation delegates to the wrapped port, so the scenario answers
 * exactly as it would in the console and a case counting calls sits beside one reading
 * what they returned.
 *
 * Two casts, and both are the same one `withDaemonCall` makes for its own namespace:
 * the port is a mapped type over a closed id set, so a rebuilt object is assignable
 * only after the per-operation request and value types have been erased. What survives
 * is the id set — every key here came off the real port's own keys.
 */
export function withRecordedGrowth(bridge: ConsoleBridge): GrowthPortUnderTest {
  const operationIds: GrowthOperationId[] = [];
  const recorded = Object.fromEntries(
    Object.entries(bridge.growth).map(([operationId, operation]) => [
      operationId,
      async (request: unknown): Promise<unknown> => {
        operationIds.push(operationId as GrowthOperationId);
        return await (operation as (asked: unknown) => Promise<unknown>)(request);
      },
    ]),
  ) as unknown as GrowthPort;
  return { operationIds, bridge: { ...bridge, growth: recorded } };
}
