// What the local-runtime page does when a call REJECTS instead of answering.
//
// Every growth operation is typed to resolve — served, or refused by name — and the
// rejection channel of a promise is there whether a contract uses it or not. A
// transport that goes away mid-dispatch takes it, and so does the fixture seam that
// throws a daemon envelope verbatim rather than paraphrasing it into a growth code.
//
// THREE CLAIMS, AND THE SECOND IS THE ONE THAT COST SOMETHING. A rejection awaited
// outside the cleanup that releases the dispatch left the single-flight key HELD: the
// confirmation's primary action and its Cancel stayed disabled for the life of the
// window, so a person who pressed Stop once on a transport that had gone met a control
// that had quietly stopped working, with the reason nowhere on screen. The first claim
// is that the reason reaches the screen at all, the third that nothing is left
// unhandled — a detached async body reports its throw to nobody, so a case asserting
// only what is rendered would pass over the half of the failure `render` cannot see.
//
// AND THE READ TAKES THE SAME CHANNEL, which is why it has cases here too: a status
// read whose rejection was never settled left the region drawing "Asking the runtime"
// for the rest of the visit — rule 8's promise that an answer is still coming, made
// about a question that had already failed.

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../../core/settle.test-support.js";
import { unhandledRejectionsDuring } from "../../../core/unhandled-rejection.test-support.js";
import {
  TRANSPORT_GONE_MESSAGE,
  getButton,
  renderPage,
  type MountedDaemonPage,
} from "./daemon-page.test-support.js";

const STOP_LABEL = "Stop the local runtime";

/** The code the console synthesizes for a rejection that carried none of its own. */
const SETTLED_READ_CODE = "growth-read-call-failed";

/** Press the control, then confirm it. The page dispatches nothing until both. */
function dispatchStop(page: MountedDaemonPage): void {
  fireEvent.click(getButton(page.container, STOP_LABEL));
  fireEvent.click(getButton(page.container, STOP_LABEL));
}

function pageWithRejectingControls(): MountedDaemonPage {
  return renderPage({
    rejecting: "controls",
    rejection: new Error(TRANSPORT_GONE_MESSAGE),
  });
}

describe("DaemonPage — a control whose call rejects", () => {
  it("renders the rejection as a refusal, in the words the thrower wrote", async () => {
    const page = pageWithRejectingControls();

    dispatchStop(page);

    await waitFor(() => {
      expect(page.container.textContent).toContain(SETTLED_READ_CODE);
    });
    expect(page.container.textContent).toContain(TRANSPORT_GONE_MESSAGE);
  });

  it("releases the dispatch, so the control still works afterwards", async () => {
    // The defect, and the only assertion that can see it: the disable is rendered off
    // `inFlight`, but what actually refuses a second press is the single-flight key
    // taken in the handler's own tick. A key never given back leaves the control dead
    // for the rest of the window while the surface looks idle again.
    const page = pageWithRejectingControls();
    dispatchStop(page);
    await settle();

    dispatchStop(page);
    await settle();

    // Asserted on the LEDGER rather than on what is rendered, so the case fails on the
    // key that was never given back rather than on the refusal that never appeared:
    // the two are separate consequences of the same defect and only one of them is
    // about whether this control can be pressed again.
    expect(page.ledger.calls).toStrictEqual(["stop", "stop"]);
  });

  it("leaves no unhandled rejection behind it", async () => {
    // The half a rendered assertion cannot reach. The dispatch is a detached async
    // body, so its throw reports to no error boundary — the runner's own report is the
    // only witness that the failure was handled rather than merely invisible.
    const reported = await unhandledRejectionsDuring(async () => {
      dispatchStop(pageWithRejectingControls());
      await settle();
    });

    expect(reported).toStrictEqual([]);
  });

  it("keeps the served path saying it was sent — the control", async () => {
    // Without this the three cases above are satisfied by a page that renders a
    // refusal for every dispatch, which is the opposite failure.
    const page = renderPage({});

    dispatchStop(page);

    await waitFor(() => {
      expect(page.container.textContent).toContain("sent");
    });
    expect(page.container.textContent).not.toContain(SETTLED_READ_CODE);
  });
});

describe("DaemonPage — a status read whose call rejects", () => {
  it("renders the refusal rather than asking forever", async () => {
    const page = renderPage({
      rejecting: "status",
      rejection: new Error(TRANSPORT_GONE_MESSAGE),
    });

    await waitFor(() => {
      expect(page.container.textContent).toContain(SETTLED_READ_CODE);
    });
    expect(page.container.textContent).toContain(TRANSPORT_GONE_MESSAGE);
    expect(page.container.textContent).not.toContain("Asking the runtime");
  });

  it("leaves no unhandled rejection behind it", async () => {
    const reported = await unhandledRejectionsDuring(async () => {
      renderPage({ rejecting: "status", rejection: new Error(TRANSPORT_GONE_MESSAGE) });
      await settle();
    });

    expect(reported).toStrictEqual([]);
  });
});
