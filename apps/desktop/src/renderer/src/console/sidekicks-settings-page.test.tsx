// The sidekicks registration: the rail reaches the agents family's page.
//
// The claim under test is a SEAM, not a body — the page's own contents are asserted
// beside the page, in the agents family. What can only be checked here is that the
// section is claimed, that a person's words find it, that the thing rendered is the
// real page rather than a stand-in this file drew, and — since the body grew a
// required prop — that this registration actually hands it the bridge it reads
// through.
//
// THE BODY IS AWAITED THROUGH THE REGISTRY'S OWN LOADER, never by settling generously.
// This registration is loader-backed — the page is a chunk of its own, which is what
// keeps it off every launch's initial graph — so a descriptor rendered straight after
// registration draws the reserved region and nothing else. `preload` is the registration's
// memoised loader, so awaiting it is exact: `test/console/surfaces/pane-body-resolution.ts`
// states the same rule for the two boards in `seats/`, and the reason a wait must not be
// a wider settle is there — a dynamic import needs more than the one macrotask a render
// settle crosses, so a case that settled twice and passed would be a case that raced.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { registerSidekicksPage } from "./sidekicks-settings-page.js";
import {
  SettingsPageRegistry,
  matchSettingsEntries,
  type SettingsPageContext,
} from "./settings/settings-page-registry.js";
import { SETTINGS_SECTION_IDS } from "./settings/settings-sections.js";
import { createFixtureBridge } from "./bridge/index.js";
import { ManualClock } from "./core/index.js";
import { LiveAnnouncerProvider } from "./primitives/index.js";
// The pending marker's reader by its own leaf specifier, on `RouteSurface.test.tsx`'s
// reason: the seats door publishes the ATTRIBUTE, which a producer needs, and not this
// reader, whose consumers outside that directory are tests.
import { pendingPaneBodiesIn } from "./seats/pending-pane-body.js";

/**
 * A real context, because the body now reads through the bridge on it.
 *
 * The fixture bridge rather than a stub object: what this file checks is that the
 * seam hands the page a working bridge, and a cast placeholder would compile past
 * exactly the wiring mistake — a `render` that passed no bridge at all — that this
 * page's first prop makes possible.
 */
const CONTEXT: SettingsPageContext = {
  bridge: createFixtureBridge({
    scenario: {
      id: "settings-sidekicks-test",
      label: "Sidekicks registration",
      purpose: "Drives the sidekicks settings registration against a bridge that scripts nothing.",
      sessionId: "session-settings",
      participantIdsInJoinOrder: [],
      beats: [],
      replies: [],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  }),
  openSection: () => undefined,
  retainedSessionId: undefined,
  retainedSessionStore: undefined,
};

/** The page speaks its settlement, so it is mounted inside the console's announcer. */
function renderPage(body: React.ReactNode): { readonly container: HTMLElement } {
  return render(<LiveAnnouncerProvider clock={new ManualClock()}>{body}</LiveAnnouncerProvider>);
}

function registeredRegistry(): SettingsPageRegistry {
  const registry = new SettingsPageRegistry();
  registerSidekicksPage(registry);
  return registry;
}

/**
 * The registry with this page's chunk already resolved, for the cases that mount it.
 *
 * A scoped registry per case rather than one shared instance, for the registrar's own
 * reason: the table is owner-scoped state, so two cases sharing one would make the second
 * depend on whether the first had run.
 */
async function registryWithBodyLoaded(): Promise<SettingsPageRegistry> {
  const registry = registeredRegistry();
  await registry.preload("sidekicks");
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
    const descriptor = (await registryWithBodyLoaded()).descriptorFor("sidekicks");
    expect(descriptor).toBeDefined();
    const { container } = renderPage(<>{descriptor?.render(CONTEXT)}</>);
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
    const descriptor = registeredRegistry().descriptorFor("sidekicks");
    const { container } = renderPage(<>{descriptor?.render(CONTEXT)}</>);
    expect(container.querySelector(".meridian-sidekicks__title")).toBeNull();
    expect(pendingPaneBodiesIn(container).length).toBe(1);
  });

  it("hands the page the bridge it reads through", async () => {
    // The seam's whole job now. A registration that composed the element with no
    // props would fail to compile, but one that passed a DIFFERENT bridge would
    // not — so the check is that the page put a read in flight at all, which only
    // the context's own bridge can answer.
    const descriptor = (await registryWithBodyLoaded()).descriptorFor("sidekicks");
    const { container } = renderPage(<>{descriptor?.render(CONTEXT)}</>);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
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
