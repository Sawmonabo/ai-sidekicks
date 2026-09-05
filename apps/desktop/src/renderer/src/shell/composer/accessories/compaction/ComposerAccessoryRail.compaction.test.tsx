// The compaction control on the rail: whether it is offered at all, which run it
// compacts, and what it does while its own call is travelling.
//
// The capability read is a NODE-scoped read behind the console's one refresh
// scheduler, so every case here arms it at mount and then lets the scheduler's
// window elapse on the fixture's frozen clock. That is also why the reports are
// answered through the call door rather than by a hand-built bridge: the surface
// reaches the wire one way, and a stand-in around it would prove nothing about the
// surface.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../../console/bridge/index.js";
import { settleScheduledRead } from "../../../../console/bridge/scheduled-read.test-support.js";
import {
  AGENT,
  ON_THE_AGENT,
  RUNNING_RUN,
  RUN_ID,
  SESSION_ID,
  contextWindowEvent,
  mountRail,
  mountRailSettled,
  railBridgeAnswering,
} from "../rail.test-support.js";
import { drainMicrotasks } from "../../../../console/bridge/fixture-bridge.test-support.js";

const CAPABILITY_READ_METHOD = "driver.listCapabilities";
const COMPACTION_METHOD = "driver.compactContext";

/**
 * The meters row's own unanswered-question badge.
 *
 * Scoped rather than global: two other seats on this rail render their own
 * `not-checked` block, so a document-wide query would pass on either of theirs.
 */
const METERS_NOT_CHECKED = ".meridian-composer__meters .meridian-nothing--not-checked";

/** One capability report per driver, total over the registered flag set. */
function reportFor(driverName: string, declared: readonly DriverCapabilityFlag[]): unknown {
  return {
    driverName,
    capabilities: {
      flags: Object.fromEntries(
        DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, declared.includes(flag)]),
      ),
      contractVersion: "1",
    },
  };
}

/** A bridge answering the capability read with `reports` and leaving the rest scripted. */
function bridgeDeclaring(reports: readonly unknown[]): ConsoleBridge {
  return railBridgeAnswering(async (call, forward) =>
    call.method === CAPABILITY_READ_METHOD ? { drivers: [...reports] } : forward(),
  );
}

/** The rail's compaction button, or a failure that says the rail offered none. */
function compactionAction(container: HTMLElement): HTMLButtonElement {
  const action = container.querySelector(".meridian-compaction__action");
  if (!(action instanceof HTMLButtonElement)) {
    throw new Error("the rail offered no compaction control");
  }
  return action;
}

describe("ComposerAccessoryRail — the compaction control reaches the addressed run", () => {
  it("offers Compact for a running run whose bound driver declares the capability", async () => {
    // The negative control for the shipped constants: with `capability="unknown"`
    // and `targetRunId={undefined}` hard-coded, no composition could ever reach this
    // button, so this case fails on the code that shipped before the fix.
    const bridge = bridgeDeclaring([reportFor("claude", ["context_compaction"])]);
    const container = await mountRailSettled([], {
      bridge,
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });
    await settleScheduledRead(bridge);

    const compact = container.querySelector(".meridian-compaction__action");
    expect(compact).not.toBeNull();
    expect(compact?.textContent).toBe("Compact");
  });

  it("dispatches the compaction for the addressed run and no other", async () => {
    const compactionCalls: unknown[] = [];
    const bridge = railBridgeAnswering(async (call, forward) => {
      if (call.method === CAPABILITY_READ_METHOD) {
        return { drivers: [reportFor("claude", ["context_compaction"])] };
      }
      if (call.method !== COMPACTION_METHOD) {
        // The rail's own node-scoped quota read stays scripted, so the recorder holds
        // compaction dispatches and nothing else — the claim is about which run was
        // compacted, not about which calls the rail makes.
        return forward();
      }
      compactionCalls.push({ method: call.method, params: call.params });
      return { status: "applied", boundaryPosition: 12 };
    });

    const container = await mountRailSettled([], {
      bridge,
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });
    await settleScheduledRead(bridge);
    await act(async () => {
      fireEvent.click(compactionAction(container));
    });

    expect(compactionCalls).toStrictEqual([
      { method: COMPACTION_METHOD, params: { sessionId: SESSION_ID, runId: RUN_ID } },
    ]);
  });

  it("refuses a second press while its own call is still travelling", async () => {
    // `aria-busy` announces and stops no pointer, so the control carried the marker
    // and stayed clickable. The latch swallowed the duplicate silently at best; the
    // button now says what it is doing and takes no second press at all.
    const compactionCalls: unknown[] = [];
    let releaseCompaction: (() => void) | undefined;
    const bridge = railBridgeAnswering(async (call, forward) => {
      if (call.method === CAPABILITY_READ_METHOD) {
        return { drivers: [reportFor("claude", ["context_compaction"])] };
      }
      if (call.method !== COMPACTION_METHOD) {
        return forward();
      }
      compactionCalls.push({ method: call.method, params: call.params });
      return await new Promise((resolve) => {
        releaseCompaction = () => {
          resolve({ status: "applied", boundaryPosition: 12 });
        };
      });
    });

    const container = await mountRailSettled([], {
      bridge,
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });
    await settleScheduledRead(bridge);
    const compact = compactionAction(container);
    await act(async () => {
      fireEvent.click(compact);
    });

    expect(compact.disabled).toBe(true);
    expect(compact.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      fireEvent.click(compact);
    });
    expect(compactionCalls).toHaveLength(1);

    await act(async () => {
      releaseCompaction?.();
      await drainMicrotasks();
    });
    expect(compact.disabled).toBe(false);
  });

  it("is absent, not disabled, when the bound driver does not declare it", async () => {
    // Scoped to the meters row, and the meter is given a reading so its own
    // `not-checked` badge is off screen: what is asserted is that the composer
    // renders NO absence for compaction either — a driver that cannot compact has
    // nothing to say about compaction, and a line explaining its absence would be
    // noise on every composer bound to such a driver.
    const bridge = bridgeDeclaring([reportFor("claude", [])]);
    const container = await mountRailSettled([contextWindowEvent(1)], {
      bridge,
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });
    await settleScheduledRead(bridge);

    expect(container.querySelector(".meridian-compaction")).toBeNull();
    expect(container.querySelector(METERS_NOT_CHECKED)).toBeNull();
  });

  it("keeps another driver's missing flag off this agent's control", async () => {
    // The intersection reading would hide Compact here, because one reported driver
    // lacks the flag. The bound driver is what decides.
    const bridge = bridgeDeclaring([
      reportFor("claude", ["context_compaction"]),
      reportFor("codex", []),
    ]);
    const container = await mountRailSettled([], {
      bridge,
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });
    await settleScheduledRead(bridge);

    expect(container.querySelector(".meridian-compaction__action")).not.toBeNull();
  });

  it("offers nothing at all when no run is addressed", async () => {
    const bridge = bridgeDeclaring([reportFor("claude", ["context_compaction"])]);
    const container = await mountRailSettled([], { bridge });
    await settleScheduledRead(bridge);

    // A channel-addressed composer has no run to compact, so the seat is empty
    // rather than carrying a "nobody asked" block on every session composer.
    expect(container.querySelector(".meridian-compaction")).toBeNull();
  });

  it("asks for the declarations once for every rail sharing one bridge", async () => {
    // The composer used to hold its own capability hook, so a session view carrying
    // the rail beside the runs pane put two `driver.listCapabilities` calls on the
    // wire for one answer. Two rails on one bridge is that arithmetic without
    // reaching across families: on the two-hook tree this counted two.
    const methodCalls: string[] = [];
    const bridge = railBridgeAnswering(async (call, forward) => {
      methodCalls.push(call.method);
      return call.method === CAPABILITY_READ_METHOD
        ? { drivers: [reportFor("claude", ["context_compaction"])] }
        : forward();
    });

    await act(async () => {
      mountRail([], { bridge, entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT });
      mountRail([], { bridge, entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT });
    });
    await settleScheduledRead(bridge);

    expect(methodCalls.filter((method) => method === CAPABILITY_READ_METHOD)).toHaveLength(1);
  });

  it("says the question was never put while the capability read is in flight", () => {
    // Never resolved, so the read is genuinely outstanding at assertion time — the
    // one state that is neither `declared` nor `undeclared`.
    const container = mountRail([contextWindowEvent(1)], {
      bridge: railBridgeAnswering(() => new Promise<unknown>(() => undefined)),
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });

    expect(container.querySelector(METERS_NOT_CHECKED)).not.toBeNull();
    expect(container.querySelector(".meridian-compaction__action")).toBeNull();
  });
});
