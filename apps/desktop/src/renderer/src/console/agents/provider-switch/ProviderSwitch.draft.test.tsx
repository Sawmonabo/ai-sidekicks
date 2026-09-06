// The draft follows the binding it is a difference from.
//
// The component stays mounted across a roster re-read — its key is the agent — so a
// binding that MOVES underneath an open draft is the case worth its own file. There
// are two directions and they must not be confused: an axis the binding has caught up
// with is settled and the draft entry for it is gone, while an axis still being edited
// is kept and rebased onto the new values. Dropping the second would lose a person's
// work to somebody else's switch landing; keeping the first would offer a second,
// now redundant, switch to submit.
//
// What a move CLEARS is `ProviderSwitch.chain.test.tsx`; which controls exist and
// what a press submits is `ProviderSwitch.controls.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentRosterEntry } from "../../bridge/index.js";
import { ProviderSwitch } from "./ProviderSwitch.js";
import {
  LOADED,
  ON_CLAUDE,
  applyActions,
  axisValueOf,
  chooseAxisValue,
  editProviderAccount,
  providerAccountValue,
} from "./provider-switch.test-support.js";

describe("provider switch — the draft follows the binding it is a difference from", () => {
  /** The same mount, re-rendered with the agent as the roster now reports it. */
  function withAgent(agent: AgentRosterEntry): React.JSX.Element {
    return <ProviderSwitch agent={agent} catalog={LOADED} onApply={() => {}} />;
  }

  const ON_ACCOUNT_ONE: AgentRosterEntry = {
    ...ON_CLAUDE,
    config: { providerAccountId: "account-1" },
  };

  it("clears a draft the binding has caught up with, and takes the actions away", () => {
    // The defect: the component stays mounted — its key is the agent — so a terminal
    // event applying the switch left the old draft in front of the new authoritative
    // values, with both actions live and a second, now redundant, switch to submit.
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    editProviderAccount(container, "account-2");
    expect(applyActions(container).length).toBe(2);

    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-2" } }));

    expect(applyActions(container).length).toBe(0);
    expect(providerAccountValue(container)).toBe("account-2");
  });

  it("keeps an axis still being edited and rebases it onto the new values", () => {
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    chooseAxisValue(container, "Output speed", "fast");
    editProviderAccount(container, "account-2");

    // The speed landed; the account edit is still the participant's.
    rerender(
      withAgent({
        ...ON_ACCOUNT_ONE,
        config: { providerAccountId: "account-1", outputSpeed: "fast" },
      }),
    );

    expect(applyActions(container).length).toBe(2);
    expect(providerAccountValue(container)).toBe("account-2");
    expect(axisValueOf(container, "Output speed")).toBe("fast");
  });

  it("negative control: a re-read that changed nothing leaves the draft alone", () => {
    // The roster answers with a fresh object every read, so a draft cleared by
    // identity rather than by value would lose the participant's work on a refresh
    // that moved nothing at all.
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    editProviderAccount(container, "account-2");

    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-1" } }));

    expect(applyActions(container).length).toBe(2);
    expect(providerAccountValue(container)).toBe("account-2");
  });

  it("does not bring a settled draft back when the binding moves on again", () => {
    // The stamp advances rather than only being compared: measured against the
    // binding the draft was born under, `account-2` would read as an edit again the
    // moment someone else moved the account somewhere else.
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    editProviderAccount(container, "account-2");
    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-2" } }));
    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-3" } }));

    expect(applyActions(container).length).toBe(0);
    expect(providerAccountValue(container)).toBe("account-3");
  });
});
