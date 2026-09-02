// The repos family's surfaces, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier both need the same four surfaces this family ships, and a
// per-tier copy of the mount would be two chances to compose them differently and
// then read the results as if they were comparable. That is `console-harness.tsx`'s
// own reason for existing, one level down: the harness owns HOW the console is
// mounted, and this module owns WHAT of this family is mounted into it.
//
// THE BODIES COME OUT OF THE REGISTRIES WHERE THE REGISTRIES HOLD THEM. The family
// claims into two — the sidebar's section ids and the deck's pane kinds — and both
// the section and the artifact pane are resolved through their registry after
// `registerRepos` / `registerReposPanes` run, so a tier renders the body a console
// would mount rather than a component that happens to sit beside it.
//
// TWO SURFACES ARE MOUNTED DIRECTLY, AND EACH FOR A STATED REASON.
//
//   • The DIFF PANE takes its model as a prop and no wire produces one
//     (`gitflow.diffArtifactCreate` is a `Plan-023 §Console growth slate` row), so
//     the deck's own body renders the `not-checked` absence — which is the emptiest
//     frame the surface has and would pin a baseline of a box. The pane is mounted
//     with the parsed fixture instead, which is the composition `DiffPane.tsx` draws:
//     the attribution badge, the compared states, the file list, and the rows. The
//     absence arm is not unpinned by that — `DiffPane.test.tsx` owns it, where a
//     DOM assertion can say WHICH absence it is and an image cannot.
//   • The PROPOSAL GATE is a presentational body, and it is mounted TWICE for two
//     different claims. Directly, on the `prepared` arm with a proposal supplied, it
//     draws every part of the surface at once — the branch context, the proposal, its
//     changed paths, and the three offers — which is a composition no read produces
//     today, since no registered reply carries a title, a body, or a file list. And
//     through the SECTION, where the gate reaches the screen the way a person meets
//     it: collapsed under its own execution root, its line a reading, its arm
//     whatever the fixture actually served. The two are different subjects and both
//     are pinned, because the first would go on passing if the mount broke and the
//     second would go on passing if the surface emptied.
//
// THE SECTION IS DRAWN FROM THE SCENARIO, NOT FROM A HAND-BUILT READING.
// `REPOS_SCENARIO` states two mounts on purpose — a git checkout and a plain
// directory — and one of them answers `unreachable`, which is the degraded mount
// this tier exists to pin. Building that reading here would pin a state the fixture
// could stop producing without either tier noticing.

import { waitFor, within } from "@testing-library/react";

import { renderSettled } from "./console-harness.js";

import { REPOS_SCENARIO } from "../../src/renderer/src/console/bridge/scenarios/repos.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../src/renderer/src/console/bridge/index.js";
import {
  SMALL_DIFF_SHAPE,
  buildDiffFixture,
} from "../../src/renderer/src/console/panes/diff/diff-fixture.js";
import { DiffPane } from "../../src/renderer/src/console/panes/diff/index.js";
import {
  ManualClock,
  refuse,
  type ConsoleRefusal,
} from "../../src/renderer/src/console/core/index.js";
import { DraftStore, UiStateStore } from "../../src/renderer/src/console/persistence/index.js";
import { LiveAnnouncerProvider } from "../../src/renderer/src/console/primitives/index.js";
import { ProposalGate } from "../../src/renderer/src/console/repos/ProposalGate.js";
import { registerRepos, registerReposPanes } from "../../src/renderer/src/console/repos/index.js";
import type { BranchContextReading } from "../../src/renderer/src/console/repos/branch-context-model.js";
import type { ProposalAction } from "../../src/renderer/src/console/repos/proposal-actions.js";
import type { ProposalGateState } from "../../src/renderer/src/console/repos/proposal-gate-state.js";
import { FrameStore, SessionStore } from "../../src/renderer/src/console/store/index.js";
import {
  ConsolePaneRegistry,
  sidebarSectionRegistry,
  type ConsolePaneContext,
  type PaneKind,
  type SidebarSectionContext,
} from "../../src/renderer/src/console/workspace/index.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/** How long a surface's first read may take to settle before a tier gives up. */
const FAMILY_READ_TIMEOUT_MS = 5_000;

/**
 * A registry carrying exactly this family's two pane claims.
 *
 * Built per call rather than shared: the registry is owner-scoped state, and two
 * tiers holding one instance would make the second tier's mount depend on whether
 * the first had run.
 */
function familyPaneRegistry(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registerReposPanes(registry);
  return registry;
}

/**
 * The pane body the deck holds for a kind, as a component, or a throw.
 *
 * A throw rather than an optional return, so a family that stopped registering its
 * kind fails here — where the message names the kind — instead of rendering nothing
 * and letting a tier compare an empty box against a baseline.
 */
function paneBodyComponent(kind: PaneKind): (context: ConsolePaneContext) => React.ReactNode {
  const descriptor = familyPaneRegistry().descriptorFor(kind);
  if (descriptor === undefined) {
    throw new Error(`no console pane is registered for the \`${kind}\` kind`);
  }
  return descriptor.render;
}

/** The deck context a pane is mounted with, minus the parts each caller supplies. */
function paneContext(
  overrides: Pick<ConsolePaneContext, "kind" | "paneId" | "bridge" | "sessionStore">,
): ConsolePaneContext {
  return {
    entity: undefined,
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore(),
    focusHue: undefined,
    ...overrides,
  };
}

/** A bridge and a store both drawn from the repos scenario, which is the family's own. */
function scenarioCollaborators(): { bridge: ConsoleBridge; sessionStore: SessionStore } {
  return {
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
  };
}

/**
 * Find the one region a surface renders itself as, by the name it announces.
 *
 * By accessible name rather than by class, because that is what a person using
 * assistive technology navigates by — a surface that lost its accessible name would
 * still match a class selector and would still be captured as if nothing had
 * changed. `getByRole` rather than a selector for the same reason: it resolves the
 * name the way the accessibility tree does, through `aria-labelledby` and the
 * heading it points at.
 */
function requireLabelledRegion(container: HTMLElement, accessibleName: string): HTMLElement {
  return within(container).getByRole("region", { name: accessibleName });
}

/**
 * Find a surface that announces no name of its own, by the class it renders under.
 *
 * The sidebar section is the one such surface this family has, and deliberately: the
 * sidebar chrome owns the section's heading and its disclosure state, so a body that
 * announced a second name would put two regions in the tree for one section. The
 * selector is what is left, and a throw rather than a null keeps a tier from
 * comparing an empty box against a baseline.
 */
function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree matches \`${selector}\``);
  }
  return element;
}

/** Wait until a selector resolves inside a mounted surface, or say what did not. */
async function waitForWithin(region: HTMLElement, selector: string): Promise<void> {
  await waitFor(
    () => {
      if (region.querySelector(selector) === null) {
        throw new Error(`the surface has not rendered \`${selector}\` yet`);
      }
    },
    { timeout: FAMILY_READ_TIMEOUT_MS },
  );
}

/**
 * The repos sidebar section, open, with its two mounts read.
 *
 * Waited on rather than read straight after the mount: the section holds the
 * `repo.workspaceList` / `repo.mountRead` pair, so a tier that captured immediately
 * would pin the pre-read frame and then compare a later warm run against it.
 */
export async function mountRepoSection(): Promise<MountedFamilySurface> {
  registerRepos();
  const descriptor = sidebarSectionRegistry.descriptorFor("repos");
  if (descriptor === undefined) {
    throw new Error("the repos family registered no sidebar section");
  }
  const { bridge, sessionStore } = scenarioCollaborators();
  const context: SidebarSectionContext = {
    isOpen: true,
    bridge,
    sessionStore,
    openPane: () => undefined,
  };
  const { container } = await renderSettled(
    // The announcer is the section's environment: each root's gate announces its own
    // settlement, and `useAnnounce` throws outside the provider on purpose.
    //
    // ON FROZEN TIME, so the standing message never clears itself mid-capture. The
    // announcer's hold deadline is the one timer the primitive arms, and on a real
    // clock it lands a state update after the surface has settled — which a tier
    // records as whichever side of the clear the runner happened to reach.
    <LiveAnnouncerProvider clock={new ManualClock()}>
      {descriptor.render(context)}
    </LiveAnnouncerProvider>,
  );
  const region = requireElement(container, ".meridian-repo-section");
  await waitForWithin(region, ".meridian-mount-card");
  await waitForGatesSettled(region);
  return { element: region, bridge };
}

/**
 * Wait until every root's gate has finished its own read.
 *
 * The mount card lands on the section's read; each root's change-proposal gate then
 * performs a SECOND, independent read, so a tier that stopped at the card would
 * capture a frame with reads still in flight — and would land their state updates
 * outside `act`, which React reports as a warning and a baseline records as whichever
 * half of the transition the runner happened to reach.
 *
 * The settled condition is read off the collapsed line, which is the gate's own
 * summary of its arm. The two waited-on values are the pre-read ones; the fixture
 * serves this family's branch-context read, so a line still showing either after the
 * timeout is a fixture that stopped serving it — which is a failure worth having
 * rather than a frame worth pinning.
 */
async function waitForGatesSettled(region: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const unsettled = [...region.querySelectorAll(".meridian-worktree-gate__line")].filter(
        (line) => line.textContent === "reading" || line.textContent === "not checked",
      );
      if (unsettled.length > 0) {
        throw new Error(`${unsettled.length} change-proposal gate(s) have not settled yet`);
      }
    },
    { timeout: FAMILY_READ_TIMEOUT_MS },
  );
}

/**
 * The same section, with its first root's gate disclosed.
 *
 * A second subject rather than a flag on the first, because a collapsed gate and an
 * open one are two different claims: collapsed, the claim is that one honest line
 * reports what the read found; open, it is that the gate's own surface composes
 * inside a row it does not own. Waited on by the ROOT card and then by the gate, so
 * neither the mount read nor the branch-context read is captured half-settled.
 */
export async function mountRepoSectionWithOpenGate(): Promise<MountedFamilySurface> {
  const mounted = await mountRepoSection();
  await waitForWithin(mounted.element, ".meridian-worktree-gate");
  const disclosure = mounted.element.querySelector("details.meridian-worktree-gate");
  if (!(disclosure instanceof HTMLDetailsElement)) {
    throw new Error("the section mounted no change-proposal gate under its roots");
  }
  disclosure.open = true;
  await waitForWithin(mounted.element, ".meridian-proposal-gate__body");
  return mounted;
}

/** The diff pane over a parsed change set: attribution, compared states, rows. */
export async function mountDiffPane(): Promise<MountedFamilySurface> {
  const { bridge, sessionStore } = scenarioCollaborators();
  const DiffPaneBody = DiffPane;
  const { container } = await renderSettled(
    <DiffPaneBody
      context={paneContext({
        kind: "diff",
        paneId: "pane-diff-surface",
        bridge,
        sessionStore,
      })}
      diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
    />,
  );
  return { element: requireLabelledRegion(container, "Diff"), bridge };
}

/**
 * The artifact pane, with both of its reads settled.
 *
 * `artifactList` and `artifactAllowlistRead` are growth-slate rows the fixture does
 * not serve, so what this pins is the pane carrying the port's typed refusal beside
 * the shipped-default allow-list hint — which is the composition a person on this
 * build actually sees, and the one a mapped list would replace.
 *
 * WAITED ON TWICE, AND THE SECOND WAIT IS THE ONE THAT MATTERS. The panel's own root
 * is in the DOM from the first frame on every arm, so waiting for it alone would pin
 * whichever side of the read the runner happened to reach — and the pane's reads run
 * through the console's refresh scheduler, which coalesces before it calls. The
 * refusal card is what the settled arm renders, so that is what is waited for.
 *
 * The announcer is the pane's environment, on the section's rule and for its reason:
 * an act announces its own settlement, `useAnnounce` throws outside the provider on
 * purpose, and a frozen clock keeps a standing message from clearing mid-capture.
 */
export async function mountArtifactPane(): Promise<MountedFamilySurface> {
  const { bridge, sessionStore } = scenarioCollaborators();
  const ArtifactPaneBody = paneBodyComponent("artifact");
  const { container } = await renderSettled(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      {ArtifactPaneBody(
        paneContext({ kind: "artifact", paneId: "pane-artifact-surface", bridge, sessionStore }),
      )}
    </LiveAnnouncerProvider>,
  );
  const region = requireLabelledRegion(container, "Artifact");
  await waitForWithin(region, ".meridian-artifacts");
  await waitForWithin(region, ".meridian-refusal--card");
  return { element: region, bridge };
}

/** The branch context the gate is drawn against, on its richest arm. */
const PREPARED_BRANCH_CONTEXT: BranchContextReading = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  upstreamRef: "origin/sidekicks/abc123/rate-limit-wiring",
  executionMode: "worktree",
  worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
};

/** The gate's `prepared` arm, which is the one that draws every part of the surface. */
const PREPARED_GATE_STATE: ProposalGateState = {
  kind: "prepared",
  context: PREPARED_BRANCH_CONTEXT,
  detectedHost: "github",
  proposal: {
    title: "Wire the rate limiter",
    body: "Adds the concurrency cap to the subscribe path.",
    baseBranch: "develop",
    headBranch: "sidekicks/abc123/rate-limit-wiring",
    state: "draft",
    trailers: ["Co-Authored-By: a sidekick"],
    changedPaths: [
      "packages/control-plane/src/rate-limit.ts",
      "packages/control-plane/src/rate-limit.test.ts",
    ],
  },
};

/**
 * The refusal the gate draws beside a control that was pressed and did not take.
 *
 * On the REMOTE act, which is the one whose failure matters most to see: a push that
 * the daemon refused leaves the proposal intact and the offer standing, and the
 * sentence beside the control is the only thing that says the send did not happen.
 */
const PUSH_REFUSAL: ReadonlyMap<ProposalAction, ConsoleRefusal> = new Map([
  [
    "push" satisfies ProposalAction,
    refuse(
      "gitflow.gitActionExecute",
      "wire-unregistered",
      "Not checked — the git action is not registered yet.",
    ),
  ],
]);

/**
 * The proposal gate on a prepared proposal, with the three offers standing.
 *
 * THE HANDLERS ARE WHAT MAKE THE OFFERS EXIST. `ProposalActions` draws nothing at all
 * without `onRequestAction`, and the changed-path list draws its diff half only where
 * `onOpenChangedPath` is supplied — so a mount that passed only `state` pinned a
 * surface with no controls on it, and the accessibility tier walked a tree the
 * console's own gate never renders. The stubs record nothing because neither tier
 * reads a recording: what both look at is the drawn surface.
 *
 * The blocking-choice pair is deliberately NOT supplied. `checkoutConflict` disables
 * every act, which is a different composition with its own claim, and mounting it here
 * would pin the blocked surface under the name of the offered one.
 */
export async function mountProposalGate(): Promise<MountedFamilySurface> {
  const { bridge } = scenarioCollaborators();
  const { container } = await renderSettled(
    <ProposalGate
      state={PREPARED_GATE_STATE}
      onRequestAction={() => undefined}
      actionRefusals={PUSH_REFUSAL}
      onOpenChangedPath={() => undefined}
    />,
  );
  return { element: requireLabelledRegion(container, "Change proposal"), bridge };
}
