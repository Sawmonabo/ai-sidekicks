// `Delete runs older than…` opened in Chromium on an age the daemon counts three runs for: the
// count in `3 runs would go` and in the `Delete 3 runs` button is drawn in the face and ink of the
// words around it, one run of text, never set apart as a figure.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { DeleteOlderRuns } from "#renderer/features/workflows/runs/components/DeleteOlderRuns.js";
import { bridgeWrapper, withAnnouncer } from "#test/helpers/app/frame-fixtures.js";
import { bridgeOnClock, withDaemonCall } from "#test/helpers/fixture/bridge.js";

import "#renderer/features/workflows/WorkflowsScreen.css";

afterEach(() => {
  cleanup();
});

/** The face and ink `character`'s first occurrence in `element` is drawn in. */
function drawnStyleOf(element: Element, character: string): string {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const holder = node.parentElement;
    if (holder !== null && node.textContent?.includes(character) === true) {
      const style = getComputedStyle(holder);
      return `${style.fontFamily} ${style.fontSize} ${style.color}`;
    }
  }
  throw new Error(`"${character}" is not in ${element.textContent ?? ""}`);
}

it("draws the count of runs that would go in the words' own face and ink", async () => {
  installMeridianTokens(document);
  const base = bridgeOnClock("workflows");
  const { bridge } = withDaemonCall(base.bridge, async (call, passThrough) =>
    call.method === "workflow.runsDeletePreview"
      ? { deleteCount: 3, keptCount: 0, waitingCount: 0 }
      : passThrough(),
  );
  render(<DeleteOlderRuns bridge={bridge} />, {
    wrapper: withAnnouncer(bridgeWrapper(bridge, base.clock)),
  });
  await act(async () => {
    screen.getByRole("button", { name: "Delete runs older than…" }).click();
  });
  const line = await screen.findByText(/would go/);
  const button = screen.getByRole("button", { name: "Delete 3 runs" });

  expect(drawnStyleOf(line, "3")).toBe(drawnStyleOf(line, "w"));
  expect(drawnStyleOf(button, "3")).toBe(drawnStyleOf(button, "D"));
});
