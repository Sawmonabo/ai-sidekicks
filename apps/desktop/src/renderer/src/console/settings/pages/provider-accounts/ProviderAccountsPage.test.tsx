// The accounts page speaks the registry's own vocabulary, invents no row, composes
// no remedy, and mounts a seat that carries a body under the fixture.
//
// The vocabulary cases drive the CONTRACT's own arrays rather than a hand-listed
// copy: a test restating the six readiness states would be a second closed set, and
// the first one to go stale when a seventh lands.
//
// AND THEY READ THE FRAME RATHER THAN THE PAGE. The seat at the foot of this page
// carries the registry body — the owning plan's when it lands, and the fixture shell
// standing in for it under the fixture define today — which renders the same
// vocabulary in its rows. A vocabulary case reading the whole container would then
// pass on the BODY's words while the frame explained none of them, which is the one
// direction this file exists to exclude.

import {
  BILLING_MODES,
  PROVIDER_ACCOUNT_HEALTH_STATES,
  PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
  PROVIDER_READINESS_STATES,
} from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../../bridge/scenarios/settings.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { ProviderAccountsPage, registerProviderAccountsPage } from "./ProviderAccountsPage.js";
import { PROVIDER_ACCOUNTS_PAGE_SLOT } from "./provider-accounts-slot.js";
import {
  pageChromeRegions,
  pageChromeText,
  settingsPageContextWith,
} from "../../settings-page-mount.test-support.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";

/**
 * The page as a window mounts it: inside the bridge provider, over the fixture.
 *
 * A real bridge rather than a cast placeholder, because the seat's body reads one —
 * the console's provider is what resolves the window's clock, and a page mounted
 * outside it throws there rather than rendering. Nothing here settles the body's read:
 * these cases are the frame's, and the body's own suite drives its arms.
 */
function renderPage(): HTMLElement {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <ProviderAccountsPage
          context={settingsPageContextWith(bridge, SETTINGS_SCENARIO.sessionId)}
        />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return container;
}

/** What the page itself says, with the seat's body left out. */
function chromeText(): string {
  return pageChromeText(renderPage());
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
    const rendered = chromeText();
    for (const term of terms) {
      expect(rendered).toContain(term);
    }
  });

  it("negative control: it does not render a term the contract never declared", () => {
    // Without this, the case above would pass over a page that rendered every
    // string it could think of — the vocabulary would then be prose rather than a
    // projection of the closed set, and would drift the moment one member moved.
    expect(chromeText()).not.toContain("suspended");
  });

  it("says where a quota reading came from, and which one stands", () => {
    const text = chromeText();
    expect(text).toContain("Where a quota reading came from");
    expect(text).toContain("probe");
    expect(text).toContain("newest observation is the one that stands");
  });

  it("names the one write-only wire member rather than a field name of its own", () => {
    const text = chromeText();
    expect(PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS.length).toBeGreaterThan(0);
    for (const member of PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS) {
      expect(text).toContain(member);
    }
  });
});

describe("the accounts page — what it must not do", () => {
  it("asks for nothing and offers no control it has no verb for", () => {
    // The frame explains the registry and asks for none of it. Every control on this
    // page belongs to the body below the seat, which is where the verbs are — a
    // control on the frame would be one with nothing behind it.
    const controls = pageChromeRegions(renderPage()).flatMap((region) => [
      ...region.querySelectorAll("input, select, textarea, button"),
    ]);
    expect(controls).toHaveLength(0);
  });

  it("composes no remedy of its own", () => {
    // The action that closes a readiness state carries a credential-home path and a
    // first-party command only the node holding them can name, so this page says
    // the daemon composes it and states none itself.
    const text = chromeText();
    expect(text).toContain("composed by the daemon");
    expect(text).not.toMatch(/\bchoose_default\b|\bsign_in\b/u);
  });

  it("names no governance work anywhere a person reads", () => {
    const text = renderPage().textContent ?? "";
    expect(text).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
    expect(text).not.toContain(PROVIDER_ACCOUNTS_PAGE_SLOT.contract.owningTask);
    expect(text).not.toContain(PROVIDER_ACCOUNTS_PAGE_SLOT.contract.deleteShellIn);
  });

  it("negative control: the page does render text that could have carried it", () => {
    // Without the length check, the case above would pass over a page that rendered
    // nothing at all — which is the failure it is written to exclude.
    expect(chromeText().length).toBeGreaterThan(400);
  });
});

describe("the accounts page — the seat it mounts", () => {
  it("draws the body the seat carries rather than the reservation", () => {
    // The reservation arm is `renderOwnerSlotPage`'s and is covered where that
    // function is. What is asserted here is the branch this seat is on — a body
    // stands, so the reservation copy is absent and the registry read's own first
    // frame is drawn.
    const text = renderPage().textContent ?? "";
    expect(text).toContain("account registry");
    expect(text).not.toContain("has not been built here yet");
  });

  it("answers all three of the questions a seat exists to answer", () => {
    const { contract } = PROVIDER_ACCOUNTS_PAGE_SLOT;
    expect(contract.owningTask.length).toBeGreaterThan(0);
    expect(contract.mountObligation.length).toBeGreaterThan(0);
    // The one that names its own retirement, and it names the directory rather than a
    // date: the body's arrival is what deletes the stand-in.
    expect(contract.deleteShellIn).toContain("provider-accounts/shell/");
  });

  it("carries the stand-in body under the fixture define and nothing without it", () => {
    // This tier compiles `__SIDEKICKS_CONSOLE_FIXTURES__` as `true`, so the seat here
    // holds the shell; a release renderer folds the same expression to `undefined` and
    // the subtree leaves the bundle. Stated as the define's own consequence rather
    // than as a bare `toBeDefined`, so the claim survives being read in either tier.
    expect(PROVIDER_ACCOUNTS_PAGE_SLOT.body !== undefined).toBe(__SIDEKICKS_CONSOLE_FIXTURES__);
  });

  it("claims the accounts section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerProviderAccountsPage(registry);
    const descriptor = registry.descriptorFor("accounts");
    expect(descriptor?.label).toBe("Provider accounts");
    expect(descriptor?.keywords).toContain("sign in");
  });
});
