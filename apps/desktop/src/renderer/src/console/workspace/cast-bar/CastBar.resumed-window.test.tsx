// The bar over a window that opens partway through its session's log.
//
// THE CASE THIS FAMILY HAD NO ANSWER FOR. A session's stream replays from the position
// this participant was last acknowledged at, so a resumed read establishes a window
// whose head is somewhere in the middle of the log — and everything below that head
// exists, was never delivered here, and is not in the timeline any fold walks. An
// approval raised before that head is therefore invisible to a fold over the window,
// its count falls to zero, and the bar printed its all-clear line over a run that was
// still blocked.
//
// A SUITE OF ITS OWN rather than a case in `CastBar.absence.test.tsx`, because the
// subject is not an absence the bar renders: it is what the STORE knows about rows it
// was never sent, and every case here is written against a store whose read submitted a
// position. The absences suite is written against a window that opened at the beginning
// of the log, which is the state every other case in this family assumes.

import { describe, expect, it } from "vitest";

import { CastBar } from "./CastBar.js";
import { PARTICIPANT_PRIYA } from "../../bridge/scenarios/flagship/flagship-cast.js";
import { SESSION_ID, admittedMember, renderBar, storeWith } from "./CastBar.test-support.js";

/** The opaque position a resumed read submits. Held unread, as the store holds it. */
const ACKNOWLEDGED_CURSOR = "cursor-42";

function barOver(sessionStore: ReturnType<typeof storeWith>): HTMLElement {
  return renderBar(
    <CastBar
      sessionId={SESSION_ID}
      sessionStore={sessionStore}
      onFollow={() => {
        // The follow act is another suite's subject; this one is about the line.
      }}
    />,
  );
}

describe("CastBar — a window that opens partway through the log", () => {
  it("negative control: never prints the all-clear line over rows it was not sent", () => {
    // The resumed-window case exactly as the finding states it: the store holds only
    // the newer window, so an approval raised below its head is in no fold's input.
    const sessionStore = storeWith(
      [PARTICIPANT_PRIYA],
      [admittedMember(1, PARTICIPANT_PRIYA, "priya")],
      {
        readFromCursor: ACKNOWLEDGED_CURSOR,
      },
    );

    const bar = barOver(sessionStore);

    expect(bar.textContent).not.toContain("Nothing needs you.");
  });

  it("says which rows it could not read, and where they are read", () => {
    const sessionStore = storeWith(
      [PARTICIPANT_PRIYA],
      [admittedMember(1, PARTICIPANT_PRIYA, "priya")],
      {
        readFromCursor: ACKNOWLEDGED_CURSOR,
      },
    );

    const bar = barOver(sessionStore);

    expect(bar.textContent).toContain("Requests from before this window are not counted here.");
  });

  it("counts a blocked run the base state carried, rather than reporting it unread", () => {
    // The run entity IS the authoritative carrier: a run blocked on an approval is
    // `waiting_for_approval` on the base state the read established, whatever the
    // window's own rows say. So the bar counts it and does not print the all-clear.
    const sessionStore = storeWith(
      [PARTICIPANT_PRIYA],
      [admittedMember(1, PARTICIPANT_PRIYA, "priya")],
      {
        readFromCursor: ACKNOWLEDGED_CURSOR,
        entities: [
          {
            kind: "run",
            id: "run-below-the-head",
            state: "waiting_for_approval",
            attributedTo: PARTICIPANT_PRIYA,
          },
        ],
      },
    );

    const bar = barOver(sessionStore);

    expect(bar.textContent).not.toContain("Nothing needs you.");
    expect(bar.textContent).toContain("waiting on you");
  });

  it("prints the all-clear line where the read opened at the beginning of the log", () => {
    // The other half of the rule, and the one that keeps it from being a line every
    // session prints: a window with nothing before it has nothing it could not read.
    const sessionStore = storeWith(
      [PARTICIPANT_PRIYA],
      [admittedMember(1, PARTICIPANT_PRIYA, "priya")],
    );

    const bar = barOver(sessionStore);

    expect(bar.textContent).toContain("Nothing needs you.");
    expect(bar.textContent).not.toContain("Requests from before this window are not counted here.");
  });
});
