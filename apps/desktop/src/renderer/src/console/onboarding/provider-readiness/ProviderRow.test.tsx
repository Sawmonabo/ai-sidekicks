// The row's account disclosure: one figure per account, and the annotation outside it.
//
// THE CASES ARE ABOUT THE CHOKEPOINT AND NOT ABOUT THE COPY. `apps/desktop/AGENTS.md`
// §Chokepoints makes `primitives/wire-figures.ts` the only module that formats a wire
// value, and `WireFigure` is how a surface reaches it — so what these assert is that a
// label the registry sent arrives on screen through that path, whole, with nothing the
// console composed inside the same element. Two shapes are excluded by construction:
// a `" (default)"` suffix concatenated onto the label, and a comma-joined string that
// makes a label CONTAINING a comma read as two accounts.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderRow } from "./ProviderRow.js";
import { providerAccountRecord } from "./provider-readiness.test-support.js";
import type { ProviderAccount } from "@ai-sidekicks/contracts";

/** A label carrying the one character a comma-joined rendering cannot survive. */
const LABEL_WITH_A_COMMA = "Work, personal, and the shared one";

function renderRow(accounts: readonly ProviderAccount[]): HTMLElement {
  const { container } = render(
    // Inside a list, because the row renders an `<li>` and a case that mounted one
    // loose would be asserting against markup no surface produces.
    <ul>
      <ProviderRow
        entry={{ provider: "codex", state: "authenticated" }}
        accounts={accounts}
        action={{ kind: "idle" }}
        onSignIn={() => undefined}
        onRecheck={() => undefined}
      />
    </ul>,
  );
  return container;
}

/**
 * The disclosure cell the accounts are rendered into.
 *
 * Located through its own term rather than by a class, because the row renders wire
 * figures for the provider name and the observation too — a case counting every figure
 * in the row would pass for the wrong reason the day one of those moves.
 */
function accountsCell(container: HTMLElement): HTMLElement {
  const term = [...container.querySelectorAll("dt")].find(
    (one) => one.textContent === "Accounts registered for this provider",
  );
  const cell = term?.nextElementSibling;
  if (!(cell instanceof HTMLElement)) {
    throw new Error("the row rendered no accounts cell");
  }
  return cell;
}

/** Every wire figure inside the accounts cell, in document order. */
function accountFigures(container: HTMLElement): readonly string[] {
  return [...accountsCell(container).querySelectorAll(".meridian-figure--wire")].map(
    (figure) => figure.textContent ?? "",
  );
}

describe("the accounts this provider holds", () => {
  it("renders a label carrying a comma as exactly one figure", () => {
    const container = renderRow([
      providerAccountRecord({
        accountId: "acct-comma",
        displayLabel: LABEL_WITH_A_COMMA,
        isDefault: false,
      }),
    ]);

    // One figure, carrying every byte of the label. A comma-joined string would have
    // rendered the same text and made this account indistinguishable from three.
    expect(accountFigures(container)).toStrictEqual([LABEL_WITH_A_COMMA]);
  });

  it("renders one figure per account", () => {
    const container = renderRow([
      providerAccountRecord({ accountId: "acct-one", displayLabel: "Personal", isDefault: true }),
      providerAccountRecord({ accountId: "acct-two", displayLabel: "Work", isDefault: false }),
    ]);

    expect(accountFigures(container)).toStrictEqual(["Personal", "Work"]);
  });

  it("keeps the default annotation outside every figure", () => {
    const container = renderRow([
      providerAccountRecord({ accountId: "acct-one", displayLabel: "Personal", isDefault: true }),
      providerAccountRecord({ accountId: "acct-two", displayLabel: "Work", isDefault: false }),
    ]);

    // The annotation is on screen — the reader still learns which account resolves —
    // and no figure carries a character of it. Mono is the signature that the daemon
    // sent the string, and these words are the console's.
    const cellText = accountsCell(container).textContent ?? "";
    expect(cellText).toContain("the one this provider resolves to");
    for (const figure of accountFigures(container)) {
      expect(figure).not.toContain("resolves to");
      expect(figure).not.toContain("default");
    }
  });

  it("says the registry holds none rather than rendering an empty figure", () => {
    const container = renderRow([]);

    expect(accountsCell(container).textContent).toBe("None.");
    expect(accountFigures(container)).toStrictEqual([]);
  });
});
