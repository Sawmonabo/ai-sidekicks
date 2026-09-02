// What the rail puts on screen, and what it refuses to put there.
//
// The claims worth a unit are the ones that would rot silently: that a session with
// no usage telemetry renders the "nobody asked" absence rather than a zeroed meter,
// that a session WITH telemetry renders the daemon's own figures, that the two
// plan-owned seats say they are reserved rather than looking broken, and that the
// `+` menu is reachable and dismissable from the keyboard.
//
// The store is the real `SessionStore` with real events applied — a stand-in would
// let the rail read a shape the store cannot actually produce.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleScenario } from "../../../console/bridge/scenario.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import {
  SessionStore,
  type ConsoleEntity,
  type ConsoleSessionEvent,
} from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { ComposerAccessoryRail } from "./ComposerAccessoryRail.js";
import { CONTEXT_WINDOW_EVENT_KIND } from "./usage-readings.js";

const SESSION_ID = "session-rail";

const EMPTY_SCENARIO: ConsoleScenario = {
  id: "rail-unit",
  label: "Rail unit",
  purpose: "A bridge for the rail's mount; the rail's own reads come from the store.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T00:00:00.000Z",
  beats: [],
  replies: [],
};

function mountRail(
  events: readonly ConsoleSessionEvent[],
  addressing: {
    readonly bridge?: ConsoleBridge;
    readonly entities?: readonly ConsoleEntity[];
    readonly focusedPane?: ConsolePaneAddress | undefined;
  } = {},
): HTMLElement {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({
    cursor: 0,
    entities: [...(addressing.entities ?? [])],
    participantJoinLog: ["participant-you"],
  });
  sessionStore.applyBatch(events);
  const { container } = render(
    <ComposerAccessoryRail
      sessionStore={sessionStore}
      bridge={addressing.bridge ?? createFixtureBridge({ scenario: EMPTY_SCENARIO })}
      draftStore={new DraftStore()}
      route={DEFAULT_ROUTE}
      focusedPane={addressing.focusedPane}
    />,
  );
  return container;
}

function contextWindowEvent(sequence: number): ConsoleSessionEvent {
  return {
    // The event's own identifier, composed from the position so two rows of one
    // session never share one.
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    kind: CONTEXT_WINDOW_EVENT_KIND,
    occurredAt: "2026-01-01T00:00:10.000Z",
    payload: { usagePercent: 84, tokenCount: 168_000, maxTokens: 200_000 },
  };
}

describe("ComposerAccessoryRail — absence before assertion", () => {
  it("renders the not-checked meter when the daemon has reported nothing", () => {
    const container = mountRail([]);
    expect(container.querySelector(".meridian-context-meter")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a session with a reading draws the meter instead", () => {
    const container = mountRail([contextWindowEvent(1)]);
    const meter = container.querySelector('[role="progressbar"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("84");
  });

  it("shows the compaction hint only above the threshold", () => {
    const above = mountRail([contextWindowEvent(1)]);
    expect(above.querySelector(".meridian-context-meter__hint")).not.toBeNull();

    const below = mountRail([
      {
        ...contextWindowEvent(1),
        payload: { usagePercent: 12, tokenCount: 24_000, maxTokens: 200_000 },
      },
    ]);
    expect(below.querySelector(".meridian-context-meter__hint")).toBeNull();
  });

  it("hides the queue shelf while nothing is queued", () => {
    expect(mountRail([]).querySelector(".meridian-queue-shelf")).toBeNull();
  });
});

describe("ComposerAccessoryRail — the reserved seats and the menu", () => {
  it("renders the edit-and-resend seat as reserved rather than as an editor", () => {
    const container = mountRail([]);
    const seat = container.querySelector(".meridian-composer__edit-resend");
    expect(seat).not.toBeNull();
    // No textarea and no confirm: a stub editor is the one thing this seat must not
    // be, because its confirm would either do nothing or invent an eligibility rule.
    expect(seat?.querySelector("textarea")).toBeNull();
    expect(seat?.querySelector("button")).toBeNull();
  });

  it("opens the `+` menu on the trigger and closes it on Escape", () => {
    const container = mountRail([]);
    const trigger = container.querySelector(".meridian-plus-menu__trigger");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("the rail rendered no plus-menu trigger");
    }
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // `fireEvent` rather than a bare `.click()`: it wraps the dispatch in `act`, so
    // the state the handler sets is committed before the next line reads the DOM.
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".meridian-plus-menu__workflow")).not.toBeNull();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("negative control: the menu's contents are not in the tree while it is closed", () => {
    const container = mountRail([]);
    expect(container.querySelector(".meridian-attachment-seat")).toBeNull();
  });
});

describe("ComposerAccessoryRail — the compaction control reaches the addressed run", () => {
  const AGENT_ID = "agent-implementer";
  const RUN_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

  const AGENT: ConsoleEntity = {
    kind: "agent",
    id: AGENT_ID,
    state: "running",
    body: { name: "Ada", driverName: "claude" },
  };

  const RUNNING_RUN: ConsoleEntity = {
    kind: "run",
    id: RUN_ID,
    state: "running",
    touchedAt: "2026-01-01T11:05:00.000Z",
    body: { agentId: AGENT_ID, runVersion: 4 },
  };

  /**
   * The meters row's own unanswered-question badge.
   *
   * Scoped rather than global: two other seats on this rail render their own
   * `not-checked` block, so a document-wide query would pass on either of theirs.
   */
  const METERS_NOT_CHECKED = ".meridian-composer__meters .meridian-nothing--not-checked";

  const ON_THE_AGENT: ConsolePaneAddress = {
    kind: "agent-console",
    entity: { kind: "agent", id: AGENT_ID },
  };

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

  /** A bridge answering the capability read and nothing else. */
  function bridgeDeclaring(reports: readonly unknown[]): ConsoleBridge {
    return {
      sidekicks: {
        daemon: {
          call: async (method: string) =>
            method === "driver.listCapabilities" ? { drivers: [...reports] } : undefined,
          subscribe: () => () => undefined,
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;
  }

  it("offers Compact for a running run whose bound driver declares the capability", async () => {
    // The negative control for the shipped constants: with `capability="unknown"`
    // and `targetRunId={undefined}` hard-coded, no composition could ever reach this
    // button, so this case fails on the code that shipped before the fix.
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge: bridgeDeclaring([reportFor("claude", ["context_compaction"])]),
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });

    const compact = container.querySelector(".meridian-compaction__action");
    expect(compact).not.toBeNull();
    expect(compact?.textContent).toBe("Compact");
  });

  it("dispatches the compaction for the addressed run and no other", async () => {
    const compactionCalls: unknown[] = [];
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string, params: unknown) => {
            if (method === "driver.listCapabilities") {
              return { drivers: [reportFor("claude", ["context_compaction"])] };
            }
            compactionCalls.push({ method, params });
            return { status: "applied", boundaryPosition: 12 };
          },
          subscribe: () => () => undefined,
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;

    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge,
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    const compact = container.querySelector(".meridian-compaction__action");
    if (!(compact instanceof HTMLButtonElement)) {
      throw new Error("the rail offered no compaction control");
    }
    await act(async () => {
      fireEvent.click(compact);
    });

    expect(compactionCalls).toStrictEqual([
      { method: "driver.compactContext", params: { sessionId: SESSION_ID, runId: RUN_ID } },
    ]);
  });

  it("is absent, not disabled, when the bound driver does not declare it", async () => {
    // Scoped to the meters row, and the meter is given a reading so its own
    // `not-checked` badge is off screen: what is asserted is that the composer
    // renders NO absence for compaction either — a driver that cannot compact has
    // nothing to say about compaction, and a line explaining its absence would be
    // noise on every composer bound to such a driver.
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([contextWindowEvent(1)], {
        bridge: bridgeDeclaring([reportFor("claude", [])]),
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    expect(container.querySelector(".meridian-compaction")).toBeNull();
    expect(container.querySelector(METERS_NOT_CHECKED)).toBeNull();
  });

  it("keeps another driver's missing flag off this agent's control", async () => {
    // The intersection reading would hide Compact here, because one reported driver
    // lacks the flag. The bound driver is what decides.
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge: bridgeDeclaring([
          reportFor("claude", ["context_compaction"]),
          reportFor("codex", []),
        ]),
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    expect(container.querySelector(".meridian-compaction__action")).not.toBeNull();
  });

  it("offers nothing at all when no run is addressed", async () => {
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge: bridgeDeclaring([reportFor("claude", ["context_compaction"])]),
      });
    });
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
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string) => {
            methodCalls.push(method);
            return method === "driver.listCapabilities"
              ? { drivers: [reportFor("claude", ["context_compaction"])] }
              : undefined;
          },
          subscribe: () => () => undefined,
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;

    await act(async () => {
      mountRail([], { bridge, entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT });
    });
    await act(async () => {
      mountRail([], { bridge, entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT });
    });

    expect(methodCalls.filter((method) => method === "driver.listCapabilities")).toHaveLength(1);
  });

  it("says the question was never put while the capability read is in flight", () => {
    // Never resolved, so the read is genuinely outstanding at assertion time — the
    // one state that is neither `declared` nor `undeclared`.
    const container = mountRail([contextWindowEvent(1)], {
      bridge: {
        sidekicks: {
          daemon: {
            call: () => new Promise<unknown>(() => undefined),
            subscribe: () => () => undefined,
          },
        },
        growth: {},
        growthServedOperations: new Set(),
        source: "fixture",
        scenarioEngine: undefined,
      } as unknown as ConsoleBridge,
      entities: [AGENT, RUNNING_RUN],
      focusedPane: ON_THE_AGENT,
    });
    expect(container.querySelector(METERS_NOT_CHECKED)).not.toBeNull();
    expect(container.querySelector(".meridian-compaction__action")).toBeNull();
  });
});
