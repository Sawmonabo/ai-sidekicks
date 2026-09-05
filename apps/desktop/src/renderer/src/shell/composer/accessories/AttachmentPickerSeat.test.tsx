// What the picker says, and which session it is saying it about.
//
// The read is driven through the real growth port with one operation replaced by a
// deferred stand-in, which is the fixture port's own composition — a whole port
// written by hand would agree with whatever this component did with it, and the
// settlement TIMING is the subject of half these cases, so it has to be the case's
// to decide.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AttachmentPickerSeat } from "./AttachmentPickerSeat.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
  type GrowthPort,
} from "../../../console/bridge/index.js";
import { drainMicrotasks } from "../../../console/bridge/fixture-bridge.test-support.js";

const SESSION_ONE = COMPOSER_SCENARIO.sessionId;
const SESSION_TWO = "019b7a33-3300-75e5-8520-ada11a5a55b6";

type AllowListRead = GrowthPort["artifactAllowlistRead"];
type AllowListValue = {
  readonly contentTypes: readonly string[];
  readonly maximumByteLength: number;
};

/** One outstanding read, held open until the case says what it answered. */
interface OutstandingRead {
  readonly sessionId: string;
  readonly answer: (value: AllowListValue) => void;
}

/**
 * A read that answers nothing until the case settles it, remembering which session
 * each call asked about.
 *
 * Every call is kept, not only the newest: the rebind cases settle a read the
 * PREVIOUS session opened, and a stand-in holding one resolver could not express
 * that at all.
 */
function deferredAllowListReads(): {
  readonly read: AllowListRead;
  readonly outstanding: readonly OutstandingRead[];
} {
  const outstanding: OutstandingRead[] = [];
  const read: AllowListRead = (request) =>
    new Promise((resolve) => {
      outstanding.push({
        sessionId: request.sessionId,
        answer: (value) => {
          resolve({ status: "served", value });
        },
      });
    });
  return { read, outstanding };
}

/** The fixture bridge with exactly one operation replaced. */
function bridgeReadingAllowListWith(read: AllowListRead): ConsoleBridge {
  const fixture = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  return { ...fixture, growth: { ...fixture.growth, artifactAllowlistRead: read } };
}

/** Mount the seat against a session the case can swap. */
function mountSeat(
  bridge: ConsoleBridge,
  sessionId: string,
): { readonly rebindTo: (nextSessionId: string) => void } {
  const view = render(<AttachmentPickerSeat bridge={bridge} sessionId={sessionId} />);
  return {
    rebindTo: (nextSessionId) => {
      view.rerender(<AttachmentPickerSeat bridge={bridge} sessionId={nextSessionId} />);
    },
  };
}

/** Press the control that opens the read. */
function pressAttach(): void {
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
}

const SESSION_ONE_ALLOWS: AllowListValue = {
  contentTypes: ["text/markdown"],
  maximumByteLength: 1024,
};
const SESSION_TWO_ALLOWS: AllowListValue = {
  contentTypes: ["image/png"],
  maximumByteLength: 2048,
};

describe("the picker asks before it offers", () => {
  it("renders the served reading for the session it asked about", async () => {
    const reads = deferredAllowListReads();
    mountSeat(bridgeReadingAllowListWith(reads.read), SESSION_ONE);
    pressAttach();
    expect(screen.getByText("Reading what this session accepts.")).not.toBeNull();
    await act(async () => {
      reads.outstanding[0]?.answer(SESSION_ONE_ALLOWS);
      await drainMicrotasks();
    });
    expect(screen.getByText(/text\/markdown/)).not.toBeNull();
  });

  it("renders the refusal verbatim rather than opening a dialog", async () => {
    const bridge = bridgeReadingAllowListWith(async () =>
      growthUnavailable("artifactAllowlistRead"),
    );
    mountSeat(bridge, SESSION_ONE);
    pressAttach();
    await act(async () => {
      await drainMicrotasks();
    });
    expect(screen.getByText(growthUnavailable("artifactAllowlistRead").code)).not.toBeNull();
  });
});

describe("the reading belongs to the session it was read for", () => {
  it("forgets the previous session's reading the moment the composer is rebound", async () => {
    // The failure this closes: the menu stays open across a rebind, and the picker
    // went on claiming that the new session accepts the old one's content types and
    // byte limit — with nothing on screen saying which session had been asked.
    const reads = deferredAllowListReads();
    const seat = mountSeat(bridgeReadingAllowListWith(reads.read), SESSION_ONE);
    pressAttach();
    await act(async () => {
      reads.outstanding[0]?.answer(SESSION_ONE_ALLOWS);
      await drainMicrotasks();
    });
    expect(screen.getByText(/text\/markdown/)).not.toBeNull();

    seat.rebindTo(SESSION_TWO);
    expect(screen.queryByText(/text\/markdown/)).toBeNull();
    expect(screen.queryByText("Reading what this session accepts.")).toBeNull();
  });

  it("drops a read that settles after the composer moved on", async () => {
    const reads = deferredAllowListReads();
    const seat = mountSeat(bridgeReadingAllowListWith(reads.read), SESSION_ONE);
    pressAttach();
    seat.rebindTo(SESSION_TWO);
    await act(async () => {
      reads.outstanding[0]?.answer(SESSION_ONE_ALLOWS);
      await drainMicrotasks();
    });
    expect(reads.outstanding[0]?.sessionId).toBe(SESSION_ONE);
    expect(screen.queryByText(/text\/markdown/)).toBeNull();
  });

  it("negative control: the new session's own read is offered", async () => {
    // Without this, a picker that answered the unasked state unconditionally would
    // pass both cases above and never offer anything again after a rebind.
    const reads = deferredAllowListReads();
    const seat = mountSeat(bridgeReadingAllowListWith(reads.read), SESSION_ONE);
    seat.rebindTo(SESSION_TWO);
    pressAttach();
    await act(async () => {
      reads.outstanding.at(-1)?.answer(SESSION_TWO_ALLOWS);
      await drainMicrotasks();
    });
    expect(reads.outstanding.at(-1)?.sessionId).toBe(SESSION_TWO);
    expect(screen.getByText(/image\/png/)).not.toBeNull();
  });
});
