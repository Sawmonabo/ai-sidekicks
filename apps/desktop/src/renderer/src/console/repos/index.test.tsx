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
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { REPOS_SCENARIO } from "../bridge/scenarios/repos.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SessionStore } from "../store/index.js";
import {
  ConsolePaneRegistry,
  isDetachablePaneKind,
  sidebarSectionRegistry,
  type ConsolePaneContext,
  type SidebarSectionContext,
} from "../seats/index.js";
import { registerRepos, registerReposPanes } from "./index.js";

/** The kinds this family owns, in `PANE_KINDS` declaration order — which is what the registry answers in. */
const REPOS_PANE_KINDS = ["diff", "artifact"] as const;

/**
 * The accessible name each pane's own region carries — its kind's noun.
 *
 * Named rather than positional because a pane may MOUNT further regions inside itself:
 * the artifact pane composes the artifacts panel, which is a labelled region of its
 * own, so a bare role query finds two and fails for a reason unrelated to the claim.
 */
const PANE_REGION_NAME_BY_KIND: Readonly<Record<(typeof REPOS_PANE_KINDS)[number], string>> = {
  diff: "Diff",
  artifact: "Artifact",
};

/**
 * A section context with real collaborators.
 *
 * The section READS now — it holds the `repo.workspaceList` / `repo.mountRead` pair
 * the mount cards are drawn from — so a context whose `bridge` and `sessionStore`
 * were never reached would have this file asserting against a body that throws on
 * its first hook. The fixture bridge and a bare store are the cheapest honest
 * collaborators: both are the real classes, and the scenario is the family's own.
 */
function sectionContext(isOpen: boolean): SidebarSectionContext {
  return {
    isOpen,
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
    openPane: () => undefined,
  } as unknown as SidebarSectionContext;
}

/**
 * The subject each kind's pane is opened over.
 *
 * Both addresses REQUIRE one — `seats/pane-address.ts` narrows the entity with the
 * kind — so this table is what lets one loop mount both bodies without either arm
 * being handed a reference the other's body would read out of the wrong partition.
 */
const PANE_SUBJECT_BY_KIND: Readonly<
  Record<(typeof REPOS_PANE_KINDS)[number], { readonly kind: string; readonly id: string }>
> = {
  diff: { kind: "workspace", id: "workspace-sidekicks" },
  artifact: { kind: "artifact", id: "artifact-diff-01" },
};

/** A pane context whose collaborators are never reached. */
function paneContext(kind: (typeof REPOS_PANE_KINDS)[number]): ConsolePaneContext {
  return {
    kind,
    entity: PANE_SUBJECT_BY_KIND[kind],
    paneId: `pane-${kind}`,
  } as unknown as ConsolePaneContext;
}

afterEach(() => {
  // The sidebar registry is process-wide, so a case that claimed the section has
  // to give it back — otherwise the negative control below reads a claim some
  // earlier case left behind and passes for the wrong reason.
  sidebarSectionRegistry.unregister("repos");
});

describe("repos family — the sidebar section", () => {
  it("claims the repos section under the family's own owner", () => {
    registerRepos();
    expect(sidebarSectionRegistry.descriptorFor("repos")?.owner).toBe("repos");
    expect(sidebarSectionRegistry.registeredSectionIds()).toContain("repos");
  });

  it("negative control: nothing claims the section before the door is called", () => {
    // Without this the case above would pass against a registry that had been
    // holding the descriptor since module evaluation, and would keep passing if
    // `registerRepos` stopped registering anything at all.
    expect(sidebarSectionRegistry.descriptorFor("repos")).toBeUndefined();
  });

  it("survives being registered twice, as a hot reload does it", () => {
    // Owner-scoped: the same owner re-claiming replaces. A family that changed its
    // owner string between registrations would raise here, which is correct — the
    // owner is what the policy is about.
    expect(() => {
      registerRepos();
      registerRepos();
    }).not.toThrow();
  });

  it("renders its body through the descriptor, collapsed and open", () => {
    registerRepos();
    const descriptor = sidebarSectionRegistry.descriptorFor("repos");
    expect(descriptor).toBeDefined();
    const open = render(<>{descriptor?.render(sectionContext(true))}</>);
    expect(open.container.querySelector(".meridian-repo-section__mounts")).not.toBeNull();
    const collapsed = render(<>{descriptor?.render(sectionContext(false))}</>);
    expect(collapsed.container.querySelector(".meridian-repo-section__summary")).not.toBeNull();
    // The two are different shapes, which is the whole reason `isOpen` is on the
    // context: a collapsed section that rendered the open body would be the
    // sidebar's one-section-open rule quietly not applying to this one.
    expect(collapsed.container.querySelector(".meridian-repo-section__mounts")).toBeNull();
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
          {descriptor?.render(paneContext(kind))}
        </LiveAnnouncerProvider>,
      );
      expect(
        within(container).getByRole("region", { name: PANE_REGION_NAME_BY_KIND[kind] }),
      ).toBeDefined();
    }
  });
});
