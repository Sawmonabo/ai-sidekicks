// The session the browser hands the conversational start, and the nothing it hands
// where there is none.
//
// Spied, never replaced, `ConsoleRoot.test.tsx`'s instrument: the start slot carries
// no body anywhere in this repository, so what the browser handed it reaches no
// rendered markup and there is no other way to read it back. The real wrapper still
// renders, which is why the reserved area is still assertable beside it — and why the
// spy lives here rather than in the shared harness, where it would be installed for
// three suites that make no claim about the mount.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { ChatStartSlot } from "./ChatStartSlot.js";
import {
  PROBE_SESSION_ID,
  browserUnderAnnouncer,
  renderBrowser,
  settle,
} from "./WorkflowsBrowser.test-support.js";

vi.mock(import("./ChatStartSlot.js"), { spy: true });

describe("the workflows browser — the session it hands the conversational start", () => {
  afterEach(() => {
    cleanup();
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(ChatStartSlot).mockClear();
  });

  /** The sessions the port was actually asked about, in the order it was asked. */
  function recordingPort(readSessions: string[]): GrowthPort {
    return {
      ...createRefusingGrowthPort(),
      workflowDefinitionList: async (request) => {
        readSessions.push(request.sessionId);
        return { status: "served", value: { definitions: [] } };
      },
    };
  }

  it("hands the start the same session it read the enumeration under", async () => {
    const readSessions: string[] = [];
    renderBrowser(recordingPort(readSessions));

    await settle();

    // Both halves off the real thing: the left is what the port was asked, the right
    // is what the mount received. A browser that dropped the session would still read
    // the enumeration and hand the start nothing, and only the right half would move.
    expect(readSessions).toStrictEqual([PROBE_SESSION_ID]);
    expect(vi.mocked(ChatStartSlot).mock.calls[0]?.[0]).toStrictEqual({
      sessionId: PROBE_SESSION_ID,
    });
  });

  it("hands over the same nothing it read under, where no session is in scope", async () => {
    // A bare rail address puts no question — the enumeration's request carries a
    // required session id — and the mount is told exactly that rather than being
    // handed a key that was quietly dropped.
    const readSessions: string[] = [];
    render(browserUnderAnnouncer(recordingPort(readSessions), undefined));

    await settle();

    expect(readSessions).toStrictEqual([]);
    expect(vi.mocked(ChatStartSlot).mock.calls[0]?.[0]).toStrictEqual({ sessionId: undefined });
  });

  it("negative control: the wrapper really rendered, so the cases above are not vacuous", async () => {
    // The spy would record a call for a mount that was composed and never rendered.
    // This reads the wrapper's own reserved copy off the markup instead.
    const container = renderBrowser(recordingPort([]));

    await settle();

    expect(container.textContent ?? "").toContain("the composer's own affordance");
  });
});
