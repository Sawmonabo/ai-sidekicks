// What the context meter puts on screen, and what it refuses to put there.
//
// The claims worth a unit are the ones that would rot silently: that a session with
// no usage telemetry renders the "nobody asked" absence rather than a zeroed meter,
// that a session WITH telemetry renders the daemon's own figures, that the meter
// reads the conversation the composer is ADDRESSED to rather than the session's
// newest row anywhere, and that a compaction boundary moves it off a stale figure.
//
// The store is the real `SessionStore` with real events applied — a stand-in would
// let the rail read a shape the store cannot actually produce.

import { describe, expect, it } from "vitest";

import {
  ADDRESSED,
  RUN_ID,
  SESSION_ID,
  contextWindowEvent,
  mountToolbar,
  AGENT,
  AGENT_ID,
  RUNNING_RUN,
} from "./composer-toolbar.test-support.js";
import type {
  StoredEntity,
  ProjectedSessionEvent,
} from "@renderer/store/session/entities/entities.js";
import type { PaneAddress } from "@renderer/console/seats/index.js";
import { CONTEXT_COMPACTED_EVENT_KIND } from "../context-ring/context-window-reading.js";

describe("ComposerToolbar — absence before assertion", () => {
  it("renders the not-checked meter when the daemon has reported nothing", () => {
    const container = mountToolbar([], ADDRESSED);
    expect(container.querySelector(".meridian-context-ring")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a session with a reading draws the meter instead", () => {
    const container = mountToolbar([contextWindowEvent(1)], ADDRESSED);
    const meter = container.querySelector('[role="progressbar"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("84");
  });

  it("is never colored and adds no hint at 80% or past the window", () => {
    // The ring is one figure and one meter, gray on gray: fullness changes the figure
    // and never the color or the copy beside it.
    const nearFull = mountToolbar([contextWindowEvent(1)], ADDRESSED);
    const pastTheWindow = mountToolbar(
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

    for (const container of [nearFull, pastTheWindow]) {
      expect(container.querySelector(".meridian-context-ring__hint")).toBeNull();
      expect(
        container.querySelector(".meridian-context-ring__fill")?.getAttributeNames(),
      ).toStrictEqual(["class", "style"]);
      expect(container.querySelector('[role="status"]')).toBeNull();
    }
    expect(nearFull.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "84",
    );
    expect(pastTheWindow.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });

  it("states the provenance the row carried, and what an estimate means", () => {
    // The meter draws the same bar for all three grades and says which one it is.
    // A bar whose numbers were estimated and a bar whose numbers the provider
    // measured are different readings, and the difference is invisible in the bar.
    const container = mountToolbar(
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

    expect(container.querySelector(".meridian-context-ring__source")?.textContent).toContain(
      "estimated",
    );
    expect(container.querySelector(".meridian-context-ring__source-note")?.textContent).toContain(
      "approximate",
    );
  });

  it("negative control: a provider-reported reading carries no grade sentence", () => {
    // Without this the case above would hold over a meter that explained itself on
    // every reading, which would make the two grades that matter invisible.
    const container = mountToolbar([contextWindowEvent(1)], ADDRESSED);
    expect(container.querySelector(".meridian-context-ring__source-note")).toBeNull();
    expect(container.querySelector(".meridian-context-ring__source")?.textContent).toContain(
      "provider_reported",
    );
  });
});

describe("ComposerToolbar — the meter reads the conversation it is addressed to", () => {
  const SECOND_AGENT_ID = "agent-reviewer";
  const SECOND_RUN_ID = "3c2b1a09-8f7e-4d6c-9b5a-4938271605fe";

  const SECOND_AGENT: StoredEntity = {
    kind: "agent",
    id: SECOND_AGENT_ID,
    state: "running",
    body: { name: "Priya", driverName: "claude" },
  };

  const SECOND_RUN: StoredEntity = {
    kind: "run",
    id: SECOND_RUN_ID,
    state: "running",
    touchedAt: "2026-01-01T11:06:00.000Z",
    body: { agentId: SECOND_AGENT_ID, runVersion: 2 },
  };

  /** Two conversations metered in one session, the SECOND run's row the newer. */
  const BOTH_METERED: readonly ProjectedSessionEvent[] = [
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

  function paneOn(agentId: string): PaneAddress {
    return { kind: "agents", entity: { kind: "agent", id: agentId } };
  }

  it("draws the addressed run's fullness while another run meters later and higher", () => {
    // A fold over the newest row anywhere in the session would draw Priya's 90% on the
    // composer addressed to Ada.
    const container = mountToolbar(BOTH_METERED, {
      entities: BOTH_AGENTS,
      focusedPane: paneOn(AGENT_ID),
    });

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "10",
    );
  });

  it("negative control: the other run's composer draws the higher reading", () => {
    // Without this the case above would hold over a meter that had simply stopped
    // reading the timeline at all.
    const container = mountToolbar(BOTH_METERED, {
      entities: BOTH_AGENTS,
      focusedPane: paneOn(SECOND_AGENT_ID),
    });

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "90",
    );
  });

  it("renders the not-checked absence, not a session-wide figure, with no run addressed", () => {
    // A composer addressed to the session meters no provider conversation, so there is
    // no fullness for it to report — and the session's newest row is some run's, not
    // this composer's.
    const container = mountToolbar(BOTH_METERED, { entities: BOTH_AGENTS });

    expect(container.querySelector(".meridian-context-ring")).toBeNull();
    expect(
      container.querySelector(".meridian-composer__meters .meridian-nothing--not-checked"),
    ).not.toBeNull();
  });
});

describe("ComposerToolbar — a compaction moves the meter off its stale figure", () => {
  function compactionRow(
    sequence: number,
    payload: Readonly<Record<string, unknown>>,
  ): ProjectedSessionEvent {
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
    // The meter draws the boundary's post-compaction count, not the pre-compaction 84%.
    const container = mountToolbar(
      [contextWindowEvent(1), compactionRow(2, { postCompactionTokens: 40_000 })],
      ADDRESSED,
    );

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "20",
    );
  });

  it("returns to the absence where the boundary carried no count", () => {
    const container = mountToolbar([contextWindowEvent(1), compactionRow(2, {})], ADDRESSED);

    expect(container.querySelector(".meridian-context-ring")).toBeNull();
    expect(
      container.querySelector(".meridian-composer__meters .meridian-nothing--not-checked"),
    ).not.toBeNull();
  });

  it("negative control: without the boundary the same timeline draws the stale figure", () => {
    const container = mountToolbar([contextWindowEvent(1)], ADDRESSED);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "84",
    );
  });
});
