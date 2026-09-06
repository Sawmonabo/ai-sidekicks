// What the switch says it will do, and whether it is the rule saying it.
//
// The property worth asserting is not that a checkbox toggles. It is that the two
// sentences under it come FROM `autoPinDecision` — so a conjunct that changes moves
// the text a person reads, rather than leaving prose that agrees with a rule the
// console no longer follows.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AutoPinSetting } from "./AutoPinSetting.js";
import { refuse } from "../../core/index.js";
import type { SessionPreferenceBinding } from "../rows/session-preferences.js";

function binding(overrides: Partial<SessionPreferenceBinding> = {}): SessionPreferenceBinding {
  return {
    isAutoPinOnFirstSendEnabled: true,
    lastRefusal: undefined,
    setAutoPinOnFirstSend: () => undefined,
    ...overrides,
  };
}

describe("the auto-pin switch", () => {
  it("says a session started here is pinned while it is on", () => {
    const { container } = render(<AutoPinSetting preferences={binding()} />);

    expect(container.textContent).toContain("A session you start here is pinned");
  });

  it("says nothing is pinned automatically while it is off", () => {
    const { container } = render(
      <AutoPinSetting preferences={binding({ isAutoPinOnFirstSendEnabled: false })} />,
    );

    expect(container.textContent).toContain("Nothing is pinned automatically while this is off.");
    expect(container.textContent).not.toContain("A session you start here is pinned");
  });

  it("declines to guess for a session whose origin nothing reports", () => {
    // The conjunct the rule exists for, surfaced rather than hidden: a person whose
    // list is mostly sessions this window did not start should not read the switch as
    // a promise about all of them.
    const { container } = render(<AutoPinSetting preferences={binding()} />);

    expect(container.textContent).toContain("nothing reports where it came from");
  });

  it("would notice a sentence that ignored the switch", () => {
    // The negative control: the two renderings above must actually differ, or the
    // text is prose beside the rule rather than a reading of it.
    const on = render(<AutoPinSetting preferences={binding()} />).container.textContent;
    const off = render(
      <AutoPinSetting preferences={binding({ isAutoPinOnFirstSendEnabled: false })} />,
    ).container.textContent;

    expect(on).not.toBe(off);
  });

  it("hands the press to the store rather than holding a copy of the switch", () => {
    const pressed: boolean[] = [];
    const { container } = render(
      <AutoPinSetting
        preferences={binding({
          setAutoPinOnFirstSend: (isEnabled) => {
            pressed.push(isEnabled);
          },
        })}
      />,
    );
    const checkbox = container.querySelector<HTMLInputElement>("input[type=checkbox]");

    act(() => {
      checkbox?.click();
    });

    expect(pressed).toStrictEqual([false]);
  });

  it("renders a write that failed as itself", () => {
    // A durable write that did not land is not a control that snapped back: the
    // person's decision was not recorded and the surface has to say so.
    const { container } = render(
      <AutoPinSetting
        preferences={binding({
          lastRefusal: refuse("persistence", "quota-exceeded", "The record was not written."),
        })}
      />,
    );

    expect(container.textContent).toContain("quota-exceeded");
  });
});
