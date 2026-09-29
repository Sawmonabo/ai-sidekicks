// The repos feature's sidebar section and diff pane, mounted once for the two tiers that
// look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier both need the same views this feature ships, and a per-tier copy
// of the mount would be two chances to compose them differently and then read the
// results as if they were comparable. Three modules divide that job: `app-harness.ts`
// owns HOW the app is mounted, `mount-queries.ts` owns what a mounted view is and
// how a tier finds it, and `repos-fixtures.ts` owns what the views are drawn against.
//
// BOTH VIEWS ARE MOUNTED DIRECTLY, AND EACH FOR A STATED REASON.
//
//   • The SECTION is a component that takes its calls as an argument, so it is mounted
//     over `sessionOperations()`: the session's workspace list, each mount's read, and
//     the execution roots, all scripted. Three mounts are stated on purpose — a git
//     checkout, a plain directory, and a git checkout that is no longer the repository
//     it was attached as — and two of them answer on the failing health verdicts,
//     `unreachable` and `identity_mismatch`. Those are the degraded mounts this tier
//     exists to pin, and they are separate rows because neither verdict is reachable
//     from the other's mount: `identity_mismatch` needs a persisted identity anchor a
//     plain directory has none of, and the unreachable row's path is the thing that
//     stopped answering.
//   • The DIFF PANE takes its model as a prop and no wire produces one, so the pane layout's
//     own body renders the `not-checked` absence — which is the emptiest frame the
//     pane has and would pin a baseline of a box. The pane is mounted with
//     `extendedHeaderChangeSet()` instead, which is the composition `DiffPane.tsx`
//     draws: the compared states, the file list, and the rows. The absence arm is not
//     unpinned by that — `DiffPane.test.tsx` owns it, where a DOM assertion can say
//     WHICH absence it is and an image cannot.

import { advanceScenarioUntil } from "../scenario-manual-clock.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
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
 * Waited on rather than read straight after the mount: the section reads the workspace
 * list and then each mount, so a tier that captured immediately would pin the pre-read
 * frame and then compare a later warm run against it. All three cards are waited for,
 * because the first to land is not the last.
 */
export async function mountRepoSection(): Promise<MountedView> {
  const { bridge, scenarioEngine, clock, sessionStore } = scenarioBridgeAndStore();
  const { container } = await renderSettled(
    // The provider carries the scenario's frozen clock, which the section's reads schedule on.
    //
    // The announcer is the section's environment: an act announces its own settlement,
    // and `useAnnounce` throws outside the provider on purpose.
    //
    // ON FROZEN TIME, so the standing message never clears itself mid-capture. The
    // announcer's hold deadline is the one timer the primitive arms, and on a real
    // clock it lands a state update after the section has settled — which a tier
    // records as whichever side of the clear the runner happened to reach.
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
        // The session's own workspace, which is what a diff over this session's work is a
        // view of. Named from the section's fixture rather than spelled here, so the
        // subject the tier pins and the subject the section states cannot drift.
        address: { kind: "diff", entity: { kind: "workspace", id: HEALTHY_WORKSPACE_ID } },
        paneId: "pane-diff",
        bridge,
        sessionStore,
      })}
      diff={extendedHeaderChangeSet()}
    />,
  );
  // Anchored at the kind rather than spelled whole: the chrome names the pane by its
  // trail, so the full name carries the session id and the workspace this diff is a view
  // of — both stated by the fixture, and neither this module's to restate.
  return { element: requireLabeledRegion(container, /Review$/u), bridge };
}
