// Which frames a call swap paints, which an assertion on a settled state cannot see. A commit
// that shows the previous node's session list for one frame still ends on the right answer, and
// `act` replaces it before the DOM can be read, so `CommittedFrameRecorder` reads each commit.
//
// The negative control is a `useState` cell reset inside the effect; it must paint the old list
// under the new call, which shows the clean case discriminates. One call serves a session and
// the other serves none, so the stale frame is nameable text.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CommittedFrameRecorder } from "@test/helpers/CommittedFrameRecorder.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { useSessionDirectory } from "./useSessionDirectory.js";
import { type SessionDirectoryReadCall, type SessionDirectoryState } from "./session-directory.js";
import { NO_TRANSPORT_RECONNECT } from "@renderer/lib/transport-reconnect.js";

/**
 * Negative control: a `useState` cell reset inside the effect, so the reset runs one commit
 * after the render that installs the new call. It reads like the shipped hook, so only the
 * reset timing differs.
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

/** The negative-control hook, painted. */
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
 * Mount against one node's call, settle, swap in another node's, and settle again. One script
 * for the shipped hook and the control; frames come from `CommittedFrameRecorder` because the
 * stale frame is one commit long.
 */
async function framesAcrossACallSwap(
  DirectoryComponent: (props: { readonly read: SessionDirectoryReadCall }) => React.JSX.Element,
): Promise<CallSwapFrames> {
  const frames: string[] = [];
  const recorded = (read: SessionDirectoryReadCall): React.JSX.Element => (
    <CommittedFrameRecorder
      id="session-directory-call-swap"
      onFrame={(committedText) => {
        frames.push(committedText);
      }}
    >
      <DirectoryComponent read={read} />
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

    // served(old) -> reading -> served(new); `reading` must directly follow the swap.
    expect(frames.slice(0, beforeSwap).at(-1)).toBe(BUSY_NODE_DIRECTORY_TEXT);
    expect(afterSwap[0]).toBe("reading");
    expect(afterSwap).not.toContain(BUSY_NODE_DIRECTORY_TEXT);
    expect(afterSwap.at(-1)).toBe(EMPTY_NODE_DIRECTORY_TEXT);
  });

  it("negative control: an effect-time reset paints the old list under the new call", async () => {
    // The reset runs one commit late, so the swap frame carries the previous node's session
    // under the new call.
    const { frames, beforeSwap } = await framesAcrossACallSwap(EffectTimeResetFrame);
    const afterSwap = frames.slice(beforeSwap);

    expect(afterSwap[0]).not.toBe("reading");
    expect(afterSwap).toContain(BUSY_NODE_DIRECTORY_TEXT);
  });
});
