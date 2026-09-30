// The pane layout reuses the component, handing one instance a different `paneId`. The
// replacement pane must not offer the previous pane's half-typed destination, since Enter would
// send it to a pane it was never typed for.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  addressField,
  DEFAULT_TEST_PANE_ID,
  fixtureBrowserBridge,
  mountPreviewPaneForSubject,
  recordingActs,
} from "../PreviewPane.test-support.js";

const SECOND_PANE_ID = "pane-browser-2";
const DRAFT = "example.invalid/typed-into-the-first-pane";

/** Mount the chrome over acts that record every destination it navigates to. */
async function mountRecording(): Promise<{
  readonly rebindTo: (nextPaneId: string) => Promise<void>;
  readonly dispatched: readonly string[];
}> {
  const dispatched: string[] = [];
  const { rebindTo } = await mountPreviewPaneForSubject(
    fixtureBrowserBridge(),
    DEFAULT_TEST_PANE_ID,
    undefined,
    recordingActs(dispatched),
  );
  return { rebindTo, dispatched };
}

function submitAddress(): void {
  fireEvent.submit(addressField().closest("form") as HTMLFormElement);
}

describe("the address draft belongs to the pane it was typed for", () => {
  it("renders the replacement pane following, not the previous pane's draft", async () => {
    const { rebindTo } = await mountRecording();
    fireEvent.change(addressField(), { target: { value: DRAFT } });
    expect(addressField().value).toBe(DRAFT);

    await rebindTo(SECOND_PANE_ID);

    // Following with nothing reported is the empty field and placeholder of a freshly opened pane.
    expect(addressField().value).toBe("");
    expect(addressField().placeholder).toBe("Type a destination");
  });

  it("never dispatches the previous pane's draft to the pane that replaced it", async () => {
    const { rebindTo, dispatched } = await mountRecording();
    fireEvent.change(addressField(), { target: { value: DRAFT } });

    await rebindTo(SECOND_PANE_ID);
    submitAddress();

    expect(dispatched).not.toContain(DRAFT);
  });

  it("negative control: the draft survives a re-render that keeps the same pane", async () => {
    // Without it the cases above would pass against a field that discarded the draft on any
    // re-render, and a reported navigation re-renders the pane mid-edit.
    const { rebindTo, dispatched } = await mountRecording();
    fireEvent.change(addressField(), { target: { value: DRAFT } });

    await rebindTo(DEFAULT_TEST_PANE_ID);

    expect(addressField().value).toBe(DRAFT);
    submitAddress();
    expect(dispatched).toStrictEqual([DRAFT]);
  });

  it("negative control: the field is still the pane's own, so typing reaches it", async () => {
    // A stamp compared with the wrong subject would read `following` on every pass and swallow
    // every keystroke; Escape shows both states are reachable under one subject.
    await mountRecording();
    fireEvent.change(addressField(), { target: { value: DRAFT } });
    expect(addressField().value).toBe(DRAFT);
    fireEvent.keyDown(addressField(), { key: "Escape" });
    expect(addressField().value).toBe("");
    expect(screen.getByLabelText("Destination")).toBe(addressField());
  });
});
