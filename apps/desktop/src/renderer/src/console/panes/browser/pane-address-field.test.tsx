// Whose draft the address field is holding, when one component instance serves two
// panes in turn.
//
// The deck reuses the component: a slot that changes subject hands the same instance
// a different `paneId`, and every case below is about the interval that opens then.
// The failure it replaces is silent in the worst way — the replacement pane looks
// like it is offering the operator their own half-typed destination, and Enter sends
// that destination to a pane they never typed it for.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../../bridge/index.js";
import {
  addressField,
  DEFAULT_TEST_PANE_ID,
  mountBrowserPaneForSubject,
} from "./BrowserPane.test-support.js";

const SECOND_PANE_ID = "pane-browser-2";
const DRAFT = "example.invalid/typed-into-the-first-pane";

/** A bridge that records every navigation the chrome dispatches, and refuses it. */
function navigationRecordingBridge(): {
  readonly bridge: ConsoleBridge;
  readonly dispatched: readonly { readonly paneId: string; readonly url: string }[];
} {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  const dispatched: { readonly paneId: string; readonly url: string }[] = [];
  return {
    dispatched,
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        browserNavigate: async (request: { paneId: string; url: string }) => {
          dispatched.push({ paneId: request.paneId, url: request.url });
          return growthUnavailable("browserNavigate");
        },
      },
    },
  };
}

function submitAddress(): void {
  fireEvent.submit(addressField().closest("form") as HTMLFormElement);
}

describe("the address draft belongs to the pane it was typed for", () => {
  it("renders the replacement pane following, not the previous pane's draft", async () => {
    const { bridge } = navigationRecordingBridge();
    const { rebindTo } = await mountBrowserPaneForSubject(bridge, DEFAULT_TEST_PANE_ID);
    fireEvent.change(addressField(), { target: { value: DRAFT } });
    expect(addressField().value).toBe(DRAFT);

    await rebindTo(SECOND_PANE_ID);

    // Following with nothing reported is the empty field and its placeholder, which
    // is what a freshly opened pane shows.
    expect(addressField().value).toBe("");
    expect(addressField().placeholder).toBe("Type a destination");
  });

  it("never dispatches the previous pane's draft to the pane that replaced it", async () => {
    const { bridge, dispatched } = navigationRecordingBridge();
    const { rebindTo } = await mountBrowserPaneForSubject(bridge, DEFAULT_TEST_PANE_ID);
    fireEvent.change(addressField(), { target: { value: DRAFT } });

    await rebindTo(SECOND_PANE_ID);
    submitAddress();

    expect(dispatched.map((call) => call.url)).not.toContain(DRAFT);
    for (const call of dispatched) {
      expect(call.paneId).toBe(SECOND_PANE_ID);
    }
  });

  it("negative control: the draft survives a re-render that keeps the same pane", async () => {
    // Without it every case above would pass against a field that discarded the
    // draft on any re-render at all — which is a chrome nobody can type a
    // destination into, since a reported navigation re-renders the pane mid-edit.
    const { bridge, dispatched } = navigationRecordingBridge();
    const { rebindTo } = await mountBrowserPaneForSubject(bridge, DEFAULT_TEST_PANE_ID);
    fireEvent.change(addressField(), { target: { value: DRAFT } });

    await rebindTo(DEFAULT_TEST_PANE_ID);

    expect(addressField().value).toBe(DRAFT);
    submitAddress();
    expect(dispatched).toStrictEqual([{ paneId: DEFAULT_TEST_PANE_ID, url: DRAFT }]);
  });

  it("negative control: the field is still the pane's own, so typing reaches it", async () => {
    // A stamp compared with the wrong subject would read `following` on every pass
    // and swallow every keystroke. The Escape path is the witness that the two
    // states are both reachable under one subject.
    const { bridge } = navigationRecordingBridge();
    await mountBrowserPaneForSubject(bridge, DEFAULT_TEST_PANE_ID);
    fireEvent.change(addressField(), { target: { value: DRAFT } });
    expect(addressField().value).toBe(DRAFT);
    fireEvent.keyDown(addressField(), { key: "Escape" });
    expect(addressField().value).toBe("");
    expect(screen.getByLabelText("Destination")).toBe(addressField());
  });
});
