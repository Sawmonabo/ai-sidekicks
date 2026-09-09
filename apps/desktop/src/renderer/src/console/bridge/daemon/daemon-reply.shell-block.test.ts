// The reply chokepoint on the SUPERVISOR arm: what a stopped shell closes, and what
// it leaves open.
//
// The third suite beside the parse and rejection ones, and it is its own enumeration
// for the same reason those two are: it says that a record method never reaches the
// transport while the supervisor is not serving, and that a read reaches it through
// every one of those conditions. Every case drives the REAL `callDaemon` over the
// REAL registry against the shipped fixture bridge with a REAL `FrameStore` bound to
// its gate, so what is asserted is what a release build does.
//
// THE TRANSPORT IS WATCHED, NOT INFERRED. Each case reads the recorded call list, so
// "refused at the door" is the claim that nothing was sent rather than the claim that
// something came back refused.

import type { ProviderAccountId, RunId, WorktreeId } from "@ai-sidekicks/contracts";

import { FrameStore } from "../../store/index.js";
import { REPORTED_CONNECTIONS, stateWith } from "../../store/shell/shell-state.test-support.js";
import { callDaemon, DAEMON_REPLY_REFUSAL_ORIGIN } from "./daemon-reply.js";
import { refusalOf, SESSION_ID } from "./daemon-reply.test-support.js";
import { bridgeAnswering } from "../fixture/call-plane/bridge.test-support.js";
import type { ShellConnection } from "../../store/index.js";
import type { ConsoleBridge } from "../console-bridge.js";

/**
 * The run the control cases name.
 *
 * Branded through the same seam the parse suite next door uses: the value still has
 * to satisfy the branded SCHEMA wherever a case reaches the request parse, so a cast
 * to a malformed id fails the assertion rather than slipping past it.
 */
const RUN_ID = "019b79ee-0280-7f00-8110-a11ce0000009" as RunId;

/** The comparand every guarded run control carries. */
const EXPECTED_RUN_VERSION = 3;

/** The worktree the repo write names. Same seam. */
const WORKTREE_ID = "019b79ee-0280-7f00-8110-a11ce000000a" as WorktreeId;

/** The provider account the probe names. Same seam. */
const ACCOUNT_ID = "019b79ee-0280-7f00-8110-a11ce000000b" as ProviderAccountId;

/**
 * Bind a window whose supervisor is in one condition to the bridge's gate.
 *
 * Through the store's own `publishShellReport` rather than by writing state, so the
 * suite drives the same path the shell binding drives and a report the store would
 * have rejected as unchanged is rejected here too.
 */
function windowReporting(bridge: ConsoleBridge, connection: ShellConnection): FrameStore {
  const frameStore = new FrameStore();
  const { sessionRecovery: _ignored, ...report } = stateWith(connection);
  frameStore.publishShellReport(report);
  bridge.shellCondition.bindFrameStore(frameStore);
  return frameStore;
}

describe("callDaemon — a record is refused at the door while the shell is not serving", () => {
  it("refuses a run control with the block's own code and sends nothing", async () => {
    const { bridge, calls } = bridgeAnswering(async () => ({ runVersion: 4 }));
    windowReporting(bridge, { kind: "stopped" });

    const reply = await callDaemon(bridge, "run.pause", {
      targetRunId: RUN_ID,
      expectedRunVersion: EXPECTED_RUN_VERSION,
    });

    expect(calls).toStrictEqual([]);
    const refusal = refusalOf(reply);
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.code).toBe("shell-stopped");
    expect(refusal.detail).toContain("run.pause was not sent.");
    expect(refusal.detail).toContain("The local runtime has been stopped.");
  });

  it("refuses a repo write and an account probe under the same condition", async () => {
    const { bridge, calls } = bridgeAnswering(async () => ({}));
    windowReporting(bridge, { kind: "offline", attemptLimit: 5, lastError: "spawn ENOENT" });

    const retire = await callDaemon(bridge, "repo.worktreeRetire", { worktreeId: WORKTREE_ID });
    const probe = await callDaemon(bridge, "providerAccount.probe", { accountId: ACCOUNT_ID });

    expect(calls).toStrictEqual([]);
    expect(refusalOf(retire).code).toBe("shell-offline");
    expect(refusalOf(probe).code).toBe("shell-offline");
  });

  it("refuses under every condition the block names, and admits the one it does not", async () => {
    const refusedConditions: string[] = [];
    const admittedConditions: string[] = [];

    for (const connection of REPORTED_CONNECTIONS) {
      const { bridge, calls } = bridgeAnswering(async () => ({ runVersion: 4 }));
      windowReporting(bridge, connection);

      const reply = await callDaemon(bridge, "run.resume", {
        targetRunId: RUN_ID,
        expectedRunVersion: EXPECTED_RUN_VERSION,
      });

      // BLOCKED AT THE DOOR is nothing sent AND the block's own code back, so a
      // refusal composed for any other reason cannot be counted as one.
      if (calls.length === 0 && reply.status === "refused") {
        expect(reply.refusal.code, connection.kind).toMatch(/^shell-/u);
        refusedConditions.push(connection.kind);
      } else {
        expect(calls.length, connection.kind).toBe(1);
        admittedConditions.push(connection.kind);
      }
    }

    // Every reported arm but `connected` closes a record. `unreported` is absent from
    // the enumeration by that support module's own rule, and the door treats it as
    // this list's complement does: silence closes nothing.
    expect(refusedConditions).toStrictEqual([
      "probing",
      "starting",
      "reconnecting",
      "version-incompatible",
      "offline",
      "stopped",
    ]);
    expect(admittedConditions).toStrictEqual(["connected"]);
  });
});

describe("callDaemon — a read stays live through every shell condition", () => {
  it("serves a read while the shell is stopped", async () => {
    const { bridge, calls } = bridgeAnswering(async () => ({ participants: [] }));
    windowReporting(bridge, { kind: "stopped" });

    const reply = await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID });

    expect(reply.status).toBe("served");
    expect(calls).toStrictEqual([{ method: "presence.read", params: { sessionId: SESSION_ID } }]);
  });

  it("puts a read on the transport under every reported condition", async () => {
    for (const connection of REPORTED_CONNECTIONS) {
      const { bridge, calls } = bridgeAnswering(async () => ({ participants: [] }));
      windowReporting(bridge, connection);

      const reply = await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID });

      expect(reply.status, `presence.read under ${connection.kind}`).toBe("served");
      expect(calls.length, `presence.read under ${connection.kind}`).toBe(1);
    }
  });
});

describe("callDaemon — an unbound gate reads as the window it has been told nothing about", () => {
  it("admits a record when no frame has bound its store", async () => {
    // Not fail-open: a window nothing has reported to holds `unreported`, whose block
    // is `undefined`, so this IS the bound answer at that moment.
    const { bridge, calls } = bridgeAnswering(async () => ({ runVersion: 4 }));

    const reply = await callDaemon(bridge, "run.pause", {
      targetRunId: RUN_ID,
      expectedRunVersion: EXPECTED_RUN_VERSION,
    });

    // The transport is what the claim is about: the call went out. Whether the
    // scripted answer parses is the parse suite's question, not this one's.
    expect(calls.length).toBe(1);
    expect(reply.status === "refused" && reply.refusal.code.startsWith("shell-")).toBe(false);
  });

  it("stops answering off a store the frame has released", async () => {
    const { bridge, calls } = bridgeAnswering(async () => ({ runVersion: 4 }));
    const frameStore = windowReporting(bridge, { kind: "stopped" });

    bridge.shellCondition.releaseFrameStore(frameStore);
    const reply = await callDaemon(bridge, "run.pause", {
      targetRunId: RUN_ID,
      expectedRunVersion: EXPECTED_RUN_VERSION,
    });

    expect(calls.length).toBe(1);
    expect(reply.status === "refused" && reply.refusal.code.startsWith("shell-")).toBe(false);
  });
});
