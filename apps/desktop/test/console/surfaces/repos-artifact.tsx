// The artifact pane's mounts: the settled pane, and the two payload arms.
//
// SPLIT FROM `repos.tsx` BECAUSE THE PANE IS THE FAMILY'S THIRD SURFACE AND ITS MOUNTS
// ARE ITS LARGEST. The other module holds the sidebar section, the diff pane, and the
// proposal gate; this one holds the artifact pane, and both draw the same waits from
// `repos-mount-harness.ts`. Nothing here is reachable from the other file and nothing
// there from here, so the two can be read independently — which is the whole point.
//
// THE TWO PAYLOAD ARMS ARE SCRIPTED AND THE SETTLED PANE IS NOT. `mountArtifactPane`
// runs the scenario's own port, so what it pins is what the fixture actually answers; a
// payload arm pins a reply the scenario has no way to produce, and says so by taking the
// answer as an argument rather than by reaching into the bridge.

import { act, fireEvent, within } from "@testing-library/react";

import { renderSettled } from "../console-harness.js";

import {
  DEFERRED_PAYLOAD_READ,
  INLINE_PAYLOAD_READ,
  paneBinding,
  paneBodyComponent,
  scenarioCollaborators,
  scriptedArtifactPort,
} from "./repos-fixtures.js";
import {
  SCENARIO_SETTLE_ADVANCE_MS,
  requireLabelledRegion,
  waitForWithin,
  type MountedFamilySurface,
} from "./repos-mount-harness.js";

import type { GrowthPortAnswer } from "../../../src/renderer/src/console/bridge/growth-port/growth-port.js";
import {
  REPOS_PINNED_ARTIFACT_ID,
  REPOS_SCENARIO,
} from "../../../src/renderer/src/console/bridge/scenarios/repos.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { SessionStore } from "../../../src/renderer/src/console/store/index.js";

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
  const ArtifactPaneBody = await paneBodyComponent("artifact");
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
  const region = requireLabelledRegion(container, /Artifact$/u);
  await waitForWithin(region, ".meridian-artifacts");
  // THE PANE'S FIRST READ IS ON THE WINDOW'S CLOCK, so under a scenario bridge it is
  // on FROZEN time and nothing here was moving it. The reader's refresh scheduler is
  // trailing-edge — `start()` asks for a read and the read happens a debounce interval
  // later — and `consoleClockFor` hands a pane under the fixture the scenario engine's
  // clock, which is the rule `Spec-023 §The fixture bridge` states and the whole point
  // of the seam. So the interval never elapsed, the list never resolved, and the
  // refusal this subject is named for never arrived. Advancing past the scheduler's
  // absolute deadline is what a scenario beat would have done anyway; a bare
  // `runToCompletion()` would not, because it plays the script's beats rather than
  // moving time past a deadline no beat is scheduled at.
  await act(async () => {
    bridge.scenarioEngine?.advance(SCENARIO_SETTLE_ADVANCE_MS);
    await crossMacrotaskBoundary();
  });
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
 * snapshot, so the allow-list hint is settled in the same frame.
 *
 * AND THE CLOCK IS DRIVEN FIRST, which `mountArtifactPane` above already does and this
 * mount used to be unable to. The port is a real fixture bridge now rather than a
 * hand-built object, so it carries the scenario engine and `consoleClockFor` hands the
 * pane that engine's frozen clock — which means the reader's trailing-edge scheduler
 * waits on time nothing was moving, and the filter group the wait below is keyed to
 * never arrived. The advance is the same beat the refusal subject takes, for the same
 * reason: a deadline no scripted beat is scheduled at is reached by moving time past
 * it. The DOM wait stays, because it says the state is on screen rather than that time
 * has passed.
 */
async function mountArtifactPanePayload(
  readAnswer: GrowthPortAnswer<"artifactRead">,
): Promise<MountedFamilySurface> {
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  const bridge = scriptedArtifactPort(readAnswer);
  const ArtifactPaneBody = await paneBodyComponent("artifact");
  const { container } = await renderSettled(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      {ArtifactPaneBody({
        kind: "artifact",
        entity: { kind: "artifact", id: REPOS_PINNED_ARTIFACT_ID },
        ...paneBinding({ paneId: "pane-artifact-payload", bridge, sessionStore }),
      })}
    </LiveAnnouncerProvider>,
  );
  const region = requireLabelledRegion(container, /Artifact$/u);
  await act(async () => {
    bridge.scenarioEngine?.advance(SCENARIO_SETTLE_ADVANCE_MS);
    await crossMacrotaskBoundary();
  });
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
