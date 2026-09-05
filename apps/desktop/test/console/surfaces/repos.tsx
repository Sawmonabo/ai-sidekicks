// The repos family's surfaces, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier both need the same four surfaces this family ships, and a
// per-tier copy of the mount would be two chances to compose them differently and
// then read the results as if they were comparable. That is `console-harness.tsx`'s
// own reason for existing, one level down: the harness owns HOW the console is
// mounted, this module owns which of this family's surfaces is mounted and what
// settled means for each, and `repos-fixtures.ts` owns what they are drawn against.
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

import { fireEvent, waitFor, within } from "@testing-library/react";

import { renderSettled } from "../console-harness.js";

import {
  DEFERRED_PAYLOAD_READ,
  INLINE_PAYLOAD_READ,
  PREPARED_GATE_STATE,
  PUSH_REFUSAL,
  extendedHeaderChangeSet,
  paneBinding,
  paneBodyComponent,
  scenarioCollaborators,
  scriptedArtifactPort,
} from "./repos-fixtures.js";

import {
  REPOS_GIT_WORKSPACE_ID,
  REPOS_PINNED_ARTIFACT_ID,
  REPOS_SCENARIO,
} from "../../../src/renderer/src/console/bridge/scenarios/repos.js";
import type { ConsoleBridge } from "../../../src/renderer/src/console/bridge/index.js";
import { DiffPane } from "../../../src/renderer/src/console/panes/diff/index.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { ProposalGate } from "../../../src/renderer/src/console/repos/proposals/ProposalGate.js";
import { registerRepos } from "../../../src/renderer/src/console/repos/index.js";
import { advanceScenarioUntil } from "../../../src/renderer/src/console/repos/scenario-clock.test-support.js";
import { SessionStore } from "../../../src/renderer/src/console/store/index.js";
import {
  sidebarSectionRegistry,
  type SidebarSectionContext,
} from "../../../src/renderer/src/console/seats/index.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/** How long a surface's first read may take to settle before a tier gives up. */
const FAMILY_READ_TIMEOUT_MS = 5_000;

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
 * The same wait, for a surface whose reads are scheduled on the SCENARIO's clock.
 *
 * THE SECTION AND ITS GATES SCHEDULE ON THE BRIDGE'S CLOCK, which under the fixture is
 * the scenario's frozen one — the point of taking it from `consoleClockFor`, and what
 * makes these baselines pin one instant rather than the day they were minted on. Real
 * time therefore moves none of it, so this wait drives the clock instead of polling the
 * machine. The pane mounts above keep `waitForWithin`: their reads run on a port this
 * file scripts directly, with no scenario engine behind them.
 */
async function driveUntilWithin(
  bridge: ConsoleBridge,
  region: HTMLElement,
  selector: string,
): Promise<void> {
  await advanceScenarioUntil(bridge, () => {
    if (region.querySelector(selector) === null) {
      throw new Error(`the surface has not rendered \`${selector}\` yet`);
    }
  });
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
  const DiffPaneBody = DiffPane;
  const { container } = await renderSettled(
    <DiffPaneBody
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
      {ArtifactPaneBody({
        kind: "artifact",
        // The scenario's pinned attachment — a published artifact this session
        // actually holds, on the diff pane's rule about naming its subject.
        entity: { kind: "artifact", id: REPOS_PINNED_ARTIFACT_ID },
        ...paneBinding({ paneId: "pane-artifact-surface", bridge, sessionStore }),
      })}
    </LiveAnnouncerProvider>,
  );
  const region = requireLabelledRegion(container, "Artifact");
  await waitForWithin(region, ".meridian-artifacts");
  await waitForWithin(region, ".meridian-refusal--card");
  return { element: region, bridge };
}

/**
 * The artifact pane after a payload fetch, on each of the two arms a served read has.
 *
 * A SECOND AND THIRD SUBJECT rather than a flag on the first, on the proposal gate's
 * rule: the refusal composition above and the two served ones are different surfaces,
 * and the first would go on passing if the payload section never rendered at all.
 *
 * DRIVEN THROUGH `scriptedArtifactPort`, because the fixture's growth port serves no
 * `artifact*` operation at all, so a subject waiting on the scenario for a served
 * payload would wait forever. Why that port answers as it does is stated where it is.
 *
 * THE SCHEDULED READ IS WAITED FOR BEFORE THE ACT IS PRESSED, AND THAT ORDER IS THE
 * WHOLE FIX. This mount used to wait for the payload section alone — the act's own
 * DOM — while the pane's list and allow-list reads were still inside the refresh
 * scheduler's coalescing window, which is 120 ms of real time and not a microtask
 * `renderSettled` can flush. So the Artifacts panel was captured in whichever of two
 * states the runner reached, and it genuinely reached both: the same commit measured
 * 10,510 and then 10,232 differing pixels on consecutive runs of one subject, while a
 * sibling subject lost the race every time and pinned the pre-read frame. A baseline
 * minted over that records a coin flip, and every later comparison against it is a
 * comparison with the coin.
 *
 * WAITED FOR BY THE ARM'S OWN DOM, on `mountRepoSection`'s rule and for its reason.
 * The panel's filter group is rendered if and only if a list came back — the panel
 * withholds it on `not-checked`, on `loading`, and on a refusal, because an offered
 * filter is a promise that pressing it narrows something — so its presence IS the
 * settled `listed` arm and nothing else. Both of the reader's legs publish as one
 * snapshot, so the allow-list hint is settled in the same frame. A clock is not driven
 * here instead: the pane builds its own `RealClock` behind the binding and this file
 * has no seam to hand it one, and the wait a surface already answers is the better
 * signal anyway — it says the state is on screen rather than that time has passed.
 */
async function mountArtifactPanePayload(
  readAnswer: Record<string, unknown>,
): Promise<MountedFamilySurface> {
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  const bridge = scriptedArtifactPort(readAnswer);
  const ArtifactPaneBody = paneBodyComponent("artifact");
  const { container } = await renderSettled(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      {ArtifactPaneBody({
        kind: "artifact",
        entity: { kind: "artifact", id: REPOS_PINNED_ARTIFACT_ID },
        ...paneBinding({ paneId: "pane-artifact-payload", bridge, sessionStore }),
      })}
    </LiveAnnouncerProvider>,
  );
  const region = requireLabelledRegion(container, "Artifact");
  await waitForWithin(region, ".meridian-artifacts__filter");
  fireEvent.click(within(region).getByRole("button", { name: "Fetch payload" }));
  await waitForWithin(region, ".meridian-artifact-payload");
  return { element: region, bridge };
}

/** The pane on the DEFERRED arm: a content-addressed handle and no bytes. */
export async function mountArtifactPaneDeferredPayload(): Promise<MountedFamilySurface> {
  return mountArtifactPanePayload(DEFERRED_PAYLOAD_READ);
}

/** The pane on the INLINE arm: the bytes, and the encoding a reader switches on. */
export async function mountArtifactPaneInlinePayload(): Promise<MountedFamilySurface> {
  return mountArtifactPanePayload(INLINE_PAYLOAD_READ);
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
