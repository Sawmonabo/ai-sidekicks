// The hook's own claims: which address a refusal belongs to, and what a press asks.
//
// `session-projection.test.ts` drives `SessionProjectionReRead` directly, which is the
// right instrument for what the class promises — that a press reaches the daemon, that
// a burst costs one read, that a refusal is the port's own. None of it needs a tree,
// and none of it sees the hook.
//
// What only a tree sees is the part the class does not hold: the answer a press gets
// when there is NOTHING to read. That answer used to be mount-lifetime `useState`, so
// a person who pressed the control before their session resolved kept "nothing was
// asked of the daemon" on screen after it did — the one arm where the surface reported
// a fact about the console as though it were a fact about the daemon, and the one the
// class-level suite structurally cannot reach, because the class is only ever built
// when both halves are present.
//
// Every clean assertion here is paired with a control that fails on the shape this
// file replaced: a refusal held for the life of the mount survives the address moving,
// so a case that only checked "the refusal appears" would have passed on both.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { growthRefusing, growthServing } from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import {
  PROJECTION_SESSION_ID,
  bridgeReadingProjection,
  settleReads,
  snapshotEnabling,
} from "./agent-console.test-support.js";
import { useSessionProjectionReRead } from "./session-projection.js";

const SECOND_SESSION_ID = "session-10";

/** The control under test, and the refusal it is currently reporting. */
function ReReadProbe(props: {
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore | undefined;
}): React.JSX.Element {
  const { requestReRead, refusal } = useSessionProjectionReRead(props.bridge, props.sessionStore);
  return (
    <section>
      <button type="button" onClick={requestReRead}>
        Ask again
      </button>
      <p data-testid="refusal">{refusal === undefined ? "none" : refusal.code}</p>
    </section>
  );
}

function pressAskAgain(): void {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
  });
}

function reportedRefusal(): string {
  return screen.getByTestId("refusal").textContent ?? "";
}

describe("session projection hook — the press with nothing to read", () => {
  it("reports the unaskable refusal rather than doing nothing", () => {
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    render(<ReReadProbe bridge={bridge} sessionStore={undefined} />);

    expect(reportedRefusal()).toBe("none");
    pressAskAgain();

    expect(reportedRefusal()).toBe("no-session");
  });

  it("drops it the moment a session arrives under the same mount", () => {
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const mounted = render(<ReReadProbe bridge={bridge} sessionStore={undefined} />);
    pressAskAgain();
    expect(reportedRefusal()).toBe("no-session");

    mounted.rerender(
      <ReReadProbe
        bridge={bridge}
        sessionStore={new SessionStore({ sessionId: PROJECTION_SESSION_ID })}
      />,
    );

    // The control can now ask, so a standing "nothing was asked" is a statement about
    // an address this mount has left. Held for the life of the mount it survived here.
    expect(reportedRefusal()).toBe("none");
  });

  it("negative control: with no session arriving the refusal stands", () => {
    // Without this, the case above would pass over a hook that dropped the refusal on
    // any re-render at all — which would erase the answer a press is owed.
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const mounted = render(<ReReadProbe bridge={bridge} sessionStore={undefined} />);
    pressAskAgain();

    mounted.rerender(<ReReadProbe bridge={bridge} sessionStore={undefined} />);

    expect(reportedRefusal()).toBe("no-session");
  });

  it("drops it when the bridge arrives, which no session id can report", () => {
    // The other half of the address, and the one a key alone cannot see: the session
    // was there the whole time and the TRANSPORT was not, so the id never moved.
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: PROJECTION_SESSION_ID });
    const mounted = render(<ReReadProbe bridge={undefined} sessionStore={sessionStore} />);
    pressAskAgain();
    expect(reportedRefusal()).toBe("no-session");

    mounted.rerender(<ReReadProbe bridge={bridge} sessionStore={sessionStore} />);

    expect(reportedRefusal()).toBe("none");
  });

  it("does not carry it across to another session", () => {
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const mounted = render(<ReReadProbe bridge={bridge} sessionStore={undefined} />);
    pressAskAgain();

    mounted.rerender(
      <ReReadProbe
        bridge={bridge}
        sessionStore={new SessionStore({ sessionId: SECOND_SESSION_ID })}
      />,
    );

    expect(reportedRefusal()).toBe("none");
  });
});

describe("session projection hook — the press that reaches the daemon", () => {
  it("asks, and reports no refusal when the read is served", async () => {
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: PROJECTION_SESSION_ID });
    render(<ReReadProbe bridge={bridge} sessionStore={sessionStore} />);
    await settleReads(bridge);

    pressAskAgain();
    await settleReads(bridge);

    expect(reportedRefusal()).toBe("none");
    expect(sessionStore.snapshot().initialised).toBe(true);
  });

  it("surfaces the port's own refusal through the hook", async () => {
    const bridge = bridgeReadingProjection(growthRefusing("sessionRead"));
    const sessionStore = new SessionStore({ sessionId: PROJECTION_SESSION_ID });
    render(<ReReadProbe bridge={bridge} sessionStore={sessionStore} />);
    await settleReads(bridge);

    pressAskAgain();
    await settleReads(bridge);

    // The port's code and not a paraphrase: the hook reports what the wire said.
    expect(reportedRefusal()).toBe("wire-unregistered");
    expect(sessionStore.snapshot().initialised).toBe(false);
  });

  it("negative control: an unpressed mount reads nothing at all", async () => {
    // Without this, the served case above would pass over a hook that read on mount —
    // a second unbidden `sessionRead` per pane, which is what the class-level suite
    // asserts against and what a hook could quietly reintroduce.
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: PROJECTION_SESSION_ID });
    render(<ReReadProbe bridge={bridge} sessionStore={sessionStore} />);
    await settleReads(bridge);

    expect(sessionStore.snapshot().initialised).toBe(false);
  });

  it("performs no read after unmount, so a closed pane holds no timer", async () => {
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: PROJECTION_SESSION_ID });
    const mounted = render(<ReReadProbe bridge={bridge} sessionStore={sessionStore} />);
    await settleReads(bridge);

    pressAskAgain();
    act(() => {
      mounted.unmount();
    });
    await settleReads(bridge);

    expect(sessionStore.snapshot().initialised).toBe(false);
  });
});
