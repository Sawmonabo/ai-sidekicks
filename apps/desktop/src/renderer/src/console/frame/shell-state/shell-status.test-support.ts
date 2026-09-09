// The two shell fixtures both suites in this directory drive against.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. The report binding and the
// runtime retry are two subjects with two suites, and each needs the same two things:
// a supervisor report that says the runtime is healthy, and a build that carries no
// shell wire at all. A second copy of either would let the two suites disagree about
// what a refusing port answers — which is the one thing both of them assert on.

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { SHELL_SCENARIO } from "../../bridge/scenario/shell.js";
import type { ShellReport } from "../../store/index.js";

/** A supervisor reporting a healthy runtime: the report every case starts from. */
export const CONNECTED_SHELL_REPORT: ShellReport = {
  connection: { kind: "connected" },
  negotiation: undefined,
  lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
  transport: "os-local",
  keystore: "available",
};

/**
 * A build that carries no shell wire at all: every growth operation refuses.
 *
 * The shipped refusing port and not a literal, so what these suites assert against is
 * the refusal a release build actually composes — the same code, the same origin, and
 * the sentence built from the operation's own slate row.
 */
export function refusingBridge(): ConsoleBridge {
  return {
    ...createFixtureBridge({ scenario: SHELL_SCENARIO }),
    growth: createRefusingGrowthPort(),
  };
}
