// The accounts page speaks the registry's own vocabulary, invents no row, composes
// no remedy, and mounts a seat rather than a body.
//
// The vocabulary cases drive the CONTRACT's own arrays rather than a hand-listed
// copy: a test restating the six readiness states would be a second closed set, and
// the first one to go stale when a seventh lands.

import {
  BILLING_MODES,
  PROVIDER_ACCOUNT_HEALTH_STATES,
  PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
  PROVIDER_READINESS_STATES,
} from "@ai-sidekicks/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "../../../core/settle.test-support.js";
import {
  createFixture,
  withDaemonCall,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../../../bridge/readings/scheduled-read.test-support.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { ProviderAccountsPage, registerProviderAccountsPage } from "./ProviderAccountsPage.js";
import { PROVIDER_ACCOUNTS_PAGE, PROVIDER_ACCOUNTS_PAGE_SLOT } from "./provider-accounts-slot.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";
import { consoleTestUiStateStore } from "../../settings-page-mount.test-support.js";

afterEach(async () => {
  // SETTLE, THEN TEAR DOWN. This page takes one read at mount — the account plane's,
  // for the refusal it renders — and the cases that assert on its static vocabulary do
  // not wait for it. Left alone, that arrival lands on a tree already coming down and
  // outside React's scope, which React reports as an unwrapped update on stderr and
  // charges to whichever file vitest happened to be running. Landing it here changes
  // no claim any case makes: every assertion has already been taken.
  await settle();
  cleanup();
});

/**
 * A context over a real fixture bridge.
 *
 * The bridge stopped being optional when the page grew its one read: it renders the
 * account plane's read REFUSAL, so a case handed no bridge would exercise none of the
 * path a person sees. The fixture is the shipped one, and what it answers for a call
 * no scenario scripts is what a release build answers.
 */
function contextOver(
  bridge: ConsoleBridge,
  openSection: SettingsPageContext["openSection"] = () => undefined,
): SettingsPageContext {
  return {
    bridge,
    openSection,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    uiStateStore: consoleTestUiStateStore(),
  } satisfies SettingsPageContext;
}

function renderPage(bridge: ConsoleBridge = createFixture().bridge): HTMLElement {
  const { container } = render(<ProviderAccountsPage context={contextOver(bridge)} />);
  return container;
}

function renderedText(): string {
  return renderPage().textContent ?? "";
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
    const container = renderPage();
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

describe("the accounts page — a registry read that refused", () => {
  /** A bridge whose registry read refuses with the code a case names. */
  function bridgeRefusingWith(dottedCode: string): ConsoleBridge {
    return withDaemonCall(createFixture().bridge, async ({ method }) => {
      if (method !== "providerAccount.list") {
        throw new Error(`unexpected daemon call: ${method}`);
      }
      // The JSON-RPC envelope's own shape, so what the page renders is what the
      // console's one normalizer makes of a real refusal rather than of a
      // hand-built `ConsoleRefusal` that skipped it.
      throw { data: { type: dottedCode }, message: "The node refused the registry read." };
    }).bridge;
  }

  it("says the read failed, in the daemon's own code, rather than leaving the page silent", async () => {
    const bridge = bridgeRefusingWith("provideraccount.permission_denied");
    const container = renderPage(bridge);
    await settleScheduledRead(bridge);
    const text = container.textContent ?? "";
    expect(text).toContain("Reading the registry");
    expect(text).toContain("provideraccount.permission_denied");
    // No console act closes an authority refusal, so nothing is offered.
    expect(container.querySelector(".meridian-account-handoff")).toBeNull();
  });

  it("names the act that closes a refusal a console page answers, without offering to go here", async () => {
    const bridge = bridgeRefusingWith("provideraccount.no_default");
    const container = renderPage(bridge);
    await settleScheduledRead(bridge);
    expect(container.textContent ?? "").toContain("Choosing which account answers");
    // The handoff routes to this very section, so the navigation is withheld while
    // the sentence still says what has to happen.
    expect(container.querySelector(".meridian-account-handoff__action")).toBeNull();
  });

  it("negative control: a read that has not refused renders no such block", () => {
    // Before the scheduled read settles, the reading has refused nothing — so the
    // block above is a projection of a real phase rather than a permanent fixture.
    expect(renderPage().querySelector('section[aria-label="Reading the registry"]')).toBeNull();
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
