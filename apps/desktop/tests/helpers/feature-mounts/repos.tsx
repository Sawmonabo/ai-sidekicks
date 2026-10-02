// The repos feature's mount list and diff pane, mounted once for the screenshot and
// accessibility tiers.
//
// Not a test file. Both tiers need the same views, and a per-tier mount would compose them
// differently. `app-harness.ts` owns how the app is mounted, `mount-queries.ts` what a mounted
// view is and how a tier finds it, `repos-fixtures.ts` what the views are drawn against.
//
// Both views are mounted directly:
//
//   • The list is drawn from the mounts reader, whose calls are an argument, so it is mounted
//     over `sessionOperations()` (workspace list, each mount's read, execution roots, all
//     scripted). It holds three mounts: a healthy one, one whose root is `unreachable`, and one
//     whose root is no longer the repository it was attached as (`identity_mismatch`).
//   • The diff pane takes its model as a prop and no wire produces one, so the pane layout's own
//     body renders the `not-checked` empty state, which would pin a picture of an empty box. The
//     pane is mounted with `extendedHeaderChangeSet()`, the composition `DiffPane.tsx` draws. The
//     empty-state arm stays pinned by `DiffPane.test.tsx`, where a DOM assertion can say which
//     empty state it is.

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
import { MountList } from "@renderer/features/repos/mounts/components/MountList.js";
import { useRepoMounts } from "@renderer/features/repos/mounts/hooks/useRepoMounts.js";
import type { RepoOperations } from "@renderer/features/repos/repo-operations.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { renderSettled } from "../app-harness.js";
import { extendedHeaderChangeSet, scenarioBridgeAndStore } from "./repos-fixtures.js";
import { requireLabeledRegion, type MountedView } from "./mount-queries.js";

/**
 * The mount list with its three mounts read.
 *
 * Waited on rather than read straight after the mount: the reader reads the workspace list and
 * then each mount, so a tier capturing immediately would pin the pre-read frame. All three cards
 * are waited for because the first to land is not the last.
 */
export async function mountMountList(): Promise<MountedView> {
  const { bridge, scenarioEngine, clock, sessionStore } = scenarioBridgeAndStore();
  const operations = sessionOperations();
  const { container } = await renderSettled(
    // The provider carries the scenario's frozen clock, which the reads schedule on. The
    // announcer is the cards' environment: an act announces its own settlement, and
    // `useAnnounce` throws outside the provider on purpose. It runs on frozen time so the
    // standing message never clears itself mid-capture.
    <PlatformBridgeProvider bridge={bridge} clock={clock}>
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <ReadMountList bridge={bridge} sessionStore={sessionStore} operations={operations} />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  );
  await advanceScenarioUntil(scenarioEngine, () => {
    const drawn = container.querySelectorAll(".meridian-mount-card").length;
    if (drawn < MOUNTS.length) {
      throw new Error(`${drawn} of ${MOUNTS.length} mount cards have rendered`);
    }
  });
  return { element: container, bridge };
}

/** The diff pane over a parsed change set: compared states, file list, rows. */
export async function mountDiffPane(): Promise<MountedView> {
  const { bridge, sessionStore } = scenarioBridgeAndStore();
  const { container } = await renderSettled(
    <DiffPane
      context={paneContext({
        // The session's own workspace, named from the mounts fixture so the subject the tier pins
        // and the workspace the list states cannot drift.
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

/** The list bound to its reader, the way a screen that lists the folders composes it. */
function ReadMountList(props: {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  readonly operations: RepoOperations;
}): React.JSX.Element | null {
  const { reading, requestModeSelection, requestRead } = useRepoMounts(
    props.bridge,
    props.sessionStore,
    props.operations,
  );
  return (
    <MountList
      reading={reading}
      bridge={props.bridge}
      sessionStore={props.sessionStore}
      operations={props.operations}
      onCopy={() => undefined}
      onRequestRead={requestRead}
      onSelect={requestModeSelection}
      onOpenDiff={() => undefined}
    />
  );
}
