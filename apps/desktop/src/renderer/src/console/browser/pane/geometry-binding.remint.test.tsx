// The geometry binding under React's double mount.
//
// `useGeometryPublisher` holds its publisher in the console's subject-scoped resource
// holder, and one of the three arms that buys is the one a double mount reaches:
// React runs a mount's cleanup and then mounts the SAME component instance again, so
// the second mount is handed the publisher the first one's teardown disposed. A
// publisher's disposal is terminal by its own contract — it never re-arms, however
// late an event arrives — so committing that value would leave the pane with a
// publisher that reports nothing for the life of the mount, and the eventual native
// view positioned by nobody.
//
// The holder answers it with `isClosed`: a lifetime effect that finds its resource
// already closed re-mints rather than committing, and the run the re-mint causes does
// the committing. This case is that arm reached through the pane, because the arm is
// only worth anything if the pane is actually wired to it.
//
// `StrictMode` rather than a hand-driven unmount-and-remount, because the double
// mount is React's own behaviour and a hand-rolled imitation of it is a test of the
// imitation.

import { StrictMode } from "react";

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { SCRIPTED_PANE_VIEW_HOST_TRANSPORT } from "../../bridge/pane-view-host-script.js";
import { BrowserPane } from "./BrowserPane.js";
import {
  fixtureBrowserBridge,
  paneContext,
  releaseQueuedPaneFrames,
} from "./BrowserPane.test-support.js";

/** A fixture bridge whose scripted host takes every rectangle and records the pane. */
function recordingBrowserBridge(publishedPaneIds: string[]): ConsoleBridge {
  return {
    ...fixtureBrowserBridge(),
    paneViewHostScript: {
      transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
      holdsPane: (paneId) => {
        publishedPaneIds.push(paneId);
        return { holds: true };
      },
    },
  };
}

describe("browser pane geometry — the publisher under a double mount", () => {
  it("publishes this pane's rectangle rather than holding the disposed one", async () => {
    const publishedPaneIds: string[] = [];
    const built = paneContext(recordingBrowserBridge(publishedPaneIds));
    await act(async () => {
      render(
        <StrictMode>
          <BrowserPane {...built.context} />
        </StrictMode>,
      );
    });

    // The frame the attach queued, which is where a publish lands. A binding that had
    // committed the corpse arms nothing on the second mount, so this releases nothing
    // and the log below stays empty.
    await releaseQueuedPaneFrames(built.bridge);

    expect(publishedPaneIds).toContain(built.context.paneId);
  });
});
