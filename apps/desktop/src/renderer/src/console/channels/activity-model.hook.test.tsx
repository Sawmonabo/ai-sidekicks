// The channel activity binding, driven through React the way a row reads it.
//
// The claim is not "the registry knows which run is working" — `activity-model.test.ts`
// covers that. It is that a reader bound to the registry LEARNS, without anything else
// re-rendering it: a surface that sampled the registry during render and subscribed to
// nothing would move only when some unrelated prop did.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityIndicatorRegistry, useChannelActivity } from "./activity-model.js";

const CHANNEL_ID = "channel-review";

/** Renders how many runs the subscribed reading names for one channel, and nothing else. */
function ActivityProbe(props: { readonly registry: ActivityIndicatorRegistry }): React.JSX.Element {
  const activity = useChannelActivity(props.registry, CHANNEL_ID);
  return <p>{String(activity.agentRuns.length)}</p>;
}

describe("channel activity — subscribed, not sampled", () => {
  it("re-renders a reader when an indicator arrives", () => {
    const registry = new ActivityIndicatorRegistry();
    const { container } = render(<ActivityProbe registry={registry} />);
    expect(container.textContent).toBe("0");

    act(() => {
      registry.noteAgentActivity({
        runId: "run-1",
        channelId: CHANNEL_ID,
        since: "2026-01-01T10:00:00.000Z",
      });
    });
    expect(container.textContent).toBe("1");
  });

  it("re-renders a reader when the indicator clears", () => {
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: CHANNEL_ID,
      since: "2026-01-01T10:00:00.000Z",
    });
    const { container } = render(<ActivityProbe registry={registry} />);
    expect(container.textContent).toBe("1");

    act(() => {
      registry.clearAgentActivity("run-1");
    });
    expect(container.textContent).toBe("0");
  });

  it("negative control: a run in another channel moves this reader not at all", () => {
    // Without this the two cases above would pass over a binding that re-rendered every
    // row on every change anywhere, which is the cost this per-channel memo exists to
    // avoid.
    const registry = new ActivityIndicatorRegistry();
    const { container } = render(<ActivityProbe registry={registry} />);

    act(() => {
      registry.noteAgentActivity({
        runId: "run-1",
        channelId: "channel-main",
        since: "2026-01-01T10:00:00.000Z",
      });
    });

    expect(container.textContent).toBe("0");
  });
});
