// The directory read has three answers, a surface must be able to tell them apart, and
// a replaced bridge is a different read.
//
// Every case here drives the REAL growth port — the fixture's for a served answer, the
// refusing one for a refused answer, one that REJECTS for the seam's fourth settlement
// — rather than a hand-written promise shaped like one. The hook's whole job is to turn
// one port call into the three facts a surface renders, and a stand-in port would agree
// with whatever the hook did with it.
//
// THE CASES READ WHAT EACH COMMIT CARRIED, never what a render call saw.
// `store/subject-read-commits.test-support.tsx` owns that probe and states why: this
// hook re-addresses DURING the render, and a render React discards still ran, so a log
// written from a render body shows a value no commit ever carried — under a correct
// hook as readily as under a broken one. The port-swap case below is the one input the
// previous hook got wrong, and it is a claim about a committed frame or it is nothing.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  latestCommitted,
  observeSubjectRead,
  type ObservedSubjectRead,
} from "../store/subject-read-commits.test-support.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { createRefusingGrowthPort, type GrowthPort } from "./growth-port.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import {
  offeredSessionIds,
  useSessionDirectory,
  type SessionDirectoryState,
} from "./session-directory.js";

/** The daemon refusal the rejecting port below throws, in the envelope a daemon sends. */
const SCRIPTED_DAEMON_REFUSAL = {
  code: "session.list_unavailable",
  message: "This node is not serving a session list right now.",
} as const;

/**
 * The read, driven through the commit-recording probe.
 *
 * The hook takes only a port, so the probe's subject is passed and ignored: what this
 * read is addressed by IS the port, and the probe's second axis exists for the reads
 * that also carry a session id.
 */
function observeDirectory(
  growth: GrowthPort,
): ObservedSubjectRead<GrowthPort, SessionDirectoryState> {
  return observeSubjectRead((source: GrowthPort) => useSessionDirectory(source), {
    source: growth,
    subject: undefined,
  });
}

/** The real port serving one scenario's worth of sessions, and nothing else changed. */
function portServing(sessionId: string): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    sessionList: async () => ({ status: "served", value: [{ sessionId, state: "active" }] }),
  };
}

/**
 * The real port REJECTING the directory read, which is the seam's fourth settlement.
 *
 * `fixture-session-directory.ts` throws for a scenario whose session state is outside
 * the registered six, and a scripted daemon refusal is thrown verbatim by design — so a
 * rejection is what this operation can really do rather than a shape invented here.
 */
function portRejecting(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    sessionList: () => Promise.reject(SCRIPTED_DAEMON_REFUSAL),
  };
}

/** Every session id a committed render offered, oldest commit first. */
function committedSessionIds(committed: readonly SessionDirectoryState[]): readonly string[] {
  return committed.flatMap((state) =>
    state.status === "served" ? state.sessions.map((session) => session.sessionId) : [],
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSessionDirectory — one read, three answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts as a read in flight and settles on the node's sessions", async () => {
    const probe = observeDirectory(createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth);

    // The first COMMITTED state is load-bearing: a hook that started at `served` with
    // no rows would report an empty node for a read that had not happened.
    expect(probe.committed[0]?.status).toBe("reading");

    await settle();
    const settled = latestCommitted(probe.committed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.sessions.map((session) => session.sessionId)).toStrictEqual([
        FLAGSHIP_SCENARIO.sessionId,
      ]);
    }
  });

  it("carries the refusal itself when the bridge does not serve the read", async () => {
    const probe = observeDirectory(createRefusingGrowthPort());

    await settle();
    const settled = latestCommitted(probe.committed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // The refusal names who owes the wire. A boolean here would leave the surface
      // to invent the sentence, which is how two answers to one question start.
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.detail).toContain("Not checked");
    }
  });

  it("settles a REJECTING read as the daemon's own refusal rather than reading forever", async () => {
    // The defect: the read attached a fulfilment handler alone, so a rejection went
    // unhandled and the state stayed `reading` for the life of the window — a spinner
    // over an answer that had already arrived, with no session ever offered.
    const probe = observeDirectory(portRejecting());

    await settle();
    const settled = latestCommitted(probe.committed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // The daemon's own code, verbatim: the settlement adds an arm, never a
      // vocabulary, so a refusal a daemon raised reaches the surface as its own.
      expect(settled.refusal.code).toBe(SCRIPTED_DAEMON_REFUSAL.code);
      expect(settled.refusal.detail).toBe(SCRIPTED_DAEMON_REFUSAL.message);
    }
  });

  it("reads once per mount, and not again on a re-render", async () => {
    // A directory that re-read itself on every render would be a poll wearing a
    // hook's name, and the endurance tier's churn would drive one read per cycle.
    let readCount = 0;
    const port = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth;
    const counting: GrowthPort = {
      ...port,
      sessionList: async (request) => {
        readCount += 1;
        return port.sessionList(request);
      },
    };
    const probe = observeDirectory(counting);
    await settle();
    probe.readdress({ source: counting, subject: undefined });
    await settle();

    expect(readCount).toBe(1);
    expect(latestCommitted(probe.committed).status).toBe("served");
  });
});

describe("useSessionDirectory — the port is the whole of what the read is about", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no session from the previous bridge once the port is replaced", async () => {
    // The defect, on the one input the hand-rolled holder got wrong: the fixture's
    // scenario switch mints a new bridge, and with the answer held in a `useState`
    // cleared from a mount effect, the render under the NEW port committed the
    // previous scenario's sessions. A click landing in that frame chose a session the
    // new bridge has never heard of, and the destination then scoped both workflow
    // reads to it.
    const probe = observeDirectory(portServing("session-first-scenario"));
    await settle();
    expect(committedSessionIds(probe.committed)).toStrictEqual(["session-first-scenario"]);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: portServing("session-second-scenario"), subject: undefined });

    expect(committedSessionIds(probe.committed.slice(commitsBeforeSwap))).toStrictEqual([]);
    expect(latestCommitted(probe.committed).status).toBe("reading");
  });

  it("reads the replacement bridge rather than sitting on the reset", async () => {
    // The reset is only half the claim: a hook that reset and never re-read would pass
    // the case above and leave the picker reading forever.
    const probe = observeDirectory(portServing("session-first-scenario"));
    await settle();

    probe.readdress({ source: portServing("session-second-scenario"), subject: undefined });
    await settle();

    expect(committedSessionIds([latestCommitted(probe.committed)])).toStrictEqual([
      "session-second-scenario",
    ]);
  });

  it("negative control: a re-render at the SAME port keeps the sessions it settled on", async () => {
    // Without this, the cases above pass for a hook that reset on every render, which
    // would re-read the directory forever and never show an answer at all.
    const growth = portServing("session-first-scenario");
    const probe = observeDirectory(growth);
    await settle();

    probe.readdress({ source: growth, subject: undefined });

    expect(committedSessionIds([latestCommitted(probe.committed)])).toStrictEqual([
      "session-first-scenario",
    ]);
  });
});

describe("offeredSessionIds — the union a surface offers", () => {
  it("puts the node's sessions first and appends what only this window knows", () => {
    const directory: SessionDirectoryState = {
      status: "served",
      sessions: [{ sessionId: "session-node", state: "active" }],
    };

    expect(offeredSessionIds(directory, ["session-local"])).toStrictEqual([
      "session-node",
      "session-local",
    ]);
  });

  it("names a session once when both sources hold it", () => {
    const directory: SessionDirectoryState = {
      status: "served",
      sessions: [{ sessionId: "session-both", state: "active" }],
    };

    expect(offeredSessionIds(directory, ["session-both"])).toStrictEqual(["session-both"]);
  });

  it("falls back to this window's own sessions while the directory has not answered", () => {
    // Both non-served arms, because a surface must keep offering what it can name
    // rather than blanking while a read is in flight or after one was refused.
    expect(offeredSessionIds({ status: "reading" }, ["session-local"])).toStrictEqual([
      "session-local",
    ]);
  });
});
