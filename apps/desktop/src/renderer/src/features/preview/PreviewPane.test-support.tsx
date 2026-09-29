// What every browser-pane suite needs before it can ask the pane anything.
//
// One home for the roles more than one of the sibling suites plays: the pane context
// and the mount, the refusal banner read by role rather than by text, the address
// field read by its label, and the fixture bridge the geometry suites share. It holds
// nothing a single suite uses.

import { act, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { frozenClockOf } from "@test/helpers/scheduled-read.js";
import { RecordingViewHost } from "./geometry/geometry-publisher.test-support.js";
import type { AttachedPaneViewHost } from "./geometry/view-host.js";
import type { PaneContextOf } from "@renderer/console/seats/index.js";
import { paneContext } from "@renderer/registries/panes/pane-context.test-support.js";
import { PreviewPaneContent, type BrowserChromeActs } from "./components/PreviewPaneContent.js";

/** The context the pane is handed, and the fixture whose window it is mounted in. */
export interface PreviewPaneSubject {
  readonly context: PaneContextOf<"browser">;
  readonly fixture: FixtureBridge;
}

/**
 * The refusal banner the pane raises — a plain group, since the frame's announcer
 * owns the announcement — read by that role and scoped by the banner's own class,
 * so an unrelated group in the pane can never satisfy the query. Awaited through
 * `waitFor` because the port settles a refusal asynchronously and a bare role
 * query would answer before it lands.
 */
export function queryRefusalBanner(): HTMLElement | null {
  return (
    screen
      .queryAllByRole("group")
      .find((element) => element.classList.contains("meridian-refusal--banner")) ?? null
  );
}

export async function findRefusalBanner(): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = queryRefusalBanner();
    expect(banner).not.toBeNull();
    return banner as HTMLElement;
  });
}

/**
 * The fixture bridge a fixture or end-to-end run hands this pane, with the engine whose
 * frozen clock its window runs on.
 *
 * Named rather than inlined at each mount, so suites that mount the same pane share one
 * window.
 */
export function fixtureBrowserBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("browser-pane-test") });
}

/**
 * The context the pane layout hands this pane, over the shared builder.
 *
 * Exported because a second suite mounts the pane itself rather than through the
 * mounts below — the geometry binding's double-mount case needs the tree inside
 * `StrictMode`, which is a wrapper no shared mount can impose on the suites that do
 * not want it.
 *
 * The fixture is handed BACK beside the context because a default argument the caller
 * did not pass is a fixture it cannot otherwise name.
 *
 * The address arm carries no `entity` member: `browser` is session-scoped, so the
 * union's arm has none and the seat refuses one at this call site.
 */
export function previewPaneContext(
  fixture: FixtureBridge = fixtureBrowserBridge(),
  paneId: string = DEFAULT_TEST_PANE_ID,
): PreviewPaneSubject {
  return {
    fixture,
    context: paneContext(
      { kind: "browser" },
      { bridge: fixture.bridge, sessionStore: undefined, paneId },
    ),
  };
}

/** Acts that record the destinations they were asked to navigate to and do nothing else. */
export function recordingActs(navigations: string[] = []): BrowserChromeActs {
  const nothing = (): void => undefined;
  return {
    navigate: (url) => {
      navigations.push(url);
    },
    goBack: nothing,
    goForward: nothing,
    reload: nothing,
    stopLoading: nothing,
    selectPage: nothing,
    closePage: nothing,
    reorderPage: nothing,
  };
}

/**
 * The chrome over no reported location, no pages, the given acts and the given host, in
 * the subject's window.
 */
export function chromeFor(
  subject: PreviewPaneSubject,
  acts: BrowserChromeActs,
  viewHost: AttachedPaneViewHost,
): React.JSX.Element {
  return (
    <FixtureBridgeProvider fixture={subject.fixture}>
      <PreviewPaneContent
        {...subject.context}
        navigation={{ kind: "reading" }}
        pages={{ kind: "reading" }}
        acts={acts}
        viewHost={viewHost}
      />
    </FixtureBridgeProvider>
  );
}

/** The pane a suite mounts when it is not about which pane this is. */
export const DEFAULT_TEST_PANE_ID = "pane-browser-1";

/**
 * The swap a mounted pane can be put through without being remounted: a pane layout moves a
 * slot to another pane. The pane's state has to say whose it is against it, and a suite
 * that could only mount a fresh tree could not reach the stale-subject case.
 */
export interface PreviewPaneSubjectMount {
  readonly rebindTo: (nextPaneId: string) => Promise<void>;
}

/**
 * Mount the pane and hand back the re-render that swaps which pane it is FOR.
 *
 * The swap is what a pane layout performs when a slot changes subject: React keeps the
 * component instance and hands it a different `paneId`, so every piece of state the
 * pane carries between renders has to say whose it is. A suite that could only mount
 * a fresh tree could not reach that case at all.
 */
export async function mountPreviewPaneForSubject(
  fixture: FixtureBridge,
  paneId: string,
  ProbeComponent?: React.ComponentType,
  acts: BrowserChromeActs = recordingActs(),
): Promise<PreviewPaneSubjectMount> {
  const built = previewPaneContext(fixture, paneId);
  // One host for the whole mount: a new one per render would re-mint the publisher.
  const viewHost = new RecordingViewHost();
  let mounted: RenderResult | undefined;
  // A component type rather than a ready-made node, and that is load-bearing: React
  // skips re-rendering a child whose element is referentially identical, so a probe
  // passed as a node would mount once and then observe none of the commits it exists
  // to observe. Instantiated here, each render hands it a fresh element.
  const tree = (subject: PreviewPaneSubject): React.JSX.Element => (
    <>
      {chromeFor(subject, acts, viewHost)}
      {ProbeComponent === undefined ? null : <ProbeComponent />}
    </>
  );
  await act(async () => {
    mounted = render(tree(built));
  });
  const rendered = mounted;
  if (rendered === undefined) {
    throw new Error("the browser pane did not mount");
  }
  const rebindTo = async (nextPaneId: string): Promise<void> => {
    const rebound = previewPaneContext(fixture, nextPaneId);
    await act(async () => {
      rendered.rerender(tree(rebound));
    });
  };
  return { rebindTo };
}

/**
 * What the pane's region is CALLED once `seats/PaneFrame` names it.
 *
 * The chrome names a pane by its whole address trail rather than by its kind — "the
 * session, then Preview" — and every mount in this family's suites is unbound, so the
 * trail opens on the chrome's own no-address crumb. Spelled once here because it is a
 * property of the frame rather than of any one suite: a suite that hard-coded it would
 * be asserting the chrome's naming rule by accident, in as many places as it queried.
 */
const UNBOUND_PREVIEW_PANE_NAME = "No session Preview";

/**
 * The mounted pane's region, read by role and name.
 *
 * By ROLE rather than by class, because that pair is what a person using assistive
 * technology navigates by: a pane that lost its accessible name would still match a
 * class selector and every suite here would go on passing.
 */
export function previewPaneRegion(): HTMLElement {
  return screen.getByRole("region", { name: UNBOUND_PREVIEW_PANE_NAME });
}

/**
 * Mount the pane's chrome and let its first effects settle.
 */
export async function renderPreviewPane(
  fixture?: FixtureBridge,
  acts: BrowserChromeActs = recordingActs(),
): Promise<{
  readonly region: HTMLElement;
  readonly fixture: FixtureBridge;
}> {
  const built = previewPaneContext(fixture);
  await act(async () => {
    render(chromeFor(built, acts, new RecordingViewHost()));
  });
  return { region: previewPaneRegion(), fixture: built.fixture };
}

/**
 * Run the frames this fixture's window clock is holding, and let the commit they cause land.
 *
 * THE PANE'S GEOMETRY PUBLISHER READS ON INVALIDATION AND WRITES ON THE NEXT FRAME,
 * and that frame is armed on the window's own clock — which under the fixture is the
 * scenario's frozen one. So a publish is reached by a state change and never by
 * elapsed wall time, which is the whole point of a frozen clock and the reason this
 * has to be said out loud: a publisher on a private `RealClock` would get its publish
 * for free from whichever animation frame happened to fire first, and whether it had
 * happened yet would be decided by how fast the runner was.
 *
 * Inside `act` because the publish records an outcome the pane is subscribed to.
 */
export async function releaseQueuedPaneFrames(fixture: FixtureBridge): Promise<void> {
  const clock = frozenClockOf(fixture.scenarioEngine.clock);
  await act(async () => {
    clock.runFrame();
    await crossMacrotaskBoundary();
  });
}

/** The address field itself, read by its label so the query names what a person sees. */
export function addressField(): HTMLInputElement {
  return screen.getByLabelText("Destination") as HTMLInputElement;
}
