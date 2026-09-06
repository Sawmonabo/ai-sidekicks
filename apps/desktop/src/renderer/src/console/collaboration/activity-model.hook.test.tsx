// The composing lookup, driven through React the way the roster reads it.
//
// The claim is not "the registry knows who is composing" — `activity-model.test.ts`
// covers that. It is that a reader bound to the registry LEARNS, without anything
// else re-rendering it: the roster used to sample the registry during render and
// subscribe to nothing, so a pencil appeared only when some unrelated prop moved.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { frozenStartMilliseconds } from "../core/frozen-instant.test-support.js";
import { ActivityIndicatorRegistry, useComposingLookup } from "./activity-model.js";

const PARTICIPANT_ID = "participant-one";

/** Renders whatever the subscribed lookup answers for one participant, and nothing else. */
function ComposingProbe(props: {
  readonly registry: ActivityIndicatorRegistry;
}): React.JSX.Element {
  const composingChannelFor = useComposingLookup(props.registry);
  return <p>{composingChannelFor(PARTICIPANT_ID) ?? "nowhere"}</p>;
}

function registryOnFrozenTime(): ActivityIndicatorRegistry {
  return new ActivityIndicatorRegistry(new ManualClock(frozenStartMilliseconds()));
}

describe("composing lookup — subscribed, not sampled", () => {
  it("re-renders a reader when an indicator arrives", () => {
    const registry = registryOnFrozenTime();
    const { container } = render(<ComposingProbe registry={registry} />);
    expect(container.textContent).toBe("nowhere");

    act(() => {
      registry.noteComposing({
        participantId: PARTICIPANT_ID,
        channelId: "channel-review",
        since: "2026-01-01T10:00:00.000Z",
      });
    });
    expect(container.textContent).toBe("channel-review");
  });

  it("re-renders a reader when the indicator clears", () => {
    const registry = registryOnFrozenTime();
    registry.noteComposing({
      participantId: PARTICIPANT_ID,
      channelId: "channel-review",
      since: "2026-01-01T10:00:00.000Z",
    });
    const { container } = render(<ComposingProbe registry={registry} />);
    expect(container.textContent).toBe("channel-review");

    act(() => {
      registry.clearComposing(PARTICIPANT_ID);
    });
    expect(container.textContent).toBe("nowhere");
  });

  it("hands back one lookup until something changes", () => {
    // The identity IS the reading: React's external-store binding compares snapshots
    // by identity and re-reads whenever they differ, so a fresh function per call
    // would never converge — and a single function held for the registry's life would
    // never move a memoized roster at all.
    const registry = registryOnFrozenTime();
    const first = registry.composingLookup();
    expect(registry.composingLookup()).toBe(first);

    registry.noteComposing({
      participantId: PARTICIPANT_ID,
      channelId: "channel-review",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.composingLookup()).not.toBe(first);
  });
});
