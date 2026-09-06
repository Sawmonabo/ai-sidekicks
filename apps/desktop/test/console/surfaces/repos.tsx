// The repos family's sidebar section, diff pane, and proposal gate, mounted once for
// the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier both need the same surfaces this family ships, and a per-tier copy
// of the mount would be two chances to compose them differently and then read the
// results as if they were comparable. Five modules divide that job: `console-harness.tsx`
// owns HOW the console is mounted, `repos-mount-harness.ts` owns what SETTLED means and
// how a tier waits for it, `repos-fixtures.ts` owns what the surfaces are drawn against,
// and the mounts themselves are split between this module and `repos-artifact.tsx` —
// which holds the artifact pane, the family's largest, so neither file has to be read to
// understand the other.
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
//     with `extendedHeaderChangeSet()` instead, which is the composition
//     `DiffPane.tsx` draws: the attribution badge, the compared states, the file
//     list, and the rows. The absence arm is not unpinned by that —
//     `DiffPane.test.tsx` owns it, where a DOM assertion can say WHICH absence it is
//     and an image cannot.
//   • The PROPOSAL GATE is a presentational body, and it is mounted TWICE for two
//     different claims. Directly, on the `prepared` arm with a READY proposal — the
//     one state that offers the remote act — it draws every part of the surface at
//     once: the branch context, the proposal, its changed paths, all three offers, and
//     the refusal standing beside the one that was pressed and did not take. That is a
//     composition no read produces today, since no registered reply carries a title, a
//     body, or a file list. And
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

import { renderSettled } from "../console-harness.js";
import {
  driveUntilWithin,
  requireElement,
  requireLabelledRegion,
  type MountedFamilySurface,
} from "./repos-mount-harness.js";

import {
  PREPARED_GATE_STATE,
  PUSH_REFUSAL,
  extendedHeaderChangeSet,
  paneBinding,
  scenarioCollaborators,
} from "./repos-fixtures.js";

import { REPOS_GIT_WORKSPACE_ID } from "../../../src/renderer/src/console/bridge/scenarios/repos.js";
import type { ConsoleBridge } from "../../../src/renderer/src/console/bridge/index.js";
// Deeply, and not through the sub-module door: the pane is loader-backed now, so the
// component is not on that barrel — a line for it there would put the whole pane back on
// the renderer's initial import graph, which is the edge the loader boundary removed.
import { DiffPane } from "../../../src/renderer/src/console/repos/diff-pane/DiffPane.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { ProposalGate } from "../../../src/renderer/src/console/repos/proposals/ProposalGate.js";
import { registerRepos } from "../../../src/renderer/src/console/repos/index.js";
import { advanceScenarioUntil } from "../../../src/renderer/src/console/repos/scenario-clock.test-support.js";
import { sectionContext } from "../../../src/renderer/src/console/repos/pane-contexts.test-support.js";
import {
  InlineCardSeatRegistry,
  SidebarSectionRegistry,
} from "../../../src/renderer/src/console/seats/index.js";

/**
 * The repos sidebar section, open, with its two mounts read.
 *
 * Waited on rather than read straight after the mount: the section holds the
 * `repo.workspaceList` / `repo.mountRead` pair, so a tier that captured immediately
 * would pin the pre-read frame and then compare a later warm run against it.
 */
export async function mountRepoSection(): Promise<MountedFamilySurface> {
  // Composed onto boards this surface owns, the way `console/families.ts` composes
  // onto the five it is handed. Reading the process-wide board instead would make the
  // capture depend on whether some other module had registered into it first.
  const sidebarSections = new SidebarSectionRegistry();
  registerRepos(sidebarSections, new InlineCardSeatRegistry());
  const descriptor = sidebarSections.descriptorFor("repos");
  if (descriptor === undefined) {
    throw new Error("the repos family registered no sidebar section");
  }
  const { bridge, sessionStore } = scenarioCollaborators();
  const context = sectionContext({ isOpen: true, bridge, sessionStore });
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
  await driveUntilWithin(bridge, region, ".meridian-mount-card");
  await waitForGatesSettled(bridge, region);
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
async function waitForGatesSettled(bridge: ConsoleBridge, region: HTMLElement): Promise<void> {
  await advanceScenarioUntil(bridge, () => {
    const unsettled = [...region.querySelectorAll(".meridian-root-gate__line")].filter(
      (line) => line.textContent === "reading" || line.textContent === "not checked",
    );
    if (unsettled.length > 0) {
      throw new Error(`${unsettled.length} change-proposal gate(s) have not settled yet`);
    }
  });
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
  await driveUntilWithin(mounted.bridge, mounted.element, ".meridian-root-gate");
  const disclosure = mounted.element.querySelector("details.meridian-root-gate");
  if (!(disclosure instanceof HTMLDetailsElement)) {
    throw new Error("the section mounted no change-proposal gate under its roots");
  }
  disclosure.open = true;
  await driveUntilWithin(mounted.bridge, mounted.element, ".meridian-proposal-gate__body");
  return mounted;
}

/** The diff pane over a parsed change set: attribution, compared states, rows. */
export async function mountDiffPane(): Promise<MountedFamilySurface> {
  const { bridge, sessionStore } = scenarioCollaborators();
  const { container } = await renderSettled(
    <DiffPane
      context={{
        kind: "diff",
        // The scenario's own git workspace, which is what a diff over this session's
        // work is a view of. Named from the scenario rather than spelled here, so the
        // subject the tier pins and the subject the fixture states cannot drift.
        entity: { kind: "workspace", id: REPOS_GIT_WORKSPACE_ID },
        ...paneBinding({ paneId: "pane-diff-surface", bridge, sessionStore }),
      }}
      diff={extendedHeaderChangeSet()}
    />,
  );
  // Anchored at the kind rather than spelled whole: the chrome names the pane by its
  // trail, so the full name carries the scenario's session id and the workspace this
  // diff is a view of — both stated by the fixture, and neither this module's to
  // restate.
  return { element: requireLabelledRegion(container, /Diff$/u), bridge };
}

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
