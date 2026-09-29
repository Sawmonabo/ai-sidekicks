// The geometry binding under React's double mount, and under a new view host.
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
// The second case is the other subject a binding can outlive: a publisher writes to one
// host for life, so a pane handed a different host has to publish through that one.
//
// `StrictMode` rather than a hand-driven unmount-and-remount, because the double
// mount is React's own behavior and a hand-rolled imitation of it is a test of the
// imitation.

import { StrictMode } from "react";

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecordingViewHost } from "../geometry/geometry-publisher.test-support.js";
import {
  browserPaneContext,
  chromeFor,
  recordingActs,
  releaseQueuedPaneFrames,
} from "../PreviewPane.test-support.js";

describe("browser pane geometry — the publisher's binding", () => {
  it("publishes this pane's rectangle rather than holding the disposed one", async () => {
    const viewHost = new RecordingViewHost();
    const built = browserPaneContext();
    await act(async () => {
      render(<StrictMode>{chromeFor(built.context, recordingActs(), viewHost)}</StrictMode>);
    });

    // The frame the attach queued, which is where a publish lands. A binding that had
    // committed the corpse arms nothing on the second mount, so this releases nothing
    // and the log below stays empty.
    await releaseQueuedPaneFrames(built.bridge);

    expect(viewHost.samples.length).toBeGreaterThan(0);
  });

  it("publishes through the new host when the same pane is handed another one", async () => {
    const firstHost = new RecordingViewHost();
    const secondHost = new RecordingViewHost();
    const built = browserPaneContext();
    const rendered = render(chromeFor(built.context, recordingActs(), firstHost));
    await releaseQueuedPaneFrames(built.bridge);
    expect(firstHost.samples.length).toBeGreaterThan(0);

    rendered.rerender(chromeFor(built.context, recordingActs(), secondHost));
    await releaseQueuedPaneFrames(built.bridge);

    expect(secondHost.samples.length).toBeGreaterThan(0);
  });
});
