// The repos feature's sidebar section and diff pane, mounted once for the screenshot and
// accessibility tiers.
//
// Not a test file. Both tiers need the same views, and a per-tier mount would compose them
// differently. `app-harness.ts` owns how the app is mounted, `mount-queries.ts` what a mounted
// view is and how a tier finds it, `repos-fixtures.ts` what the views are drawn against.
//
// Both views are mounted directly:
//
//   • The section takes its calls as an argument, so it is mounted over `sessionOperations()`
//     (workspace list, each mount's read, execution roots, all scripted). Three mounts are stated
//     on purpose: a git checkout, a plain directory, and a git checkout that is no longer the
//     repository it was attached as. Two answer failing health verdicts, `unreachable` and
//     `identity_mismatch`; they are separate rows because neither verdict is reachable from the
//     other's mount (`identity_mismatch` needs a persisted identity anchor a plain directory
//     lacks).
//   • The diff pane takes its model as a prop and no wire produces one, so the pane layout's own
//     body renders the `not-checked` absence, the emptiest frame, which would pin a baseline of a
//     box. The pane is mounted with `extendedHeaderChangeSet()`, the composition `DiffPane.tsx`
//     draws. The absence arm stays pinned by `DiffPane.test.tsx`, where a DOM assertion can say
//     which absence it is.

import { advanceScenarioUntil } from "../scenario-manual-clock.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { DiffPane } from "@renderer/features/repos/diff/components/DiffPane.js";
import { paneContext } from "@renderer/features/repos/pane-context.test-support.js";
import {
  HEALTHY_WORKSPACE_ID,
  MOUNTS,
  sessionOperations,
} from "@renderer/features/repos/mounts/repo-mounts.test-support.js";
import { RepoSection } from "@renderer/features/repos/mounts/RepoSection.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { renderSettled } from "../app-harness.js";
import { extendedHeaderChangeSet, scenarioBridgeAndStore } from "./repos-fixtures.js";
import { requireElement, requireLabeledRegion, type MountedView } from "./mount-queries.js";

/**
 * The repos sidebar section, open, with its three mounts read.
 *
 * Waited on rather than read straight after the mount: the section reads the workspace list and
 * then each mount, so a tier capturing immediately would pin the pre-read frame. All three cards
 * are waited for because the first to land is not the last.
 */
export async function mountRepoSection(): Promise<MountedView> {
  const { bridge, scenarioEngine, clock, sessionStore } = scenarioBridgeAndStore();
  const { container } = await renderSettled(
    // The provider carries the scenario's frozen clock, which the section's reads schedule on.
    // The announcer is the section's environment: an act announces its own settlement, and
    // `useAnnounce` throws outside the provider on purpose. It runs on frozen time so the
    // standing message never clears itself mid-capture: its hold deadline is the one timer the
    // primitive arms, and on a real clock it would land a state update after the section
    // settled.
    <PlatformBridgeProvider bridge={bridge} clock={clock}>
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <RepoSection
          bridge={bridge}
          sessionStore={sessionStore}
          operations={sessionOperations()}
          isOpen
          openPane={() => undefined}
        />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  );
  const region = requireElement(container, ".meridian-repo-section");
  await advanceScenarioUntil(scenarioEngine, () => {
    const drawn = region.querySelectorAll(".meridian-mount-card").length;
    if (drawn < MOUNTS.length) {
      throw new Error(`${drawn} of ${MOUNTS.length} mount cards have rendered`);
    }
  });
  return { element: region, bridge };
}

/** The diff pane over a parsed change set: compared states, file list, rows. */
export async function mountDiffPane(): Promise<MountedView> {
  const { bridge, sessionStore } = scenarioBridgeAndStore();
  const { container } = await renderSettled(
    <DiffPane
      context={paneContext({
        // The session's own workspace, named from the section's fixture so the subject the tier
        // pins and the subject the section states cannot drift.
        address: { kind: "diff", entity: { kind: "workspace", id: HEALTHY_WORKSPACE_ID } },
        paneId: "pane-diff",
        bridge,
        sessionStore,
      })}
      diff={extendedHeaderChangeSet()}
    />,
  );
  // Anchored at the kind: the chrome names the pane by its trail, so the full name carries the
  // session id and workspace, both stated by the fixture.
  return { element: requireLabeledRegion(container, /Review$/u), bridge };
}
