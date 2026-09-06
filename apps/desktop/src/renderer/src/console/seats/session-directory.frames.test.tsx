// Which frames a port swap paints, which no assertion on a settled state can see.
//
// The hook's sibling suite reads STATES — the three answers one read settles on — and
// this one reads FRAMES. They are different claims: a hook that reached the right
// final answer by way of one commit showing the previous node's session list would
// satisfy every case next door, and that commit is exactly the defect. It is one
// frame long, and `act` has already replaced it by the time an assertion could look
// at the DOM, so the reading is `CommittedFrameRecorder` — a `Profiler` over the
// tree, called once per commit, before any passive effect runs.
//
// The control is the shape this hook replaced: a `useState` cell reset from the first
// statement of the effect body. That reset cannot run before the commit of the render
// that installed the new port, so the swap paints the previous bridge's list under
// the new source — a stale list reading as a current one. It is kept runnable here
// and asserted to do exactly that, which is what makes the clean case a claim about
// the holder rather than about the script.
//
// TWO SHIPPED SCENARIOS, NOT A HAND-WRITTEN PORT. The flagship node serves one
// session and the first-run node serves none — it declares its own session
// `provisioning`, which the directory does not show — so the two ports answer
// differently and the stale frame is nameable text rather than an inferred state.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  growthUnavailableFromRejection,
  type GrowthPort,
} from "../bridge/index.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { CommittedFrameRecorder } from "../core/committed-frame.test-support.js";
import { drainMicrotasks } from "../core/microtask-drain.test-support.js";
import { useSessionDirectory, type SessionDirectoryState } from "./session-directory.js";

/**
 * The shape this hook replaced: a `useState` cell reset from inside the effect.
 *
 * Not a stand-in for the holder — it is the OLD code, kept only so the frame claim
 * above it is shown to discriminate. The reset is the first statement of the effect
 * body, so it cannot run before the commit of the render that installed the new port,
 * and the mounted latch is the boolean the holder's publisher replaced.
 */
function useSessionDirectoryWithEffectTimeReset(growth: GrowthPort): SessionDirectoryState {
  const [state, setState] = useState<SessionDirectoryState>({ status: "reading" });
  useEffect(() => {
    setState({ status: "reading" });
    let isMounted = true;
    void growth.sessionList({}).then(
      (outcome) => {
        if (!isMounted) {
          return;
        }
        setState(
          outcome.status === "served"
            ? { status: "served", sessions: outcome.value }
            : { status: "unavailable", refusal: outcome },
        );
      },
      (rejection: unknown) => {
        if (!isMounted) {
          return;
        }
        setState({
          status: "unavailable",
          refusal: growthUnavailableFromRejection("sessionList", rejection),
        });
      },
    );
    return () => {
      isMounted = false;
    };
  }, [growth]);
  return state;
}

/** What a served flagship directory paints, so the stale frame is nameable text. */
const FLAGSHIP_DIRECTORY_TEXT = `served: ${FLAGSHIP_SCENARIO.sessionId}`;

/** What the first-run node paints: it declares a session no directory shows. */
const FIRST_RUN_DIRECTORY_TEXT = "served: (none)";

/** One reading as one line, so a committed frame is comparable as text. */
function directoryText(state: SessionDirectoryState): string {
  if (state.status === "reading") {
    return "reading";
  }
  if (state.status === "unavailable") {
    return `unavailable: ${state.refusal.code}`;
  }
  const sessionIds = state.sessions.map((session) => session.sessionId);
  return `served: ${sessionIds.length === 0 ? "(none)" : sessionIds.join(", ")}`;
}

/** The shipped hook, painted. */
function DirectoryFrame(props: { readonly growth: GrowthPort }): React.JSX.Element {
  return <output>{directoryText(useSessionDirectory(props.growth))}</output>;
}

/** The pre-holder hook, painted — the same surface over the shape this replaced. */
function EffectTimeResetFrame(props: { readonly growth: GrowthPort }): React.JSX.Element {
  return <output>{directoryText(useSessionDirectoryWithEffectTimeReset(props.growth))}</output>;
}

/** Let the directory read settle, so an assertion is about the answer. */
async function settle(): Promise<void> {
  await act(async () => {
    await drainMicrotasks();
  });
}

/** Every committed frame one mount painted, and how many came before the port moved. */
interface PortSwapFrames {
  readonly frames: readonly string[];
  readonly beforeSwap: number;
}

/**
 * Mount against one node's port, settle, swap in another node's, and settle again.
 *
 * One script for both the shipped hook and the shape it replaced, so the control
 * differs from the claim by the hook alone. The frames are read through
 * `CommittedFrameRecorder` rather than off the DOM because the frame at issue is one
 * commit long: `act` has already replaced it by the time an assertion could look.
 */
async function framesAcrossAPortSwap(
  Surface: (props: { readonly growth: GrowthPort }) => React.JSX.Element,
): Promise<PortSwapFrames> {
  const frames: string[] = [];
  const recorded = (growth: GrowthPort): React.JSX.Element => (
    <CommittedFrameRecorder
      id="session-directory-port-swap"
      onFrame={(committedText) => {
        frames.push(committedText);
      }}
    >
      <Surface growth={growth} />
    </CommittedFrameRecorder>
  );
  const view = render(recorded(createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth));
  await settle();
  const beforeSwap = frames.length;
  act(() => {
    view.rerender(recorded(createFixtureBridge({ scenario: FIRST_RUN_SCENARIO }).growth));
  });
  await settle();
  return { frames, beforeSwap };
}

describe("useSessionDirectory — no committed frame carries the previous node's list", () => {
  afterEach(() => {
    cleanup();
  });

  it("re-addresses within the render, so the swap paints `reading` and never the old list", async () => {
    const { frames, beforeSwap } = await framesAcrossAPortSwap(DirectoryFrame);
    const afterSwap = frames.slice(beforeSwap);

    // The whole sequence, and the middle term is the claim: served(old) → reading →
    // served(new), with nothing between the swap and `reading`.
    expect(frames.slice(0, beforeSwap).at(-1)).toBe(FLAGSHIP_DIRECTORY_TEXT);
    expect(afterSwap[0]).toBe("reading");
    expect(afterSwap).not.toContain(FLAGSHIP_DIRECTORY_TEXT);
    expect(afterSwap.at(-1)).toBe(FIRST_RUN_DIRECTORY_TEXT);
  });

  it("negative control: the effect-time reset paints the old node's list under the new port", async () => {
    // The identical script over the shape this hook replaced. The reset runs one
    // commit late, so the frame that installs the new port carries the previous
    // bridge's session — which is a stale list under a fresh source, reading as a
    // current one. Both claims above fail here, which is what makes them claims about
    // the holder rather than about the script.
    const { frames, beforeSwap } = await framesAcrossAPortSwap(EffectTimeResetFrame);
    const afterSwap = frames.slice(beforeSwap);

    expect(afterSwap[0]).not.toBe("reading");
    expect(afterSwap).toContain(FLAGSHIP_DIRECTORY_TEXT);
  });
});
