// The two halves of "what needs me" that reach a person OUTSIDE the panel: pressing
// an item, and the banner the shell raises for one.
//
// `SessionsSurface.aside.test.tsx` next door holds what the panel says. This file
// holds what the panel DOES — every case here failed before the destination handed
// the centre a way to open an item and a caller for the shell's emission, and the
// first two failed by rendering an item nobody could press.

import { describe, expect, it } from "vitest";

import { contextWith, renderSurface, settle } from "./session-surface.test-support.js";

const ATTENTION_ITEM = {
  id: "attention-1",
  sessionId: "session-node",
  trigger: "pending_approval",
  severity: "actionable",
  summary: "A tool call is waiting on you.",
  sourceEventId: "event-1",
  createdAt: "2026-01-01T10:00:00.000Z",
} as const;

function contextWithOneItem(
  extra: Parameters<typeof contextWith>[0] = {},
): ReturnType<typeof contextWith> {
  return contextWith({
    directorySessionIds: ["session-node"],
    attentionBySessionId: { "session-node": [ATTENTION_ITEM] },
    ...extra,
  });
}

/** The pressable item rows the panel rendered. */
function attentionButtons(container: HTMLElement): readonly HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button.meridian-attention__row--open")];
}

describe("opening an attention item", () => {
  it("renders each item as a control rather than as text", async () => {
    const { container } = renderSurface(contextWithOneItem());
    await settle();

    expect(attentionButtons(container)).toHaveLength(1);
  });

  it("navigates to the session the item belongs to", async () => {
    // The item's own session and NOT the route's: this address names none, which is
    // the whole reason the read fans out, so a navigation composed from the route
    // would open nothing at all.
    const navigations: unknown[] = [];
    const { container } = renderSurface(contextWithOneItem({ navigations }));
    await settle();
    attentionButtons(container)[0]?.click();

    expect(navigations).toStrictEqual([{ kind: "workspace", sessionId: "session-node" }]);
  });
});

describe("what the centre says about the machine it is running on", () => {
  it("says it is the only surface when this machine will show nothing", async () => {
    const { container } = renderSurface(contextWithOneItem({ notificationPermission: "denied" }));
    await settle();

    expect(container.textContent ?? "").toContain("This panel is the only place");
  });

  it("says nothing of the kind when the machine will show notifications", async () => {
    const { container } = renderSurface(contextWithOneItem({ notificationPermission: "granted" }));
    await settle();

    expect(container.textContent ?? "").not.toContain("This panel is the only place");
  });

  it("says nothing of the kind when the reading was refused", async () => {
    // The default a live bridge gives, and the honest render of it: the console has
    // not established the fact, so it makes no claim about it either way. Reporting a
    // refused read as a denial would tell a person their notifications are off on
    // every host whose permission this console cannot read — which is all of them.
    const { container } = renderSurface(contextWithOneItem());
    await settle();

    expect(container.textContent ?? "").not.toContain("This panel is the only place");
  });
});

describe("raising a banner", () => {
  it("raises none for the projection the destination found on arrival", async () => {
    // Mounting is not an event. Without the baseline this navigation would fire one
    // banner per outstanding item, every time a person came back to this screen.
    const emittedNotifications: unknown[] = [];
    renderSurface(contextWithOneItem({ notificationPermission: "granted", emittedNotifications }));
    await settle();

    expect(emittedNotifications).toStrictEqual([]);
  });
});
