// React's double mount runs a mount's cleanup and remounts the same instance, so the second
// mount would be handed the publisher the first teardown disposed (terminal: it never re-arms)
// and the pane would report nothing. The holder re-mints on `isClosed`; these cases reach that
// through the pane. `StrictMode` is React's own double mount, not an imitation of it.

import { StrictMode } from "react";

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecordingPageHost } from "../geometry/geometry-publisher.test-support.js";
import {
  previewPaneContext,
  chromeFor,
  recordingActs,
  releaseQueuedPaneFrames,
} from "../PreviewPane.test-support.js";

describe("Preview pane geometry — the publisher's binding", () => {
  it("publishes this pane's rectangle rather than holding the disposed one", async () => {
    const pageHost = new RecordingPageHost();
    const built = previewPaneContext();
    await act(async () => {
      render(<StrictMode>{chromeFor(built, recordingActs(), pageHost)}</StrictMode>);
    });

    // The frame the attach queued, which is where a publish lands. A committed disposed binding
    // arms nothing, so this would release nothing.
    await releaseQueuedPaneFrames(built.fixture);

    expect(pageHost.samples.length).toBeGreaterThan(0);
  });

  it("publishes through the new page host when the same pane is handed another one", async () => {
    const firstPageHost = new RecordingPageHost();
    const secondPageHost = new RecordingPageHost();
    const built = previewPaneContext();
    const rendered = render(chromeFor(built, recordingActs(), firstPageHost));
    await releaseQueuedPaneFrames(built.fixture);
    expect(firstPageHost.samples.length).toBeGreaterThan(0);

    rendered.rerender(chromeFor(built, recordingActs(), secondPageHost));
    await releaseQueuedPaneFrames(built.fixture);

    expect(secondPageHost.samples.length).toBeGreaterThan(0);
  });
});
