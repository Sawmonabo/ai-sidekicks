// What the repos family claims, and where.
//
// The family reaches the screen through two registries: the deck's pane kinds and the
// ledger's inline card seats. The cases drive the REGISTRIES rather than the components:
// a descriptor that was built and never registered renders identically to one that was
// never built, and it is the registration that the seat boards depend on.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import {
  ConsolePaneRegistry,
  InlineCardSeatRegistry,
  inlineCardSeatRegistry,
  type ConsolePaneContext,
} from "../seats/index.js";
import { paneContext } from "./pane-contexts.test-support.js";
import * as reposDoorModule from "./index.js";
import { registerRepos, registerReposPanes } from "./index.js";

/** The kinds this family owns. */
const REPOS_PANE_KINDS = ["diff"] as const;

/**
 * This file's pane context.
 *
 * The diff pane reads only its address, so no bridge or store is supplied.
 */
function contextForPane(): ConsolePaneContext {
  return paneContext({
    address: { kind: "diff", entity: { kind: "workspace", id: "workspace-sidekicks" } },
    paneId: "pane-diff",
  });
}

describe("repos family — the inline cards", () => {
  it("writes the card board it is given and never the process-wide one", () => {
    const cards = new InlineCardSeatRegistry();
    registerRepos(cards);
    // All three kinds, because every card the ledger row declares is this family's:
    // a door that filled the handed board partially would leave the rest reserved.
    expect(cards.registeredCardKinds()).toStrictEqual(["diff", "attachment", "artifact"]);
    expect(inlineCardSeatRegistry.registeredCardKinds()).toStrictEqual([]);
  });

  it("survives being registered twice, as a hot reload does it", () => {
    // Owner-scoped: the same owner re-claiming replaces. A family that changed its
    // owner string between registrations would raise here, which is correct — the
    // owner is what the policy is about.
    const cards = new InlineCardSeatRegistry();
    expect(() => {
      registerRepos(cards);
      registerRepos(cards);
    }).not.toThrow();
  });

  it("keeps two compositions apart", () => {
    // The property the singleton could never have. Registering into one composition
    // must be invisible to another, which is what lets an auxiliary window compose a
    // subset without the main window seeing it.
    const first = new InlineCardSeatRegistry();
    const second = new InlineCardSeatRegistry();
    registerRepos(first);
    expect(first.registeredCardKinds()).toHaveLength(3);
    expect(second.registeredCardKinds()).toStrictEqual([]);
  });
});

describe("repos family — the deck's pane kinds", () => {
  it("claims the diff pane", () => {
    const registry = new ConsolePaneRegistry();
    registerReposPanes(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual([...REPOS_PANE_KINDS]);
  });

  it("negative control: a registry the door was not given claims nothing", () => {
    // The door takes a registry rather than reaching for the module-scope
    // singleton. A registrar that reached for the singleton would leave this one
    // empty while still appearing to work in the case above.
    const claimed = new ConsolePaneRegistry();
    const untouched = new ConsolePaneRegistry();
    registerReposPanes(claimed);
    expect(untouched.registeredPaneKinds()).toStrictEqual([]);
  });

  it("mounts a named region for the diff pane", () => {
    const registry = new ConsolePaneRegistry();
    registerReposPanes(registry);
    const descriptor = registry.descriptorFor("diff");
    expect(descriptor?.owner).toBe("repos");
    // The announcer is the environment the frame supplies in production, and a pane
    // that announces its acts calls `useAnnounce`, which throws outside the provider on
    // purpose. The clock is frozen so nothing this mount announces clears on a timer
    // mid-case.
    const { container } = render(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        {descriptor?.render(contextForPane())}
      </LiveAnnouncerProvider>,
    );
    // The name is a pattern and not the whole name, because `seats/ConsolePaneChrome`
    // names a pane by its address trail and the kind is the crumb the trail ends on.
    const region = within(container).getByRole("region", { name: /Diff$/u });
    // And the trail really is a trail: the subject the descriptor was handed is in the
    // name, so a body that stopped passing its address to the chrome fails here rather
    // than passing on the kind noun alone.
    expect(region.textContent).toContain("workspace-sidekicks");
  });
});

describe("repos door — the bodies a sibling family mounts", () => {
  it("publishes the attachment carrier through the door", () => {
    // The composer's attachment affordance is a sibling view family, so the door is
    // the only way across — and it publishes the BINDING rather than the raw ingest
    // client, so a second carrier over one session cannot be constructed by hand.
    expect(typeof reposDoorModule.useAttachmentCarrier).toBe("function");
  });

  it("negative control: the door publishes no body the family does not own", () => {
    // Without this the case above would pass over a barrel that re-exported the whole
    // family, which is what the one-door rule exists to prevent.
    const doorExports = Object.keys(reposDoorModule);
    expect(doorExports).not.toContain("RestorePathList");
    expect(doorExports).not.toContain("AttachmentCard");
  });
});
