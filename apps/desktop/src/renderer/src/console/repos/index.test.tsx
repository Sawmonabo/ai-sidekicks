// What the repos family claims, and where.
//
// The family reaches the screen through two registries keyed by two closed sets —
// the sidebar's section ids and the deck's pane kinds — and it claims into both
// from one door. Neither claim is observable from a rendered console until three
// other families have landed, which makes this the file that says whether the door
// works at all.
//
// The cases drive the REGISTRIES rather than the components: a descriptor that was
// built and never registered renders identically to one that was never built, and
// it is the registration that the seat boards depend on.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { REPOS_SCENARIO } from "../bridge/scenarios/repos.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SessionStore } from "../store/index.js";
import {
  ConsolePaneRegistry,
  InlineCardSeatRegistry,
  SidebarSectionRegistry,
  inlineCardSeatRegistry,
  isDetachablePaneKind,
  sidebarSectionRegistry,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type SidebarSectionContext,
} from "../seats/index.js";
import { paneContext, sectionContext } from "./pane-contexts.test-support.js";
import * as reposDoorModule from "./index.js";
import { registerRepos, registerReposPanes } from "./index.js";

/** The kinds this family owns, in `PANE_KINDS` declaration order — which is what the registry answers in. */
const REPOS_PANE_KINDS = ["diff", "artifact"] as const;

/**
 * How each pane's own region is named — the trail's last crumb, which is its kind.
 *
 * A PATTERN AND NOT THE WHOLE NAME, because `seats/ConsolePaneChrome` names a pane by
 * its address trail: the region below is called "session-… workspace-… Diff", and the
 * kind is the crumb the trail is on. Anchoring at the end is what makes this a claim
 * about the body reaching the chrome rather than a transcription of the fixture's ids.
 *
 * Named rather than positional because a pane may MOUNT further regions inside itself:
 * the artifact pane composes the artifacts panel, which is a labelled region of its
 * own, so a bare role query finds two and fails for a reason unrelated to the claim.
 */
const PANE_REGION_NAME_BY_KIND: Readonly<Record<(typeof REPOS_PANE_KINDS)[number], RegExp>> = {
  diff: /Diff$/u,
  artifact: /Artifact$/u,
};

/**
 * This file's section context: the family's own scenario, on the shared builder.
 *
 * The fixture bridge and a bare store are the cheapest honest collaborators — both
 * are the real classes — and the section READS, holding the `repo.workspaceList` /
 * `repo.mountRead` pair the mount cards are drawn from.
 */
function contextForSection(isOpen: boolean): SidebarSectionContext {
  return sectionContext({
    isOpen,
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
  });
}

/**
 * The address each kind's pane is opened at.
 *
 * Both REQUIRE a subject — `seats/pane-address.ts` narrows the entity with the kind
 * — so this table is what lets one loop mount both bodies without either arm being
 * handed a reference the other's body would read out of the wrong partition. Typed
 * as the seat's own union, so a wrong pairing fails here rather than at the mount.
 */
const PANE_ADDRESS_BY_KIND: {
  readonly [Kind in (typeof REPOS_PANE_KINDS)[number]]: Extract<
    ConsolePaneAddress,
    { readonly kind: Kind }
  >;
} = {
  diff: { kind: "diff", entity: { kind: "workspace", id: "workspace-sidekicks" } },
  artifact: { kind: "artifact", entity: { kind: "artifact", id: "artifact-diff-01" } },
};

/**
 * This file's pane context, on `contextForSection`'s reason.
 *
 * THE BRIDGE IS REACHED, and this context used to supply none. The artifact pane
 * resolves the window's clock off it — `consoleClockFor(bridge)`, so a pane under
 * the fixture schedules on the scenario's frozen time rather than on wall time —
 * which made an absent bridge a throw on the pane's first hook.
 */
function contextForPane(kind: (typeof REPOS_PANE_KINDS)[number]): ConsolePaneContext {
  return paneContext({
    address: PANE_ADDRESS_BY_KIND[kind],
    paneId: `pane-${kind}`,
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
  });
}

/**
 * Compose this family against boards the CASE owns.
 *
 * There is no teardown here and there is nothing to tear down: the door writes only
 * into what it is handed, so a case's claims die with its boards. That is the whole
 * point of the boards being parameters — the previous shape claimed into a
 * process-wide registry and needed an `afterEach` releasing both sections by hand,
 * where forgetting one left the next negative control asserting against a registry
 * it never emptied.
 */
function composeRepos(): {
  readonly sections: SidebarSectionRegistry;
  readonly cards: InlineCardSeatRegistry;
} {
  const sections = new SidebarSectionRegistry();
  const cards = new InlineCardSeatRegistry();
  registerRepos(sections, cards);
  return { sections, cards };
}

describe("repos family — the sidebar section", () => {
  it("claims the repos section under the family's own owner", () => {
    const { sections } = composeRepos();
    expect(sections.descriptorFor("repos")?.owner).toBe("repos");
    expect(sections.registeredSectionIds()).toContain("repos");
  });

  it("negative control: an uncomposed board holds no section", () => {
    // Without this the case above would pass against a board that had been holding
    // the descriptor since module evaluation, and would keep passing if
    // `registerRepos` stopped registering anything at all.
    expect(new SidebarSectionRegistry().descriptorFor("repos")).toBeUndefined();
  });

  it("survives being registered twice, as a hot reload does it", () => {
    // Owner-scoped: the same owner re-claiming replaces. A family that changed its
    // owner string between registrations would raise here, which is correct — the
    // owner is what the policy is about. Both passes write the same board, because
    // a hot reload re-runs the door against the composition already standing.
    const sections = new SidebarSectionRegistry();
    const cards = new InlineCardSeatRegistry();
    expect(() => {
      registerRepos(sections, cards);
      registerRepos(sections, cards);
    }).not.toThrow();
  });

  it("renders its body through the descriptor, collapsed and open", () => {
    const { sections } = composeRepos();
    const descriptor = sections.descriptorFor("repos");
    expect(descriptor).toBeDefined();
    const open = render(<>{descriptor?.render(contextForSection(true))}</>);
    expect(open.container.querySelector(".meridian-repo-section__mounts")).not.toBeNull();
    const collapsed = render(<>{descriptor?.render(contextForSection(false))}</>);
    expect(collapsed.container.querySelector(".meridian-repo-section__summary")).not.toBeNull();
    // The two are different shapes, which is the whole reason `isOpen` is on the
    // context: a collapsed section that rendered the open body would be the
    // sidebar's one-section-open rule quietly not applying to this one.
    expect(collapsed.container.querySelector(".meridian-repo-section__mounts")).toBeNull();
  });
});

describe("repos family — the artifacts section", () => {
  it("claims the artifacts section under the same owner", () => {
    // `seats/sidebar-sections.ts` names both sections as this family's, and this is
    // the second: the attachment carrier, which is the ingest trio's only production
    // entry point. A door that registered one of the two would leave the Init /
    // Chunk / Complete flow reachable from tests and from nothing else.
    const { sections } = composeRepos();
    expect(sections.descriptorFor("artifacts")?.owner).toBe("repos");
    expect(sections.registeredSectionIds()).toContain("artifacts");
  });

  it("negative control: an uncomposed board holds no artifacts section", () => {
    expect(new SidebarSectionRegistry().descriptorFor("artifacts")).toBeUndefined();
  });

  it("renders the picker its body offers, open and not collapsed", () => {
    const { sections } = composeRepos();
    const descriptor = sections.descriptorFor("artifacts");
    expect(descriptor).toBeDefined();
    const open = render(<>{descriptor?.render(contextForSection(true))}</>);
    expect(within(open.container).getByLabelText("Attach a file")).toBeDefined();
    const collapsed = render(<>{descriptor?.render(contextForSection(false))}</>);
    expect(within(collapsed.container).queryByLabelText("Attach a file")).toBeNull();
  });
});

describe("repos family — the boards it is handed, and only those", () => {
  // The claim this whole seam exists for, and the one a behavioural check over the
  // caller's own board cannot make: composing the family must leave the process-wide
  // boards untouched. Without it a door that wrote BOTH the handed board and the
  // singleton would pass every case above, and the defect would surface only when a
  // second composition — an auxiliary window selecting a subset, a suite composing
  // one family alone — silently mutated the running console.

  it("writes the sidebar board it is given and never the process-wide one", () => {
    const { sections } = composeRepos();
    expect(sections.registeredSectionIds()).toStrictEqual(["repos", "artifacts"]);
    expect(sidebarSectionRegistry.registeredSectionIds()).toStrictEqual([]);
  });

  it("writes the card board it is given and never the process-wide one", () => {
    const { cards } = composeRepos();
    // All three kinds, because every card the ledger row declares is this family's:
    // a door that filled the handed board partially would leave the rest reserved.
    expect(cards.registeredCardKinds()).toStrictEqual(["diff", "attachment", "artifact"]);
    expect(inlineCardSeatRegistry.registeredCardKinds()).toStrictEqual([]);
  });

  it("keeps two compositions apart", () => {
    // The property the singleton could never have. Registering into one composition
    // must be invisible to another, which is what lets an auxiliary window compose a
    // subset without the main window seeing it.
    const first = composeRepos();
    const second = new SidebarSectionRegistry();
    expect(first.sections.registeredSectionIds()).toStrictEqual(["repos", "artifacts"]);
    expect(second.registeredSectionIds()).toStrictEqual([]);
  });
});

describe("repos family — the deck's pane kinds", () => {
  it("claims diff and artifact, in declaration order", () => {
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

  it("leaves the tear-off question to the kind, claiming nothing about it", () => {
    // The descriptor carries no detach member at all: `isDetachablePaneKind` is the
    // single answer, derived from the window model's route set, and neither of this
    // family's kinds is in it. Both halves are asserted — the registration says
    // nothing, and the predicate says no — because a registrar that started
    // smuggling a claim back in would still leave the predicate answering correctly.
    const registry = new ConsolePaneRegistry();
    registerReposPanes(registry);
    for (const kind of REPOS_PANE_KINDS) {
      expect(registry.descriptorFor(kind)).not.toHaveProperty("openInWindow");
      expect(isDetachablePaneKind(kind)).toBe(false);
    }
  });

  it("negative control: the predicate does name the two kinds a window model has", () => {
    // Without this the case above would pass over an `isDetachablePaneKind` that
    // answered `false` for everything, which would say nothing about this family.
    expect(isDetachablePaneKind("timeline")).toBe(true);
    expect(isDetachablePaneKind("agent-console")).toBe(true);
  });

  it("mounts a named region for each kind", () => {
    const registry = new ConsolePaneRegistry();
    registerReposPanes(registry);
    for (const kind of REPOS_PANE_KINDS) {
      const descriptor = registry.descriptorFor(kind);
      expect(descriptor?.owner).toBe("repos");
      // Scoped to this iteration's own container: both panes stay mounted for the
      // length of the case, so a document-wide query finds two regions on the
      // second pass and fails for a reason that has nothing to do with the claim.
      //
      // The announcer is the environment the frame supplies in production, and a
      // pane that announces its acts calls `useAnnounce`, which throws outside the
      // provider on purpose. Mounting a pane body bare would therefore fail on the
      // announcer rather than on the region this case is about. The clock is frozen
      // so nothing this mount announces clears on a timer mid-case.
      const { container } = render(
        <LiveAnnouncerProvider clock={new ManualClock()}>
          {descriptor?.render(contextForPane(kind))}
        </LiveAnnouncerProvider>,
      );
      const region = within(container).getByRole("region", {
        name: PANE_REGION_NAME_BY_KIND[kind],
      });
      // And the trail really is a trail: the subject the descriptor was handed is in
      // the name, so a body that stopped passing its address to the chrome fails here
      // rather than passing on the kind noun alone.
      expect(region.textContent).toContain(PANE_ADDRESS_BY_KIND[kind].entity.id);
    }
  });
});

describe("repos door — the bodies a sibling family mounts", () => {
  it("publishes the file-restore disclosure through the door", () => {
    // The disclosure renders the rollback intervention's own result and is mounted by
    // the runs pane, a sibling view family: the layering gate forbids either family
    // from importing the other's modules, so the door is the only way across. Read
    // through the barrel rather than through the declaring module, because a symbol
    // reachable only by a deep specifier is one the mounting family may not reach.
    expect(typeof reposDoorModule.FileRestoreDisclosure).toBe("function");
  });

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
    expect(doorExports).not.toContain("ProposalGate");
  });
});
