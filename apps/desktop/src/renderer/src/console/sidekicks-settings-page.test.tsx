// The sidekicks registration: the rail reaches the agents family's page.
//
// The claim under test is a SEAM, not a body — the page's own contents are asserted
// beside the page, in the agents family. What can only be checked here is that the
// section is claimed, that a person's words find it, that the thing rendered is the
// real page rather than a stand-in this file drew, and — since the body grew a
// required prop — that this registration actually hands it the bridge it reads
// through.
//
// THE BODY IS RESOLVED THROUGH THE FAMILY'S OWN MOUNT SCAFFOLDING, never by a sequence
// written here. This registration is loader-backed — the page is a chunk of its own, which
// is what keeps it off every launch's initial graph — so a descriptor rendered straight
// after registration draws the reserved region and nothing else.
// `settings/settings-page-mount.test-support.tsx` owns both halves of that: the awaited
// mount, which preloads the registration's memoised loader and then moves the bridge's
// frozen clock, and the reserved mount, which renders the same registration before its
// chunk lands. `test/console/surfaces/pane-body-resolution.ts` states the same rule for the
// two boards in `seats/`, and the reason a wait must not be a wider settle is there — a
// dynamic import needs more than the one macrotask a render settle crosses, so a case that
// settled twice and passed would be a case that raced.

import { describe, expect, it } from "vitest";

import { registerSidekicksPage } from "./sidekicks-settings-page.js";
import {
  SettingsPageRegistry,
  matchSettingsEntries,
  type SettingsPageContext,
} from "./settings/settings-page-registry.js";
import { SETTINGS_SECTION_IDS } from "./settings/settings-sections.js";
import { createFixtureBridge } from "./bridge/index.js";
import {
  mountRegisteredSettingsPage,
  mountReservedSettingsPage,
  settingsPageContextWith,
} from "./settings/settings-page-mount.test-support.js";
// The pending marker's reader by its own leaf specifier, on `RouteSurface.test.tsx`'s
// reason: the seats door publishes the ATTRIBUTE, which a producer needs, and not this
// reader, whose consumers outside that directory are tests.
import { pendingPaneBodiesIn } from "./seats/pane/pending-pane-body.js";

/**
 * A real context, because the body now reads through the bridge on it.
 *
 * The fixture bridge rather than a stub object: what this file checks is that the
 * seam hands the page a working bridge, and a cast placeholder would compile past
 * exactly the wiring mistake — a `render` that passed no bridge at all — that this
 * page's first prop makes possible. Built by the family's own context builder, so a
 * member added to `SettingsPageContext` is one compile error in one file.
 *
 * A FRESH ONE PER CASE, for the reason the memory-backed store beneath it has: the
 * store's health ledger counts for its own lifetime, so two cases sharing one context
 * would read each other's refusals.
 */
function sidekicksPageContext(): SettingsPageContext {
  return settingsPageContextWith(
    createFixtureBridge({
      scenario: {
        id: "settings-sidekicks-test",
        label: "Sidekicks registration",
        purpose:
          "Drives the sidekicks settings registration against a bridge that scripts nothing.",
        sessionId: "session-settings",
        userIdsInJoinOrder: [],
        beats: [],
        replies: [],
        startedAtIso: "2026-01-01T10:05:00.000Z",
      },
    }),
    undefined,
  );
}

function registeredRegistry(): SettingsPageRegistry {
  const registry = new SettingsPageRegistry();
  registerSidekicksPage(registry);
  return registry;
}

describe("the sidekicks settings page", () => {
  it("claims a section the rail actually renders", () => {
    // Both halves matter: a descriptor under an id outside the tuple would register
    // and never appear, and an id in the tuple with no descriptor is a blank pane.
    expect(SETTINGS_SECTION_IDS).toContain("sidekicks");
    expect(registeredRegistry().registeredSections()).toStrictEqual(["sidekicks"]);
  });

  it("renders the agents family's page and not a local stand-in", async () => {
    // The page's own heading and its first standing fact, which only the real body
    // carries. A shell drawn here would pass an "it rendered something" assertion.
    const container = await mountRegisteredSettingsPage(
      "sidekicks",
      registerSidekicksPage,
      sidekicksPageContext(),
    );
    expect(container.querySelector(".meridian-sidekicks__title")?.textContent).toBe("Sidekicks");
    expect(container.textContent ?? "").toContain("Where they live");
  });

  it("reserves the region rather than the page while its chunk is still arriving", () => {
    // The other side of the loader form, and the negative control for the wait above: an
    // unpreloaded descriptor draws the reservation, so the case above is asserting on a
    // body that landed rather than on one that was there all along. It is also the frame a
    // person sees, and it must carry the pending marker — the screenshot tier refuses to
    // photograph a tree holding one, and a settings page mid-load is exactly what that
    // refusal exists for.
    const container = mountReservedSettingsPage(
      "sidekicks",
      registerSidekicksPage,
      sidekicksPageContext(),
    );
    expect(container.querySelector(".meridian-sidekicks__title")).toBeNull();
    expect(pendingPaneBodiesIn(container).length).toBe(1);
  });

  it("hands the page the bridge it reads through", async () => {
    // The seam's whole job now. A registration that composed the element with no
    // props would fail to compile, but one that passed a DIFFERENT bridge would
    // not — so the check is that the page's read reached a bridge and was ANSWERED,
    // which only the context's own bridge can do.
    //
    // The SETTLED arm rather than the unread one, which is what the shared mount
    // changed and what makes this stronger: the mount moves the bridge's frozen clock,
    // so a page that never asked and a page whose answer never arrived both stay in
    // `not-loaded` and fail here, where before only the first of them did.
    const container = await mountRegisteredSettingsPage(
      "sidekicks",
      registerSidekicksPage,
      sidekicksPageContext(),
    );
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("is found by the words a person types for it", () => {
    const entries = registeredRegistry().entries();
    for (const query of ["sidekick", "definitions", "presets", "tools"]) {
      expect(
        matchSettingsEntries(entries, query).map((match) => match.descriptor.section),
      ).toStrictEqual(["sidekicks"]);
    }
  });

  it("negative control: the search does not answer with it for unrelated words", () => {
    // Without this, a matcher that answered every entry for every query would pass
    // the case above and tell a person nothing.
    expect(matchSettingsEntries(registeredRegistry().entries(), "zzzz")).toStrictEqual([]);
  });

  it("negative control: a second owner claiming the section is an error", () => {
    // Two lanes on one section is a conflict rather than a swap decided by import
    // order, and this registration is the newest claimant on the newest id.
    const registry = registeredRegistry();
    expect(() => {
      registry.register({
        section: "sidekicks",
        owner: "some-other-lane",
        label: "Sidekicks",
        keywords: [],
        render: () => null,
      });
    }).toThrow();
  });
});
