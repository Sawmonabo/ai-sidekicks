// What a subscribed surface is told, which is a different question from what the
// store holds.
//
// `session-preferences.test.ts` next door drives the durable store directly and pins
// what a refused write RECORDS. This file pins what reaches React, which the store's
// own suite cannot see: a snapshot the reader compares with `Object.is` decides
// whether a recorded refusal ever becomes a rendered one, and a store that recorded
// it perfectly still leaves a person looking at a switch that appears to have moved
// and no sentence saying the write did not land.
//
// The probe carries the whole binding in one element's text, so a case asserts on the
// pair rather than on either half: the switch moving and the refusal arriving are one
// settlement, and a case reading only the second would pass over a surface that had
// stopped rendering the first.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import type { UiStateStore } from "../../persistence/index.js";
import { openStore } from "../sessions.test-support.js";
import { useSessionPreferences } from "./session-preferences.js";

/** The binding as one string: the switch, and the refusal standing against it. */
function PreferencesProbe(props: { readonly store: UiStateStore }): React.JSX.Element {
  const preferences = useSessionPreferences(props.store);
  return (
    <button
      type="button"
      onClick={() => {
        preferences.setAutoPinOnFirstSend(false);
      }}
    >
      {`${String(preferences.isAutoPinOnFirstSendEnabled)}|${preferences.lastRefusal?.code ?? "none"}`}
    </button>
  );
}

/** Mount the probe and hand back the one element every assertion here reads. */
function mountProbe(store: UiStateStore): HTMLButtonElement {
  const { container } = render(<PreferencesProbe store={store} />);
  const control = container.querySelector("button");
  expect(control).not.toBeNull();
  return control as HTMLButtonElement;
}

/** Turn the switch off and let the durable write settle however it settles. */
async function turnTheSwitchOff(control: HTMLButtonElement): Promise<void> {
  await act(async () => {
    fireEvent.click(control);
  });
  await settle();
}

describe("the switch a surface is subscribed to", () => {
  it("renders the refusal a rejected write recorded", async () => {
    // The defect. The state emits after changing `lastRefusal`, but a snapshot
    // carrying only the switch is `Object.is`-equal across exactly that emission, so
    // React suppressed the render and the refusal stayed off screen — beside a
    // checkbox that had already moved, which reads as a write that landed.
    const control = mountProbe(openStore({ capacityBytes: 1 }));
    expect(control.textContent).toBe("true|none");

    await turnTheSwitchOff(control);

    expect(control.textContent).toBe("false|quota-exceeded");
  });

  it("negative control: a write that lands renders no refusal", async () => {
    // Without this the case above would pass over a binding that reported a refusal
    // for every write, which is the same surface lying in the other direction.
    const control = mountProbe(openStore());
    await turnTheSwitchOff(control);

    expect(control.textContent).toBe("false|none");
  });
});
