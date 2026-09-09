// The row's account disclosure and the way out of a remedy it cannot perform.
//
// THE DISCLOSURE CASES ARE ABOUT THE CHOKEPOINT AND NOT ABOUT THE COPY.
// `apps/desktop/AGENTS.md` §Chokepoints makes `primitives/figures/wire-figures.ts` the only
// module that formats a wire value, and `WireFigure` is how a surface reaches it — so
// what these assert is that a label the registry sent arrives on screen through that
// path, whole, with nothing the console composed inside the same element. Two shapes
// are excluded by construction: a `" (default)"` suffix concatenated onto the label,
// and a comma-joined string that makes a label CONTAINING a comma read as two accounts.
//
// THE REMEDY CASES ARE ABOUT WHICH ARMS GET A CONTROL, AND THE SIGN-IN ARM GETS NONE.
// Two of the three remedies name a mutating registry verb no console route serves, so
// the row offers the way to the surface that owns them, scoped to this row's provider.
// The third is the provider's OWN first-party sign-in, which `Spec-026 §Provider
// Authentication (Group B)` requires this step to display and "never run on the
// operator's behalf" — so that arm renders the invocation and the credential home the
// daemon composed and offers no control at all. This row used to carry a **Sign in to
// this provider** button that dispatched a growth operation asking the daemon to start
// the login; the case below is the negative control for its removal. Every case here
// drives the real row, so a control that stopped being rendered or stopped carrying its
// provider fails here rather than in a snapshot.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  UNREPORTED_SHELL_STATE,
  shellMutationBlock,
  type ShellMutationBlock,
} from "../../store/index.js";
import { ProviderRow } from "./ProviderRow.js";
import { providerAccountRecord } from "./provider-readiness.test-support.js";
import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

/** A label carrying the one character a comma-joined rendering cannot survive. */
const LABEL_WITH_A_COMMA = "Work, personal, and the shared one";

/** The one account the sign-in arm requires, since that is the arm one resolved on. */
const ACCOUNT_ID = "acct-claude-personal" as ProviderAccountId;

function renderRow(
  accounts: readonly ProviderAccount[],
  entry: ProviderReadiness = { provider: "codex", state: "authenticated" },
  onOpenAccountRegistry: (providerName: string) => void = () => undefined,
  recheckBlock: ShellMutationBlock | undefined = undefined,
): HTMLElement {
  const { container } = render(
    // Inside a list, because the row renders an `<li>` and a case that mounted one
    // loose would be asserting against markup no surface produces.
    <ul>
      <ProviderRow
        entry={entry}
        accounts={accounts}
        action={{ kind: "idle" }}
        onRecheck={() => undefined}
        recheckBlock={recheckBlock}
        onOpenAccountRegistry={onOpenAccountRegistry}
      />
    </ul>,
  );
  return container;
}

/** Every control the row put on screen, by its own text. */
function controlLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll("button")].map((control) => control.textContent ?? "");
}

/** Press the row's control carrying this label, failing rather than doing nothing. */
function pressControl(container: HTMLElement, label: string): void {
  const control = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (control === undefined) {
    throw new Error(`the row rendered no control labelled ${label}`);
  }
  control.click();
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

describe("the remedy this row cannot perform", () => {
  it("offers the registry, scoped to this provider, for a register remedy", () => {
    const opened: string[] = [];
    const container = renderRow(
      [],
      { provider: "codex", state: "no_account", remedy: { kind: "register", provider: "codex" } },
      (providerName) => opened.push(providerName),
    );

    // One control on the row, and it is the way to the surface that owns the verb —
    // never the verb, which no console route serves.
    expect(controlLabels(container)).toStrictEqual(["Open the registry to add an account"]);
    pressControl(container, "Open the registry to add an account");
    // Scoped: the page it opens says which provider the reader came from.
    expect(opened).toStrictEqual(["codex"]);
  });

  it("offers it for a remedy that names no default too", () => {
    const opened: string[] = [];
    const container = renderRow(
      [providerAccountRecord({ accountId: "acct-one", displayLabel: "Work", isDefault: false })],
      {
        provider: "claude",
        state: "no_default",
        remedy: { kind: "choose_default", candidateAccountIds: [] },
      },
      (providerName) => opened.push(providerName),
    );

    pressControl(container, "Open the registry to choose a default");
    expect(opened).toStrictEqual(["claude"]);
  });

  it("renders a sign-in remedy in full and offers no control that performs it", () => {
    // The negative control for the two above, and for the button this row used to
    // carry: `Spec-026 §Provider Authentication (Group B)` has the step display the
    // invocation and never run it, so the whole remedy is on screen — which provider,
    // the invocation, the credential home — and the control set is EMPTY. No account
    // resolved on this entry, so the re-check is absent too and the assertion is about
    // the sign-in arm alone.
    const container = renderRow([], {
      provider: "claude",
      state: "reauth_required",
      remedy: {
        kind: "sign_in",
        accountId: ACCOUNT_ID,
        signInInvocation: "claude /login",
        credentialHomePath: "/homes/claude",
      },
    });

    expect(controlLabels(container)).toStrictEqual([]);
    const text = container.textContent ?? "";
    expect(text).toContain("claude /login");
    expect(text).toContain("/homes/claude");
    // And it says whose job running it is, so a person is not left waiting for a
    // console that is never going to start anything.
    expect(text).toContain("this console never starts a provider's sign-in");
  });
});

describe("the re-check while the shell cannot be written to", () => {
  /**
   * The block the store derives for one supervisor state, so no sentence is retyped.
   *
   * Through the store's own derivation rather than a literal, because what this case
   * claims is that the ROW renders the cause it was handed — a hand-typed sentence
   * would keep passing after the store's own words moved.
   */
  const OFFLINE_BLOCK: ShellMutationBlock = (() => {
    const block = shellMutationBlock({
      ...UNREPORTED_SHELL_STATE,
      connection: { kind: "offline", attemptLimit: 5, lastError: undefined },
    });
    if (block === undefined) {
      throw new Error("the store derives no block for an offline supervisor");
    }
    return block;
  })();

  /** The row this arm is about: an account resolved, so a re-check is offered at all. */
  const RESOLVED: ProviderReadiness = {
    provider: "codex",
    state: "reauth_required",
    resolvedAccountId: ACCOUNT_ID,
  };

  /** The row's re-check control, failing rather than answering `undefined`. */
  function recheckControl(container: HTMLElement): HTMLButtonElement {
    const control = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Check again",
    );
    if (control === undefined) {
      throw new Error("the row rendered no re-check control");
    }
    return control;
  }

  it("disables the re-check and puts the block's own sentence beside it", () => {
    const container = renderRow([], RESOLVED, () => undefined, OFFLINE_BLOCK);

    expect(recheckControl(container).disabled).toBe(true);
    // Beside it and not instead of it: the control stays on screen, and the reason it
    // cannot be pressed is on screen with it.
    expect(container.textContent ?? "").toContain(OFFLINE_BLOCK.detail);
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
  });

  it("leaves the re-check pressable while nothing blocks it", () => {
    // The negative control. Without it every assertion above passes on a row that
    // disabled this control unconditionally.
    const container = renderRow([], RESOLVED);

    expect(recheckControl(container).disabled).toBe(false);
    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
  });
});
