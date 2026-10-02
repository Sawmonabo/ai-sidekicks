// The pane layout reuses the component, handing one instance a different `paneId`. The
// replacement pane must not offer the previous pane's half-typed destination, since Enter would
// send it to a pane it was never typed for.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  addressField,
  DEFAULT_TEST_PANE_ID,
  fixturePreviewBridge,
  mountPreviewPaneForSubject,
  recordingActs,
  SECOND_TEST_PANE_ID,
} from "../PreviewPane.test-support.js";

const DRAFT = "example.invalid/typed-into-the-first-pane";

/** Mount the chrome over acts that record every destination it navigates to. */
async function mountRecording(): Promise<{
  readonly rebindTo: (nextPaneId: string) => Promise<void>;
  readonly dispatched: readonly string[];
}> {
  const dispatched: string[] = [];
  const { rebindTo } = await mountPreviewPaneForSubject(
    fixturePreviewBridge(),
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
  it("never dispatches the previous pane's draft to the pane that replaced it", async () => {
    const { rebindTo, dispatched } = await mountRecording();
    fireEvent.change(addressField(), { target: { value: DRAFT } });

    await rebindTo(SECOND_TEST_PANE_ID);
    submitAddress();

    expect(dispatched).not.toContain(DRAFT);
  });
});
