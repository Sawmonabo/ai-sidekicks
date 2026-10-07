// The account axis's reset control drops the entry rather than pinning the definition's
// account, and the field names an account by its label, never by its id: a pinned account the
// read registry lacks reads `Removed account`, and the account list's own states read as the
// Providers page words them. Driven through the real component over a typed registry reading.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "#renderer/lib/refusal/contract.js";
import type { AccountRegistryReading } from "#renderer/lib/provider-binding/account/axis.js";
import {
  account,
  registryAccountId,
  resolvedTo,
  served,
} from "#renderer/lib/provider-binding/account/reading.test-support.js";
import { AccountAxisField, type AccountAxisFieldProps } from "./AccountAxisField.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

/**
 * Two accounts under `claude` and one under `codex`. `acct-team` is marked default while the
 * readiness entry resolves `acct-personal`, so cases are about the entry, not the flag.
 */
const REGISTRY_ACCOUNTS = [
  account({ accountId: registryAccountId("acct-team"), isDefault: true }),
  account({
    accountId: registryAccountId("acct-personal"),
    observedAccountEmail: "sam@example.org",
    isDefault: false,
    healthState: "reauth_required",
  }),
  account({
    accountId: registryAccountId("acct-codex"),
    provider: "codex",
    observedAccountEmail: "sam@example.net",
    isDefault: true,
  }),
];

/** One case's field: the form's own two facts, plus whatever it wants scripted. */
interface AxisCase extends Pick<
  AccountAxisFieldProps,
  "value" | "inheritedValue" | "isOverridden"
> {
  readonly onValueChange?: (accountId: string | undefined) => void;
  readonly registry?: AccountRegistryReading;
  readonly onReopenRegistry?: () => void;
}

/** The field on its own, over a served registry. */
function renderedAxis(axis: AxisCase): HTMLElement {
  const { container } = render(
    <AccountAxisField
      registry={axis.registry ?? served(REGISTRY_ACCOUNTS, [resolvedTo("acct-personal")])}
      onReopenRegistry={axis.onReopenRegistry ?? ((): void => {})}
      driverName="claude"
      value={axis.value}
      inheritedValue={axis.inheritedValue}
      isOverridden={axis.isOverridden}
      onValueChange={axis.onValueChange ?? ((): void => {})}
    />,
    { wrapper: LiveAnnouncerProvider },
  );
  return container;
}

/** The reset control as it stands now, or `undefined` where none is drawn. */
function resetControl(container: HTMLElement): HTMLButtonElement | undefined {
  return (container.querySelector(".meridian-axis-field__clear") as HTMLButtonElement) ?? undefined;
}

describe("the account axis — what its reset control promises", () => {
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
});

describe("the account axis — how it names an account", () => {
  it("names the pinned account by its reported identity and a missing one by no id", () => {
    const pinned = renderedAxis({
      value: "acct-personal",
      inheritedValue: undefined,
      isOverridden: true,
    });
    expect(pinned.textContent).toContain("sam@example.org");
    expect(pinned.textContent).not.toContain("acct-personal");

    const missing = renderedAxis({
      value: "acct-removed",
      inheritedValue: undefined,
      isOverridden: true,
    });
    expect(missing.querySelector('[role="combobox"]')?.textContent).toBe("Removed account");
    expect(missing.textContent).toContain("registry does not carry that account");
    expect(missing.textContent).not.toContain("acct-removed");
  });

  it("reads the account list's own states while it is unread, refused or empty", () => {
    const pinned = { value: "acct-personal", inheritedValue: undefined, isOverridden: true };
    const unread = renderedAxis({
      ...pinned,
      registry: { phase: "reading", readRefusal: undefined, accounts: [], readiness: [] },
    });
    expect(unread.textContent).toContain("Reading the account list…");
    // Unread is not removed: nothing says the registry lacks the pinned account.
    expect(unread.textContent).not.toContain("does not carry");

    const reopened = vi.fn<() => void>();
    const refused = renderedAxis({
      ...pinned,
      onReopenRegistry: reopened,
      registry: {
        phase: "refused",
        readRefusal: refuse("test", "transport.closed", "The connection closed."),
        accounts: [],
        readiness: [],
      },
    });
    expect(refused.textContent).toContain("The account list could not be read.");
    expect(refused.textContent).not.toContain("transport.closed");
    fireEvent.click(refused.querySelector("button") as HTMLButtonElement);
    expect(reopened).toHaveBeenCalledOnce();

    const empty = renderedAxis({ ...pinned, registry: served([]) });
    expect(empty.textContent).toContain(
      "No accounts for Claude Code. Sign in to run work on this provider.",
    );
  });
});
