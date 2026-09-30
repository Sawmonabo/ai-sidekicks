// The account axis on its own, for what a column render cannot reach: the reset control's
// states (an entry over a definition's account, over nothing, and a definition's account with
// no entry) and the unpinned state a person meets the field in. Driven through the real
// component over a typed registry reading.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AccountRegistryReading } from "../account-axis.js";
import { account, registryAccountId, resolvedTo, served } from "../account-reading.test-support.js";
import { AccountAxisField, type AccountAxisFieldProps } from "./AccountAxisField.js";

/**
 * Two accounts under `claude` and one under `codex`. `acct-team` is marked default while the
 * readiness entry resolves `acct-personal`, so cases are about the entry, not the flag.
 */
const REGISTRY_ACCOUNTS = [
  account({ accountId: registryAccountId("acct-team"), displayLabel: "Team", isDefault: true }),
  account({
    accountId: registryAccountId("acct-personal"),
    displayLabel: "Personal",
    isDefault: false,
    healthState: "reauth_required",
  }),
  account({
    accountId: registryAccountId("acct-codex"),
    provider: "codex",
    displayLabel: "Codex",
    isDefault: true,
  }),
];

/** The same accounts with none marked default, and the entry that says so. */
const REGISTRY_WITH_NO_DEFAULT: AccountRegistryReading = served(
  REGISTRY_ACCOUNTS.map((row) => ({ ...row, isDefault: false })),
  [
    {
      provider: "claude",
      state: "no_default",
      remedy: {
        kind: "choose_default",
        candidateAccountIds: [registryAccountId("acct-team"), registryAccountId("acct-personal")],
      },
    },
  ],
);

/** One case's field: the form's own two facts, plus whatever it wants scripted. */
interface AxisCase extends Pick<
  AccountAxisFieldProps,
  "value" | "inheritedValue" | "isOverridden"
> {
  readonly onValueChange?: (accountId: string | undefined) => void;
  readonly registry?: AccountRegistryReading;
}

/** The field on its own, over the registry a case hands it. */
function renderedAxis(axis: AxisCase): HTMLElement {
  const { container } = render(
    <AccountAxisField
      registry={axis.registry ?? served(REGISTRY_ACCOUNTS, [resolvedTo("acct-personal")])}
      onReopenRegistry={(): void => {}}
      driverName="claude"
      value={axis.value}
      inheritedValue={axis.inheritedValue}
      isOverridden={axis.isOverridden}
      onValueChange={axis.onValueChange ?? ((): void => {})}
    />,
  );
  return container;
}

/** The reset control as it stands now, or `undefined` where none is drawn. */
function resetControl(container: HTMLElement): HTMLButtonElement | undefined {
  return (container.querySelector(".meridian-axis-field__clear") as HTMLButtonElement) ?? undefined;
}

describe("the account axis — what its reset control promises", () => {
  it("names the definition's account where dropping the entry is what a press does", () => {
    const container = renderedAxis({
      value: "acct-personal",
      inheritedValue: "acct-team",
      isOverridden: true,
    });

    expect(resetControl(container)?.textContent).toBe("Use the definition’s account");
  });

  it("hands the drop up, which is the whole of what the press performs", () => {
    const dropped = vi.fn<(accountId: string | undefined) => void>();
    const container = renderedAxis({
      value: "acct-personal",
      inheritedValue: "acct-team",
      isOverridden: true,
      onValueChange: dropped,
    });

    fireEvent.click(resetControl(container) as HTMLButtonElement);
    // `undefined`, never the definition's account: sending the inherited value would be an
    // explicit override.
    expect(dropped).toHaveBeenCalledWith(undefined);
  });

  it("draws no control at all over a definition's own inherited account", () => {
    // A control that cannot perform its label is absent rather than disabled: over a
    // definition's own account there is no entry to drop.
    const container = renderedAxis({
      value: "acct-team",
      inheritedValue: "acct-team",
      isOverridden: false,
    });

    expect(resetControl(container)).toBeUndefined();
    expect(container.textContent ?? "").not.toContain("default account");
    expect(container.textContent ?? "").toContain("This account is the definition’s");
  });

  it("negative control: an entry standing over nothing does reach the provider default", () => {
    // Otherwise the case above would pass over a field that merely stopped drawing the control.
    const container = renderedAxis({
      value: "acct-personal",
      inheritedValue: undefined,
      isOverridden: false,
    });

    expect(resetControl(container)?.textContent).toBe("Use the provider’s default account");
  });

  it("negative control: an unpinned axis offers nothing to reset", () => {
    const container = renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
    });

    expect(resetControl(container)).toBeUndefined();
  });
});

// Nothing pinned is a request for the provider's registered default, and the readiness entry
// names the account resolution reached. The fixture marks `acct-team` default but resolves
// `acct-personal`, so these cases are about the entry rather than the flag.
describe("the account axis — the account an unpinned run resolves to", () => {
  /** The field with nothing pinned, which is how the field opens. */
  function unpinnedAxis(registry?: AccountRegistryReading): HTMLElement {
    return renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
      ...(registry === undefined ? {} : { registry }),
    });
  }

  it("shows the stored reading, the admission state, and the remedy of the resolved account", () => {
    const text = unpinnedAxis().textContent ?? "";

    expect(text).toContain("needing a fresh sign-in");
    expect(text).toContain("Run admission last read this provider as reauth_required.");
    expect(text).toContain("Signing this account in again is what run admission is waiting for.");
  });

  it("says which account the readings are about, and that the form pins none", () => {
    // A default's health must not be read as a pinned account's, so the list says which it is
    // about.
    const text = unpinnedAxis().textContent ?? "";

    expect(text).toContain("Nothing is pinned, so this run resolves to Personal.");
    expect(text).toContain("the request still names no account");
  });

  it("takes the account the entry resolved and never the row the registry marks default", () => {
    // `acct-team` carries the default flag here; `Personal` is what resolution reached, which
    // is the account the spawn path uses.
    const text = unpinnedAxis().textContent ?? "";

    expect(text).toContain("resolves to Personal");
    expect(text).not.toContain("resolves to Team");
  });

  it("writes nothing, because naming the default is not pinning it", () => {
    const written = vi.fn<(accountId: string | undefined) => void>();
    renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
      onValueChange: written,
    });

    expect(written).not.toHaveBeenCalled();
  });

  it("names the remedy where resolution reached no account at all", () => {
    // Accounts exist but none is default, so no resolved row can carry the remedy.
    const text = unpinnedAxis(REGISTRY_WITH_NO_DEFAULT).textContent ?? "";

    expect(text).toContain(
      "Accounts are registered for this provider and none of them is the default.",
    );
  });

  it("negative control: a pinned axis shows that account's readings and not the default's", () => {
    // Otherwise the derivation could speak over every state.
    const container = renderedAxis({
      value: "acct-team",
      inheritedValue: undefined,
      isOverridden: false,
    });
    const text = container.textContent ?? "";

    expect(text).toContain("What follows is about Team, the account this form pins.");
    expect(text).not.toContain("resolves to");
    expect(text).not.toContain("reauth_required");
    expect(text).not.toContain("Signing this account in again");
  });

  it("negative control: a registry that resolves an account names no missing default", () => {
    // An entry that resolved a row and one that resolved none differ; otherwise the remedy
    // would render beside the resolved row's own list.
    const text = unpinnedAxis().textContent ?? "";

    expect(text).not.toContain("none of them is the default");
  });
});

describe("the account axis — the picker's accessible name", () => {
  /** The field, unpinned and served — the state a person meets it in. */
  function renderedUnpinnedAxis(): HTMLElement {
    return renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
    });
  }

  it("names the trigger with the field's own visible label", () => {
    // `role="combobox"` takes no name from its content and the field's root is a `div`, not a
    // `<label>`, so the trigger needs the explicit association; unpinned, it has no value text.
    const field = within(renderedUnpinnedAxis());

    expect(field.getByRole("combobox", { name: "Provider account" })).not.toBeNull();
  });

  it("negative control: the query is naming the control rather than matching anything", () => {
    // A control is present, so the case above fails on the name and not on an absent trigger;
    // a name the field lacks finds nothing, so a matcher matching everything is caught.
    const field = within(renderedUnpinnedAxis());

    expect(field.getAllByRole("combobox")).toHaveLength(1);
    expect(field.queryByRole("combobox", { name: "Model" })).toBeNull();
  });
});
