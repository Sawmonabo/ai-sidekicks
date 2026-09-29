// Which frames a call swap paints, which no assertion on a settled state can see.
//
// The hook's sibling suite reads STATES — what one read settles on — and this one
// reads FRAMES. They are different claims: a hook that reached the right
// final answer by way of one commit showing the previous node's session list would
// satisfy every case next door, and that commit is exactly the defect. It is one
// frame long, and `act` has already replaced it by the time an assertion could look
// at the DOM, so the reading is `CommittedFrameRecorder` — a `Profiler` over the
// tree, called once per commit, before any passive effect runs.
//
// The control is the shape this hook replaced: a `useState` cell reset from the first
// statement of the effect body. That reset cannot run before the commit of the render
// that installed the new call, so the swap paints the previous node's list under the
// new source — a stale list reading as a current one. It is kept runnable here and
// asserted to do exactly that, which is what makes the clean case a claim about the
// holder rather than about the script.
//
// TWO PLAIN CALLS: one serves a session and the other serves none, so the stale frame
// is nameable text rather than an inferred state.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CommittedFrameRecorder } from "@test/helpers/CommittedFrameRecorder.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { useSessionDirectory } from "./useSessionDirectory.js";
import { type SessionDirectoryReadCall, type SessionDirectoryState } from "./session-directory.js";
import { NO_TRANSPORT_RECONNECT } from "@renderer/lib/transport-reconnect.js";

/**
 * The shape this hook replaced: a `useState` cell reset from inside the effect.
 *
 * Not a stand-in for the holder — it is the OLD code on the one axis this suite
 * measures, kept only so the frame claim above it is shown to discriminate. The reset
 * is the first statement of the effect body, so it cannot run before the commit of the
 * render that installed the new call, and the mounted latch is the boolean the
 * holder's publisher replaced.
 *
 * IT READS THE SAME WAY THE SHIPPED HOOK DOES, and that is what makes it a control
 * rather than a second experiment: the only thing that differs between the two
 * surfaces below is WHEN the state is reset — which is the whole of what a frame
 * recorder can see.
 */
function useSessionDirectoryWithEffectTimeReset(
  read: SessionDirectoryReadCall,
): SessionDirectoryState {
  const [state, setState] = useState<SessionDirectoryState>({ status: "reading" });
  useEffect(() => {
    setState({ status: "reading" });
    let isMounted = true;
    void read(new AbortController().signal).then((sessions) => {
      if (!isMounted) {
        return;
      }
      setState({ status: "served", sessions });
    });
    return () => {
      isMounted = false;
    };
  }, [read]);
  return state;
}

const BUSY_NODE_SESSION_ID = "session-on-the-busy-node";

/** A node that serves one session. */
const readBusyNode: SessionDirectoryReadCall = () =>
  Promise.resolve([{ sessionId: BUSY_NODE_SESSION_ID, state: "active" }]);

/** A node that serves none. */
const readEmptyNode: SessionDirectoryReadCall = () => Promise.resolve([]);

/** What the busy node's directory paints, so the stale frame is nameable text. */
const BUSY_NODE_DIRECTORY_TEXT = `served: ${BUSY_NODE_SESSION_ID}`;

/** What the empty node paints. */
const EMPTY_NODE_DIRECTORY_TEXT = "served: (none)";

/** One reading as one line, so a committed frame is comparable as text. */
function directoryText(state: SessionDirectoryState): string {
  if (state.status === "reading") {
    return "reading";
  }
  const sessionIds = state.sessions.map((session) => session.sessionId);
  return `served: ${sessionIds.length === 0 ? "(none)" : sessionIds.join(", ")}`;
}

/** The shipped hook, painted. */
function DirectoryFrame(props: { readonly read: SessionDirectoryReadCall }): React.JSX.Element {
  return <output>{directoryText(useSessionDirectory(props.read, NO_TRANSPORT_RECONNECT))}</output>;
}

/** The pre-holder hook, painted — the same surface over the shape this replaced. */
function EffectTimeResetFrame(props: {
  readonly read: SessionDirectoryReadCall;
}): React.JSX.Element {
  return <output>{directoryText(useSessionDirectoryWithEffectTimeReset(props.read))}</output>;
}

/** Let the directory read settle, so an assertion is about the answer. */
async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/** Every committed frame one mount painted, and how many came before the call moved. */
interface CallSwapFrames {
  readonly frames: readonly string[];
  readonly beforeSwap: number;
}

/**
 * Mount against one node's call, settle, swap in another node's, and settle again.
 *
 * One script for both the shipped hook and the shape it replaced, so the control
 * differs from the claim by the hook alone. The frames are read through
 * `CommittedFrameRecorder` rather than off the DOM because the frame at issue is one
 * commit long: `act` has already replaced it by the time an assertion could look.
 */
async function framesAcrossACallSwap(
  Surface: (props: { readonly read: SessionDirectoryReadCall }) => React.JSX.Element,
): Promise<CallSwapFrames> {
  const frames: string[] = [];
  const recorded = (read: SessionDirectoryReadCall): React.JSX.Element => (
    <CommittedFrameRecorder
      id="session-directory-call-swap"
      onFrame={(committedText) => {
        frames.push(committedText);
      }}
    >
      <Surface read={read} />
    </CommittedFrameRecorder>
  );
  const view = render(recorded(readBusyNode));
  await settle();
  const beforeSwap = frames.length;
  act(() => {
    view.rerender(recorded(readEmptyNode));
  });
  await settle();
  return { frames, beforeSwap };
}

describe("useSessionDirectory — no committed frame carries the previous node's list", () => {
  afterEach(() => {
    cleanup();
  });

  it("re-addresses within the render, so the swap paints `reading` and never the old list", async () => {
    const { frames, beforeSwap } = await framesAcrossACallSwap(DirectoryFrame);
    const afterSwap = frames.slice(beforeSwap);

    // The whole sequence, and the middle term is the claim: served(old) → reading →
    // served(new), with nothing between the swap and `reading`.
    expect(frames.slice(0, beforeSwap).at(-1)).toBe(BUSY_NODE_DIRECTORY_TEXT);
    expect(afterSwap[0]).toBe("reading");
    expect(afterSwap).not.toContain(BUSY_NODE_DIRECTORY_TEXT);
    expect(afterSwap.at(-1)).toBe(EMPTY_NODE_DIRECTORY_TEXT);
  });

  it("negative control: an effect-time reset paints the old list under the new call", async () => {
    // The identical script over the shape this hook replaced. The reset runs one
    // commit late, so the frame that installs the new call carries the previous
    // bridge's session — which is a stale list under a fresh source, reading as a
    // current one. Both claims above fail here, which is what makes them claims about
    // the holder rather than about the script.
    const { frames, beforeSwap } = await framesAcrossACallSwap(EffectTimeResetFrame);
    const afterSwap = frames.slice(beforeSwap);

    expect(afterSwap[0]).not.toBe("reading");
    expect(afterSwap).toContain(BUSY_NODE_DIRECTORY_TEXT);
  });
});
