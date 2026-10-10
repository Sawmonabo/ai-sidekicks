// Moving a pane with Alt+Shift+Arrow in a real browser. The panel library pairs each separator
// with its panels by on-screen position, which happy-dom cannot give it: every rect there is
// zero, so a move that throws in Chromium passes under the unit tier.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { renderSettled } from "../../helpers/app/harness.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import { layoutPaneContext } from "../../helpers/pane-context.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { SessionPaneLayout } from "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import {
  PANE_LAYOUT_RESTORED_PANE_CAP,
  PaneLayoutStore,
} from "#renderer/features/sessions/pane-layout/store.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";

/**
 * Bodies that render a button, so a real key press starts from inside a pane, as a person's
 * does.
 */
function registryWithButtons(): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of ["transcript", "terminal"] as const) {
    registry.register({
      kind,
      owner: "pane-move-test",
      render: (context) => <button type="button">{context.paneId}</button>,
    });
  }
  return registry;
}

describe("browser — moving a pane", () => {
  it("moves the focused pane right on Alt+Shift+ArrowRight, layout still mounted", async () => {
    installMeridianTokens(document);
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    const first = layout.open({ kind: "transcript" });
    const second = layout.open({ kind: "terminal" });
    const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const { container } = await renderSettled(
      <FixtureBridgeProvider fixture={fixture}>
        <LiveAnnouncerProvider>
          <SessionPaneLayout
            layout={layout}
            registry={registryWithButtons()}
            paneContextFor={(pane) =>
              layoutPaneContext(pane, { bridge: fixture.bridge, sessionStore: undefined })
            }
            isSessionOpen
            sessionId={undefined}
          />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );

    const firstPaneButton = container.querySelector("[data-panel] button");
    if (!(firstPaneButton instanceof HTMLButtonElement)) {
      throw new Error("the first pane rendered no button");
    }

    // React reports an error thrown in a layout effect to the window and unmounts the tree.
    const errors: unknown[] = [];
    const recordError = (event: ErrorEvent): void => {
      errors.push(event.error);
    };
    window.addEventListener("error", recordError);
    try {
      // The move re-renders the layout and announces itself, so the presses run inside `act`.
      await act(async () => {
        await userEvent.click(firstPaneButton);
        await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
      });
    } finally {
      window.removeEventListener("error", recordError);
    }

    expect(errors).toStrictEqual([]);
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([second, first]);
    expect([...container.querySelectorAll("[data-panel]")].map((panel) => panel.id)).toStrictEqual([
      second,
      first,
    ]);
    expect(container.querySelector('[role="separator"]')?.getAttribute("aria-controls")).toBe(
      second,
    );
  });
});
