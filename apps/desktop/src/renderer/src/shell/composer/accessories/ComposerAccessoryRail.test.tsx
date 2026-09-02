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

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../console/bridge/index.js";
import type { ConsoleScenario } from "../../../console/bridge/scenario.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../../console/store/index.js";
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

function mountRail(events: readonly ConsoleSessionEvent[]): HTMLElement {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  sessionStore.applyBatch(events);
  const { container } = render(
    <ComposerAccessoryRail
      sessionStore={sessionStore}
      bridge={createFixtureBridge({ scenario: EMPTY_SCENARIO })}
      draftStore={new DraftStore()}
      route={DEFAULT_ROUTE}
      focusedPane={undefined}
    />,
  );
  return container;
}

function contextWindowEvent(sequence: number): ConsoleSessionEvent {
  return {
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
