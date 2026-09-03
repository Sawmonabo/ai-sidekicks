// A pane moved into a window of its own, and what comes back when that window is lost.
//
// The SLOT is the subject on both paths. A detached pane keeps its position with only
// its body suppressed, because a closed pane loses its width and its position and the
// window closing would then have nowhere to put the body back. A window that is LOST
// returns the body to that same slot with the crash noted above it, because a pane
// that simply reappears tells a person nothing about why it did.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge, type GrowthPort } from "../bridge/index.js";
import {
  SCENARIO,
  SESSION_ID,
  memoryStore,
  otherSession,
  sessionStore,
  workspaceFor,
  type WorkspaceSession,
} from "./Workspace.test-support.js";

describe("Workspace — a pane moved into a window of its own", () => {
  /** The fixture bridge, with the window operations this case needs served. */
  function bridgeServingWindowWire(overrides: Partial<GrowthPort>): ConsoleBridge {
    const base = createFixtureBridge({ scenario: SCENARIO });
    return { ...base, growth: { ...base.growth, ...overrides } };
  }

  const detachingPort: Partial<GrowthPort> = {
    windowDetachPane: async () => ({ status: "served", value: { windowId: "aux-1" } }),
    windowCloseAuxiliary: async () => ({ status: "served", value: undefined }),
  };

  /** Press the detach control the pane body offers, the way a header does. */
  function pressDetach(container: HTMLElement): void {
    const control = container.querySelector<HTMLButtonElement>("[data-detach='timeline']");
    expect(control).not.toBeNull();
    act(() => {
      control?.click();
    });
  }

  function placeholderText(container: HTMLElement): string {
    return container.querySelector(".meridian-deck__detached")?.textContent ?? "";
  }

  it("keeps the pane's slot and suppresses only its projection", async () => {
    // The defect: a successful detach closed the pane, so the layout filtered it out
    // and the window closing or crashing had no slot to return it to.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    pressDetach(container);

    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    expect(container.querySelector("[data-body]")).toBeNull();
    expect(placeholderText(container)).toContain("window of its own");
  });

  it("returns the projection to the same slot when the pane comes back", async () => {
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    pressDetach(container);
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });

    const returnControl = [
      ...container.querySelectorAll<HTMLButtonElement>(".meridian-deck__detached-control"),
    ].find((button) => button.textContent === "Return it to the deck");
    expect(returnControl).not.toBeUndefined();
    act(() => {
      returnControl?.click();
    });

    await waitFor(() => {
      expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    });
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
  });

  it("renders the refusal where the crashed-window signal is not served", async () => {
    // A subscription this build cannot open is not the same fact as a window that has
    // not crashed. The placeholder says which of the two it is.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    pressDetach(container);

    await waitFor(() => {
      expect(placeholderText(container)).toContain("is not registered on this build yet");
    });
    // The refusal renders in the slot it is about, carrying its own code.
    expect(
      container.querySelector(".meridian-deck__detached .meridian-refusal")?.textContent,
    ).toContain("wire-unregistered");
  });

  /**
   * A port whose crashed-window signal reports the FIRST pane detached through it.
   *
   * The pane id is taken off the detach call rather than read out of the DOM: the
   * deck mints it, and a test that scraped it back would be asserting against an
   * attribute the layout library happens to render. Reported once, so a later detach
   * of the same pane opens a stream that reports nothing.
   */
  function crashingPort(reason: string): Partial<GrowthPort> {
    let detachedPaneId: string | undefined;
    let hasReported = false;
    return {
      ...detachingPort,
      windowDetachPane: async (request: { readonly paneId: string }) => {
        detachedPaneId = request.paneId;
        return { status: "served", value: { windowId: "aux-1" } };
      },
      windowSubscribePaneErrors: async () => ({
        status: "served",
        value: {
          events: (async function* deliver() {
            await Promise.resolve();
            if (detachedPaneId !== undefined && !hasReported) {
              hasReported = true;
              yield { paneId: detachedPaneId, reason };
            }
          })(),
          close: () => undefined,
        },
      }),
    };
  }

  it("brings the pane back with the crash in its error slot when its window is lost", async () => {
    // `Spec-023 §The surface set`: "a crashed auxiliary window returns the pane to the
    // deck with the crash noted in the pane's error slot". The return happened; the
    // note did not — the reason reached the drain loop and was dropped there, so the
    // pane reappeared saying nothing about why.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(
        session,
        store,
        true,
        bridgeServingWindowWire(crashingPort("the renderer process ended")),
      ),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    pressDetach(container);

    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__pane-error")).not.toBeNull();
    });
    // The body is back — the pane works again — and the note sits above it.
    expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    expect(container.querySelector(".meridian-deck__detached")).toBeNull();
    const notice = container.querySelector(".meridian-deck__pane-error")?.textContent ?? "";
    expect(notice).toContain("window-lost");
    expect(notice).toContain("the renderer process ended");
  });

  it("clears the crash note when the pane is put back into a window", async () => {
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(
        session,
        store,
        true,
        bridgeServingWindowWire(crashingPort("the renderer process ended")),
      ),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    pressDetach(container);
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__pane-error")).not.toBeNull();
    });

    // A second detach puts the body back in a window, which makes the note about the
    // last window a note about nothing.
    pressDetach(container);

    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-deck__pane-error")).toBeNull();
  });

  it("negative control: a pane whose window nobody lost carries no error slot", async () => {
    // Without this, the cases above would pass over a deck that drew a crash note on
    // every pane — including one nobody has ever moved into a window.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    pressDetach(container);

    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-deck__pane-error")).toBeNull();
  });

  it("negative control: a pane nobody detached renders its projection unchanged", async () => {
    // Without this, every case above would pass over a deck that drew the placeholder
    // for every pane it held.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    });
    expect(container.querySelector(".meridian-deck__detached")).toBeNull();
  });

  it("does not carry a detached pane into another session", async () => {
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const bridge = bridgeServingWindowWire(detachingPort);
    const { container, rerender } = render(workspaceFor(session, store, true, bridge));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    pressDetach(container);
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });

    rerender(workspaceFor(otherSession(), store, true, bridge));

    await waitFor(() => {
      expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    });
    expect(container.querySelector(".meridian-deck__detached")).toBeNull();
  });
});
