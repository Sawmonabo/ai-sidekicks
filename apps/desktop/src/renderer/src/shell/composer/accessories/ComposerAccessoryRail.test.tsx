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

import { ManualClock, REFRESH_MAX_WAIT_MS } from "../../../console/core/index.js";

import {
  PROVIDER_ACCOUNT_LIST_METHOD,
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  QUEUE_SUBSCRIBE_STREAM,
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
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
import { CONTEXT_COMPACTED_EVENT_KIND, CONTEXT_WINDOW_EVENT_KIND } from "./usage-readings.js";

const SESSION_ID = "session-rail";
// A registered `SessionId` (a UUID): the queue feed parses its subscribe request
// against the wire's own brand and opens no stream over any other shape, so the
// cases that need the queue tail open mount on this one.
const QUEUE_SESSION_ID = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

/** The registered list reply for a node with nothing registered on it. */
const EMPTY_REGISTRY = { accounts: [], usageWindows: [], readiness: [] };

/** One account and one window against it, in the registered shapes. */
const ONE_URGENT_QUOTA = {
  accounts: [
    {
      accountId: "acct-rail",
      provider: "claude",
      displayLabel: "Rail team",
      credentialGeneration: 1,
      billingMode: "subscription",
      isDefault: true,
      healthState: "authenticated",
      healthObservedAt: "2026-01-01T00:00:00.000Z",
      observedAuthMode: "oauth_subscription",
      loggedInAt: null,
      expectedReloginAtEstimate: null,
      probeEnabled: true,
    },
  ],
  usageWindows: [
    {
      accountId: "acct-rail",
      limitId: "weekly-all",
      windowMins: 10_080,
      label: "Weekly, all models",
      // Deep in the urgent band, so the chip is on screen at all: the healthy band
      // renders nothing by design.
      usedPercent: 94,
      observedAt: "2026-01-01T00:00:00.000Z",
      observedCredentialGeneration: 1,
      source: "probe",
    },
  ],
  readiness: [],
};

const EMPTY_SCENARIO: ConsoleScenario = {
  id: "rail-unit",
  label: "Rail unit",
  purpose: "A bridge for the rail's mount; the rail's own reads come from the store.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T00:00:00.000Z",
  beats: [],
  // The rail's quota chips are a NODE-scoped read and not a store selection, so a
  // scenario the rail mounts against has to answer it: an unscripted call is a
  // fixture authoring error, which would put a refusal in every case below. This
  // node has no account registered, which is an answered read and not a failure.
  replies: [{ call: PROVIDER_ACCOUNT_LIST_METHOD, result: EMPTY_REGISTRY }],
};

function mountRail(
  events: readonly ConsoleSessionEvent[],
  addressing: {
    readonly bridge?: ConsoleBridge;
    readonly entities?: readonly ConsoleEntity[];
    readonly focusedPane?: ConsolePaneAddress | undefined;
    readonly sessionId?: string;
  } = {},
): HTMLElement {
  const sessionStore = new SessionStore({ sessionId: addressing.sessionId ?? SESSION_ID });
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

const ON_THE_AGENT: ConsolePaneAddress = {
  kind: "agent-console",
  entity: { kind: "agent", id: AGENT_ID },
};

/**
 * The addressing every meter case needs: a composer pointed at a run.
 *
 * Both usage folds are run-scoped, so an unaddressed rail reports no fullness at
 * all — which is its own case below and not the state a case about the METER wants
 * to be in.
 */
const ADDRESSED = { entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT } as const;

function contextWindowEvent(sequence: number): ConsoleSessionEvent {
  return {
    // The event's own identifier, composed from the position so two rows of one
    // session never share one.
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    kind: CONTEXT_WINDOW_EVENT_KIND,
    occurredAt: "2026-01-01T00:00:10.000Z",
    payload: {
      runId: RUN_ID,
      windowUsedTokens: 168_000,
      windowMaxTokens: 200_000,
      windowSource: "provider_reported",
      exceeded: false,
    },
  };
}

describe("ComposerAccessoryRail — absence before assertion", () => {
  it("renders the not-checked meter when the daemon has reported nothing", () => {
    const container = mountRail([], ADDRESSED);
    expect(container.querySelector(".meridian-context-meter")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a session with a reading draws the meter instead", () => {
    const container = mountRail([contextWindowEvent(1)], ADDRESSED);
    const meter = container.querySelector('[role="progressbar"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("84");
  });

  it("shows the compaction hint only above the threshold", () => {
    const above = mountRail([contextWindowEvent(1)], ADDRESSED);
    expect(above.querySelector(".meridian-context-meter__hint")).not.toBeNull();

    const below = mountRail(
      [
        {
          ...contextWindowEvent(1),
          payload: {
            runId: RUN_ID,
            windowUsedTokens: 24_000,
            windowMaxTokens: 200_000,
            windowSource: "provider_reported",
            exceeded: false,
          },
        },
      ],
      ADDRESSED,
    );
    expect(below.querySelector(".meridian-context-meter__hint")).toBeNull();
  });

  it("states the provenance the row carried, and what an estimate means", () => {
    // The meter draws the same bar for all three grades and says which one it is.
    // A bar whose numbers were estimated and a bar whose numbers the provider
    // measured are different readings, and the difference is invisible in the bar.
    const container = mountRail(
      [
        {
          ...contextWindowEvent(1),
          payload: {
            runId: RUN_ID,
            windowUsedTokens: 24_000,
            windowMaxTokens: 200_000,
            windowSource: "estimated",
          },
        },
      ],
      ADDRESSED,
    );

    expect(container.querySelector(".meridian-context-meter__source")?.textContent).toContain(
      "estimated",
    );
    expect(container.querySelector(".meridian-context-meter__source-note")?.textContent).toContain(
      "approximate",
    );
  });

  it("negative control: a provider-reported reading carries no grade sentence", () => {
    // Without this the case above would hold over a meter that explained itself on
    // every reading, which would make the two grades that matter invisible.
    const container = mountRail([contextWindowEvent(1)], ADDRESSED);
    expect(container.querySelector(".meridian-context-meter__source-note")).toBeNull();
    expect(container.querySelector(".meridian-context-meter__source")?.textContent).toContain(
      "provider_reported",
    );
  });

  it("replaces the near-full advice with the provider's own exhaustion statement", () => {
    // Advising someone to compact soon is the wrong sentence beside a window the
    // provider has already declared full, and both at once would be worse.
    const container = mountRail(
      [
        {
          ...contextWindowEvent(1),
          payload: {
            runId: RUN_ID,
            windowUsedTokens: 210_000,
            windowMaxTokens: 200_000,
            windowSource: "provider_reported",
            exceeded: true,
          },
        },
      ],
      ADDRESSED,
    );

    const hints = container.querySelectorAll(".meridian-context-meter__hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.textContent).toContain("context window is full");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });

  it("hides the queue shelf while nothing is queued", () => {
    expect(mountRail([]).querySelector(".meridian-queue-shelf")).toBeNull();
  });

  it("shows the shelf's partial-read line once a queue delivery could not be read", async () => {
    // The feed counts an unreadable delivery; the rail has to HAND that count to the
    // shelf, or the shelf hides itself over an empty list it does not know is empty.
    // The bridge here answers the queue snapshot with no rows and the account read
    // with no accounts, and hands the case the stream handler so it can deliver a
    // row that matches no registered queue shape.
    let deliverToFeed: (payload: unknown) => void = () => undefined;
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string): Promise<unknown> =>
            method === PROVIDER_ACCOUNT_LIST_METHOD ? EMPTY_REGISTRY : { items: [] },
          subscribe: (stream: string, handler: (payload: unknown) => void) => {
            // The rail opens more than one stream (the account plane's is another),
            // so the case keeps the queue stream's handler and no other.
            if (stream === QUEUE_SUBSCRIBE_STREAM) {
              deliverToFeed = handler;
            }
            return () => undefined;
          },
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], { bridge, sessionId: QUEUE_SESSION_ID });
    });
    expect(container.querySelector(".meridian-queue-shelf")).toBeNull();

    act(() => {
      deliverToFeed({ id: "queue-item-a", status: "waiting", rank: 3 });
    });

    expect(container.querySelector(".meridian-queue-shelf__partial-copy")?.textContent).toContain(
      "1 queue delivery could not be read",
    );
  });
});

describe("ComposerAccessoryRail — the meter reads the conversation it is addressed to", () => {
  const SECOND_AGENT_ID = "agent-reviewer";
  const SECOND_RUN_ID = "3c2b1a09-8f7e-4d6c-9b5a-4938271605fe";

  const SECOND_AGENT: ConsoleEntity = {
    kind: "agent",
    id: SECOND_AGENT_ID,
    state: "running",
    body: { name: "Priya", driverName: "claude" },
  };

  const SECOND_RUN: ConsoleEntity = {
    kind: "run",
    id: SECOND_RUN_ID,
    state: "running",
    touchedAt: "2026-01-01T11:06:00.000Z",
    body: { agentId: SECOND_AGENT_ID, runVersion: 2 },
  };

  /** Two conversations metered in one session, the SECOND run's row the newer. */
  const BOTH_METERED: readonly ConsoleSessionEvent[] = [
    {
      ...contextWindowEvent(3),
      payload: {
        runId: RUN_ID,
        windowUsedTokens: 20_000,
        windowMaxTokens: 200_000,
        windowSource: "provider_reported",
        exceeded: false,
      },
    },
    {
      ...contextWindowEvent(12),
      payload: {
        runId: SECOND_RUN_ID,
        windowUsedTokens: 180_000,
        windowMaxTokens: 200_000,
        windowSource: "provider_reported",
        exceeded: false,
      },
    },
  ];

  const BOTH_AGENTS = [AGENT, RUNNING_RUN, SECOND_AGENT, SECOND_RUN];

  function paneOn(agentId: string): ConsolePaneAddress {
    return { kind: "agent-console", entity: { kind: "agent", id: agentId } };
  }

  it("draws the addressed run's fullness while another run meters later and higher", () => {
    // The finding: the fold took the newest row anywhere in the session, so the
    // composer addressed to Ada drew Priya's 90% and offered to compact the
    // conversation the person was not writing to.
    const container = mountRail(BOTH_METERED, {
      entities: BOTH_AGENTS,
      focusedPane: paneOn(AGENT_ID),
    });

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "10",
    );
    expect(container.querySelector(".meridian-context-meter__hint")).toBeNull();
  });

  it("negative control: the other run's composer draws the higher reading and its hint", () => {
    // Without this the case above would hold over a meter that had simply stopped
    // reading the timeline at all.
    const container = mountRail(BOTH_METERED, {
      entities: BOTH_AGENTS,
      focusedPane: paneOn(SECOND_AGENT_ID),
    });

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "90",
    );
    expect(container.querySelector(".meridian-context-meter__hint")).not.toBeNull();
  });

  it("renders the not-checked absence rather than a session-wide figure when no run is addressed", () => {
    // A composer addressed to a channel meters no provider conversation, so there is
    // no fullness for it to report — and the session's newest row is some run's, not
    // this composer's.
    const container = mountRail(BOTH_METERED, { entities: BOTH_AGENTS });

    expect(container.querySelector(".meridian-context-meter")).toBeNull();
    expect(
      container.querySelector(".meridian-composer__meters .meridian-nothing--not-checked"),
    ).not.toBeNull();
  });
});

describe("ComposerAccessoryRail — a compaction moves the meter off its stale figure", () => {
  function compactionRow(
    sequence: number,
    payload: Readonly<Record<string, unknown>>,
  ): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      kind: CONTEXT_COMPACTED_EVENT_KIND,
      occurredAt: "2026-01-01T00:00:20.000Z",
      payload: { runId: RUN_ID, ...payload },
    };
  }

  it("draws the post-compaction figure the boundary carried", () => {
    // The finding: the meter sat at the pre-compaction 84% after the provider had
    // compacted, and went on advising a compaction that had already happened.
    const container = mountRail(
      [contextWindowEvent(1), compactionRow(2, { postCompactionTokens: 40_000 })],
      ADDRESSED,
    );

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "20",
    );
    expect(container.querySelector(".meridian-context-meter__hint")).toBeNull();
  });

  it("returns to the absence where the boundary carried no count", () => {
    const container = mountRail([contextWindowEvent(1), compactionRow(2, {})], ADDRESSED);

    expect(container.querySelector(".meridian-context-meter")).toBeNull();
    expect(
      container.querySelector(".meridian-composer__meters .meridian-nothing--not-checked"),
    ).not.toBeNull();
  });

  it("negative control: without the boundary the same timeline draws the stale figure", () => {
    const container = mountRail([contextWindowEvent(1)], ADDRESSED);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "84",
    );
    expect(container.querySelector(".meridian-context-meter__hint")).not.toBeNull();
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

  /**
   * A bridge answering the capability read and nothing else, on a frozen clock.
   *
   * The node's capability read goes through the console's one refresh scheduler, so
   * it is armed at mount and PERFORMED when the scheduler's window elapses. The
   * clock is handed in rather than minted here so each case advances its own and no
   * case depends on how fast the runner happens to be.
   */
  function bridgeDeclaring(reports: readonly unknown[], clock: ManualClock): ConsoleBridge {
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
      scenarioEngine: { clock },
    } as unknown as ConsoleBridge;
  }

  /** Let the scheduler's window elapse and the capability read that follows settle. */
  async function settleCapabilityRead(clock: ManualClock): Promise<void> {
    await act(async () => {
      clock.advance(REFRESH_MAX_WAIT_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("offers Compact for a running run whose bound driver declares the capability", async () => {
    // The negative control for the shipped constants: with `capability="unknown"`
    // and `targetRunId={undefined}` hard-coded, no composition could ever reach this
    // button, so this case fails on the code that shipped before the fix.
    const clock = new ManualClock();
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge: bridgeDeclaring([reportFor("claude", ["context_compaction"])], clock),
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    await settleCapabilityRead(clock);

    const compact = container.querySelector(".meridian-compaction__action");
    expect(compact).not.toBeNull();
    expect(compact?.textContent).toBe("Compact");
  });

  it("dispatches the compaction for the addressed run and no other", async () => {
    const compactionCalls: unknown[] = [];
    const clock = new ManualClock();
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string, params: unknown) => {
            if (method === "driver.listCapabilities") {
              return { drivers: [reportFor("claude", ["context_compaction"])] };
            }
            // The rail's own node-scoped quota read, answered so the recorder below
            // holds compaction dispatches and nothing else — the claim is about which
            // run was compacted, not about which calls the rail makes.
            if (method === PROVIDER_ACCOUNT_LIST_METHOD) {
              return EMPTY_REGISTRY;
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
      scenarioEngine: { clock },
    } as unknown as ConsoleBridge;

    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge,
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    await settleCapabilityRead(clock);
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

  it("refuses a second press while its own call is still travelling", async () => {
    // `aria-busy` announces and stops no pointer, so the control carried the marker
    // and stayed clickable. The latch swallowed the duplicate silently at best; the
    // button now says what it is doing and takes no second press at all.
    const compactionCalls: unknown[] = [];
    let releaseCompaction: (() => void) | undefined;
    const clock = new ManualClock();
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string, params: unknown) => {
            if (method === "driver.listCapabilities") {
              return { drivers: [reportFor("claude", ["context_compaction"])] };
            }
            if (method === PROVIDER_ACCOUNT_LIST_METHOD) {
              return EMPTY_REGISTRY;
            }
            compactionCalls.push({ method, params });
            return await new Promise((resolve) => {
              releaseCompaction = () => {
                resolve({ status: "applied", boundaryPosition: 12 });
              };
            });
          },
          subscribe: () => () => undefined,
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: { clock },
    } as unknown as ConsoleBridge;

    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge,
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    await settleCapabilityRead(clock);
    const compact = container.querySelector(".meridian-compaction__action");
    if (!(compact instanceof HTMLButtonElement)) {
      throw new Error("the rail offered no compaction control");
    }
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
      await Promise.resolve();
    });
    expect(compact.disabled).toBe(false);
  });

  it("is absent, not disabled, when the bound driver does not declare it", async () => {
    // Scoped to the meters row, and the meter is given a reading so its own
    // `not-checked` badge is off screen: what is asserted is that the composer
    // renders NO absence for compaction either — a driver that cannot compact has
    // nothing to say about compaction, and a line explaining its absence would be
    // noise on every composer bound to such a driver.
    const clock = new ManualClock();
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([contextWindowEvent(1)], {
        bridge: bridgeDeclaring([reportFor("claude", [])], clock),
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    await settleCapabilityRead(clock);
    expect(container.querySelector(".meridian-compaction")).toBeNull();
    expect(container.querySelector(METERS_NOT_CHECKED)).toBeNull();
  });

  it("keeps another driver's missing flag off this agent's control", async () => {
    // The intersection reading would hide Compact here, because one reported driver
    // lacks the flag. The bound driver is what decides.
    const clock = new ManualClock();
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge: bridgeDeclaring(
          [reportFor("claude", ["context_compaction"]), reportFor("codex", [])],
          clock,
        ),
        entities: [AGENT, RUNNING_RUN],
        focusedPane: ON_THE_AGENT,
      });
    });
    await settleCapabilityRead(clock);
    expect(container.querySelector(".meridian-compaction__action")).not.toBeNull();
  });

  it("offers nothing at all when no run is addressed", async () => {
    const clock = new ManualClock();
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], {
        bridge: bridgeDeclaring([reportFor("claude", ["context_compaction"])], clock),
      });
    });
    await settleCapabilityRead(clock);
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
    const clock = new ManualClock();
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
      scenarioEngine: { clock },
    } as unknown as ConsoleBridge;

    await act(async () => {
      mountRail([], { bridge, entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT });
      mountRail([], { bridge, entities: [AGENT, RUNNING_RUN], focusedPane: ON_THE_AGENT });
    });
    await settleCapabilityRead(clock);

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

describe("ComposerAccessoryRail — the quota chips come off the account plane", () => {
  /** A fixture bridge answering the node-scoped registry read with `reply`. */
  function bridgeAnswering(reply: unknown): ConsoleBridge {
    return createFixtureBridge({
      scenario: {
        ...EMPTY_SCENARIO,
        replies: [{ call: PROVIDER_ACCOUNT_LIST_METHOD, result: reply }],
      },
    });
  }

  it("renders a chip from the registry read with an EMPTY session timeline", async () => {
    // The whole finding, as one case. The session store is given nothing, so a chip
    // on screen can only have come from the account plane — which is where the
    // registered wire puts this data, and where the session timeline never could.
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], { bridge: bridgeAnswering(ONE_URGENT_QUOTA) });
    });

    const chip = container.querySelector(".meridian-rate-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Rail team");
    expect(chip?.textContent).toContain("Weekly, all models");
  });

  it("negative control: no chip appears when the registry answers with no account", async () => {
    // Without this the case above would hold over a rail that rendered a chip from
    // anything at all, including the fixture's own defaults.
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], { bridge: bridgeAnswering(EMPTY_REGISTRY) });
    });

    expect(container.querySelector(".meridian-rate-chip")).toBeNull();
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("says the registry could not be read rather than looking like a healthy node", async () => {
    // A chip's absence is not a health reading. A read that failed and a node whose
    // quotas are all fine render identically unless the refusal is on screen.
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], { bridge: bridgeAnswering({ accounts: "not a list" }) });
    });

    const refusal = container.querySelector(".meridian-refusal");
    expect(refusal).not.toBeNull();
    expect(refusal?.textContent).toContain("reply-unreadable");
  });
});

describe("ComposerAccessoryRail — an unreadable delivery is said beside the chips", () => {
  /**
   * The fixture bridge with the account-plane tail's own handler captured.
   *
   * Captured rather than scripted because what is being claimed is what happens AFTER
   * the read has settled, and a scenario beat would put that moment on the fixture's
   * clock instead of on the case's — the same reason the reading's own test captures
   * its tail.
   */
  function bridgeWithCapturedAccountTail(reply: unknown): {
    readonly bridge: ConsoleBridge;
    readonly deliver: (payload: unknown) => void;
  } {
    const base = createFixtureBridge({
      scenario: {
        ...EMPTY_SCENARIO,
        replies: [{ call: PROVIDER_ACCOUNT_LIST_METHOD, result: reply }],
      },
    });
    const subscribe = base.sidekicks.daemon.subscribe;
    let deliverToTail: ((payload: unknown) => void) | undefined;
    const bridge: ConsoleBridge = {
      ...base,
      sidekicks: {
        ...base.sidekicks,
        daemon: {
          ...base.sidekicks.daemon,
          subscribe: ((event: string, handler: (payload: unknown) => void) => {
            if (event !== PROVIDER_ACCOUNT_SUBSCRIBE_STREAM) {
              return (subscribe as (name: string, sink: (payload: unknown) => void) => () => void)(
                event,
                handler,
              );
            }
            deliverToTail = handler;
            return () => {
              deliverToTail = undefined;
            };
          }) as typeof base.sidekicks.daemon.subscribe,
        },
      },
    };
    return {
      bridge,
      deliver: (payload: unknown): void => {
        if (deliverToTail === undefined) {
          throw new Error("nothing is subscribed to the account plane");
        }
        deliverToTail(payload);
      },
    };
  }

  it("keeps the chip and says the tail is incomplete", async () => {
    // Beside the chip and never instead of it: the reading on screen is the best the
    // console has, and what the notice adds is that the tail carrying the next one is
    // incomplete — which an unreadable `account_removed` or `usage_window_updated`
    // used to hide entirely.
    const plane = bridgeWithCapturedAccountTail(ONE_URGENT_QUOTA);
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], { bridge: plane.bridge });
    });
    await act(async () => {
      plane.deliver({ kind: "account_removed" });
    });

    const partial = container.querySelector(".meridian-quota-partial");
    expect(partial).not.toBeNull();
    expect(partial?.textContent).toContain("could not be read");
    expect(partial?.querySelector(".meridian-refusal")?.textContent).toContain(
      "delivery-unreadable",
    );
    expect(container.querySelector(".meridian-rate-chip")).not.toBeNull();
  });

  it("negative control: a readable delivery leaves no notice at all", async () => {
    // Without this the case above would hold over a rail that rendered the notice
    // whenever the tail delivered anything.
    const plane = bridgeWithCapturedAccountTail(ONE_URGENT_QUOTA);
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      container = mountRail([], { bridge: plane.bridge });
    });
    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: "acct-elsewhere" });
    });

    expect(container.querySelector(".meridian-quota-partial")).toBeNull();
    expect(container.querySelector(".meridian-rate-chip")).not.toBeNull();
  });
});
