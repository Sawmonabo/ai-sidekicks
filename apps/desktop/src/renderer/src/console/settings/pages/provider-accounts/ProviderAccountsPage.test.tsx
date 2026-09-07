// The accounts page speaks the registry's own vocabulary, invents no row, composes
// no remedy, mounts a seat rather than a body, and says which provider it was
// opened for when an address named one.
//
// The vocabulary cases drive the CONTRACT's own arrays rather than a hand-listed
// copy: a test restating the six readiness states would be a second closed set, and
// the first one to go stale when a seventh lands.
//
// THE SELECTION CASES ARE ABOUT A RESERVATION THAT HAS TO CARRY ITS OWN CONTEXT.
// A first-run row sends a person here for one provider whose remedy is "register an
// account", and the body that would register it is not built — so what they meet is
// a reservation, and a reservation that named neither the provider nor the cost of
// leaving would be a dead end. The address is also a path segment anyone can type,
// so the last case is the one that keeps an arbitrary string off the screen.

import {
  BILLING_MODES,
  PROVIDER_ACCOUNT_HEALTH_STATES,
  PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
  PROVIDER_READINESS_STATES,
} from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderAccountsPage, registerProviderAccountsPage } from "./ProviderAccountsPage.js";
import { PROVIDER_ACCOUNTS_PAGE, PROVIDER_ACCOUNTS_PAGE_SLOT } from "./provider-accounts-slot.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";
import { UNREPORTED_SHELL_STATE } from "../../../store/index.js";

const CONTEXT = {
  bridge: undefined as never,
  openSection: () => undefined,
  retainedSessionId: undefined,
  retainedSessionStore: undefined,
  shellState: UNREPORTED_SHELL_STATE,
  selection: undefined,
} satisfies SettingsPageContext;

/** The same context, reached by an address whose second segment named something. */
function contextOpenedFor(selection: string): SettingsPageContext {
  return { ...CONTEXT, selection };
}

function renderedText(context: SettingsPageContext = CONTEXT): string {
  const { container } = render(<ProviderAccountsPage context={context} />);
  return container.textContent ?? "";
}

describe("the accounts page — the vocabulary it renders", () => {
  it("explains every billing mode, health state, and readiness state the wire declares", () => {
    const terms = [
      ...BILLING_MODES,
      ...PROVIDER_ACCOUNT_HEALTH_STATES,
      ...PROVIDER_READINESS_STATES,
    ];
    // Vacuity guard: an empty contract array would make the loop below assert
    // nothing at all, and the page would pass while explaining none of them.
    expect(terms.length).toBeGreaterThan(10);
    const rendered = renderedText();
    for (const term of terms) {
      expect(rendered).toContain(term);
    }
  });

  it("negative control: it does not render a term the contract never declared", () => {
    // Without this, the case above would pass over a page that rendered every
    // string it could think of — the vocabulary would then be prose rather than a
    // projection of the closed set, and would drift the moment one member moved.
    expect(renderedText()).not.toContain("suspended");
  });

  it("says where a quota reading came from, and which one stands", () => {
    const text = renderedText();
    expect(text).toContain("Where a quota reading came from");
    expect(text).toContain("probe");
    expect(text).toContain("newest observation is the one that stands");
  });

  it("names the one write-only wire member rather than a field name of its own", () => {
    const text = renderedText();
    expect(PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS.length).toBeGreaterThan(0);
    for (const member of PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS) {
      expect(text).toContain(member);
    }
  });
});

describe("the accounts page — what it must not do", () => {
  it("asks for nothing and offers no control it has no verb for", () => {
    // The registry read is not a wire this console has. A form here would be a
    // control that fails on press, which reads as a broken feature rather than an
    // unbuilt one.
    const { container } = render(<ProviderAccountsPage context={CONTEXT} />);
    expect(container.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });

  it("composes no remedy of its own", () => {
    // The action that closes a readiness state carries a credential-home path and a
    // first-party command only the node holding them can name, so this page says
    // the daemon composes it and states none itself.
    const text = renderedText();
    expect(text).toContain("composed by the daemon");
    expect(text).not.toMatch(/\bchoose_default\b|\bsign_in\b/u);
  });

  it("names no governance work anywhere a person reads", () => {
    const text = renderedText();
    expect(text).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
    expect(text).not.toContain(PROVIDER_ACCOUNTS_PAGE_SLOT.contract.owningTask);
    expect(text).not.toContain(PROVIDER_ACCOUNTS_PAGE_SLOT.contract.deleteShellIn);
  });

  it("negative control: the page does render text that could have carried it", () => {
    // Without the length check, the case above would pass over a page that rendered
    // nothing at all — which is the failure it is written to exclude.
    expect(renderedText().length).toBeGreaterThan(400);
  });
});

describe("the accounts page — the seat it mounts", () => {
  it("states the body's absence rather than drawing an empty registry", () => {
    expect(renderedText()).toContain(PROVIDER_ACCOUNTS_PAGE.reservationTitle);
  });

  it("answers all three of the questions a seat exists to answer", () => {
    const { contract } = PROVIDER_ACCOUNTS_PAGE_SLOT;
    expect(contract.owningTask.length).toBeGreaterThan(0);
    expect(contract.mountObligation.length).toBeGreaterThan(0);
    expect(contract.deleteShellIn.length).toBeGreaterThan(0);
    expect(PROVIDER_ACCOUNTS_PAGE_SLOT.body).toBeUndefined();
  });

  it("claims the accounts section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerProviderAccountsPage(registry);
    const descriptor = registry.descriptorFor("accounts");
    expect(descriptor?.label).toBe("Provider accounts");
    expect(descriptor?.keywords).toContain("sign in");
  });
});

describe("the accounts page — the provider it was opened for", () => {
  it("names that provider and what the first run against it will do", () => {
    const text = renderedText(contextOpenedFor("codex"));
    expect(text).toContain("codex");
    // Not merely the name: the reservation says what leaving it unregistered costs,
    // which is the sentence the walkthrough's own completion summary makes true.
    expect(text).toContain("the first run against this provider is refused");
  });

  it("says nothing of the sort when the rail opened it", () => {
    // The negative control for the case above and the reason the section is
    // conditional: a page reached from the rail was opened for nobody, and a
    // reservation that spoke as though somebody had been sent here would be
    // addressing a reader who does not exist.
    expect(renderedText()).not.toContain("You were sent here");
  });

  it("renders nothing for a segment the contract never declared", () => {
    // The selection is a path segment anyone can type. A page that echoed it back
    // would put an arbitrary string on screen in the position a provider name
    // occupies, so an unrecognised one resolves to the same state the rail hands it.
    const text = renderedText(contextOpenedFor("<script>notaprovider</script>"));
    expect(text).not.toContain("notaprovider");
    expect(text).not.toContain("You were sent here");
  });
});
