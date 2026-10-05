// Shared mounts and queries for the Preview pane suites: the pane context, the refusal banner,
// the address field and the fixture bridge the geometry suites share.

import { act, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture/bridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app/frame-fixtures.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { frozenClockOf } from "@test/helpers/scheduled-read.js";
import { RecordingPageHost } from "./geometry/geometry-publisher.test-support.js";
import type { PageHost } from "./geometry/page-host.js";
import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { paneContext } from "@test/helpers/pane-context.js";
import { PreviewPaneContent, type PreviewChromeActs } from "./components/PreviewPaneContent.js";

/** The context the pane is handed, and the fixture whose window it is mounted in. */
export interface PreviewPaneSubject {
  readonly context: PaneContextOf<"browser">;
  readonly fixture: FixtureBridge;
}

/**
 * The refusal banner (a plain group with the banner class), or null. The port settles a refusal
 * asynchronously, so await it through `findRefusalBanner`.
 */
export function queryRefusalBanner(): HTMLElement | null {
  return (
    screen
      .queryAllByRole("group")
      .find((element) => element.classList.contains("meridian-refusal--banner")) ?? null
  );
}

/** Waits until the refusal banner is present. */
export async function findRefusalBanner(): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = queryRefusalBanner();
    expect(banner).not.toBeNull();
    return banner as HTMLElement;
  });
}

/** The fixture bridge every Preview pane suite mounts in, so they share one window. */
export function fixturePreviewBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("preview-pane-test") });
}

/**
 * The context the pane layout hands this pane, with the fixture it is mounted in. Exported for
 * suites that mount the pane themselves (the double-mount case needs `StrictMode`).
 */
export function previewPaneContext(
  fixture: FixtureBridge = fixturePreviewBridge(),
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
export function recordingActs(navigations: string[] = []): PreviewChromeActs {
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

/** The chrome with no reported location or pages, over the given acts and page host. */
export function chromeFor(
  subject: PreviewPaneSubject,
  acts: PreviewChromeActs,
  pageHost: PageHost,
): React.JSX.Element {
  return (
    <FixtureBridgeProvider fixture={subject.fixture}>
      <PreviewPaneContent
        {...subject.context}
        navigation={{ kind: "reading" }}
        pages={{ kind: "reading" }}
        acts={acts}
        pageHost={pageHost}
      />
    </FixtureBridgeProvider>
  );
}

/** The pane a suite mounts when it is not about which pane this is. */
export const DEFAULT_TEST_PANE_ID = "pane-browser-1";

/** A second pane, for the suites about which pane a thing belongs to. */
export const SECOND_TEST_PANE_ID = "pane-browser-2";

/**
 * Re-renders a mounted pane for another pane id, as a pane slot changing subject does; a fresh
 * mount could not reach the stale-subject case.
 */
export interface PreviewPaneSubjectMount {
  readonly rebindTo: (nextPaneId: string) => Promise<void>;
}

/**
 * Mounts the pane and returns the re-render that hands the same component instance a different
 * `paneId`, so state carried between renders has to say whose it is.
 */
export async function mountPreviewPaneForSubject(
  fixture: FixtureBridge,
  paneId: string,
  ProbeComponent?: React.ComponentType,
  acts: PreviewChromeActs = recordingActs(),
): Promise<PreviewPaneSubjectMount> {
  const built = previewPaneContext(fixture, paneId);
  // One page host for the whole mount: a new one per render would re-mint the publisher.
  const pageHost = new RecordingPageHost();
  let mounted: RenderResult | undefined;
  // A component type, not a node: React skips re-rendering an element that is referentially
  // identical, so a probe passed as a node would not observe later commits.
  const tree = (subject: PreviewPaneSubject): React.JSX.Element => (
    <>
      {chromeFor(subject, acts, pageHost)}
      {ProbeComponent === undefined ? null : <ProbeComponent />}
    </>
  );
  await act(async () => {
    mounted = render(tree(built));
  });
  const rendered = mounted;
  if (rendered === undefined) {
    throw new Error("the Preview pane did not mount");
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
 * The region's accessible name: the chrome names a pane by its address trail, and an unbound
 * mount opens on the no-address crumb.
 */
const UNBOUND_PREVIEW_PANE_NAME = "No session Preview";

/** The mounted pane's region, read by role and name (what assistive technology uses), not class. */
export function previewPaneRegion(): HTMLElement {
  return screen.getByRole("region", { name: UNBOUND_PREVIEW_PANE_NAME });
}

/** Mounts the pane's chrome and lets its first effects settle. */
export async function renderPreviewPane(
  fixture?: FixtureBridge,
  acts: PreviewChromeActs = recordingActs(),
): Promise<{
  readonly region: HTMLElement;
  readonly fixture: FixtureBridge;
}> {
  const built = previewPaneContext(fixture);
  await act(async () => {
    render(chromeFor(built, acts, new RecordingPageHost()));
  });
  return { region: previewPaneRegion(), fixture: built.fixture };
}

/**
 * Runs the frames the fixture's frozen window clock is holding and lets the resulting commit
 * land. The geometry publisher writes on the next frame of that clock, so a publish follows a
 * state change and never elapsed time. Runs inside `act` because the publish records an outcome
 * the pane subscribes to.
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
