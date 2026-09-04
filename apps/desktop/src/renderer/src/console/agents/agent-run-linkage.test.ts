// The one relation between an agent and a run, asked directly.
//
// This selector is the console's only answer to "which run is this agent's", and
// a second consumer is about to take it, so its edges are asserted here rather
// than inferred from the one surface that renders them today: an agent with no
// run, an agent whose run belongs to somebody else, two runs of the same agent,
// and a row the projection never stamped.

import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleEntity } from "../store/index.js";
import { newestRunIdForAgent } from "./agent-run-linkage.js";

const SESSION_ID = "session-9";

function runEntity(id: string, agentId: string, touchedAt: string | undefined): ConsoleEntity {
  return touchedAt === undefined
    ? { kind: "run", id, body: { agentId } }
    : { kind: "run", id, touchedAt, body: { agentId } };
}

/** A store holding exactly the run rows a case is about, and nothing else. */
function storeHolding(...runs: readonly ConsoleEntity[]): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: runs.length, entities: [...runs], participantJoinLog: [] });
  return store;
}

describe("newest run for an agent", () => {
  it("answers the newest run the projection stamped for that agent", () => {
    const store = storeHolding(
      runEntity("run-old", "agent-scout", "2026-09-01T10:00:00.000Z"),
      runEntity("run-new", "agent-scout", "2026-09-01T11:00:00.000Z"),
    );
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-new");
  });

  it("negative control: order of arrival decides nothing, only the stamp does", () => {
    // Without this, the case above would pass over a selector that returned
    // whichever row the projection happened to hold last.
    const store = storeHolding(
      runEntity("run-new", "agent-scout", "2026-09-01T11:00:00.000Z"),
      runEntity("run-old", "agent-scout", "2026-09-01T10:00:00.000Z"),
    );
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-new");
  });

  it("ignores a run attributed to another agent", () => {
    const store = storeHolding(
      runEntity("run-theirs", "agent-other", "2026-09-01T12:00:00.000Z"),
      runEntity("run-ours", "agent-scout", "2026-09-01T10:00:00.000Z"),
    );
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-ours");
  });

  it("answers the absence for no runs, no matching run, and no agent", () => {
    expect(newestRunIdForAgent(storeHolding(), "agent-scout")).toBeUndefined();
    expect(
      newestRunIdForAgent(
        storeHolding(runEntity("run-theirs", "agent-other", "2026-09-01T12:00:00.000Z")),
        "agent-scout",
      ),
    ).toBeUndefined();
    expect(
      newestRunIdForAgent(
        storeHolding(runEntity("run-ours", "agent-scout", "2026-09-01T10:00:00.000Z")),
        undefined,
      ),
    ).toBeUndefined();
  });

  it("still reaches an unstamped row when it is the only one this agent has", () => {
    // A run the projection has not stamped sorts below every stamped row rather
    // than being dropped, so a surface is never told there is no run when there is.
    const store = storeHolding(runEntity("run-unstamped", "agent-scout", undefined));
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-unstamped");
  });
});

describe("newest run for an agent — stamps written in different offsets", () => {
  it("compares the instants and not the strings", () => {
    // The defect: `10:00+02:00` is an hour EARLIER than `09:00Z` and sorts after it
    // in every lexical comparison, so the panel read and displayed the older run as
    // this agent's newest. The event contract accepts a numeric offset as readily
    // as `Z`, so both rows below are shapes the wire can genuinely send.
    const store = storeHolding(
      runEntity("run-earlier", "agent-scout", "2026-09-01T10:00:00.000+02:00"),
      runEntity("run-later", "agent-scout", "2026-09-01T09:00:00.000Z"),
    );
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-later");
  });

  it("negative control: the same two instants in one offset still order the same way", () => {
    // Without this, the case above would pass over a selector that had merely
    // reversed its comparison — the answer has to follow the instants, not the
    // spelling.
    const store = storeHolding(
      runEntity("run-earlier", "agent-scout", "2026-09-01T08:00:00.000Z"),
      runEntity("run-later", "agent-scout", "2026-09-01T09:00:00.000Z"),
    );
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-later");
  });

  it("keeps the row it is already holding when two stamps name one instant", () => {
    // Two spellings of the same moment are not a reason to move: the fold keeps
    // what it holds, so the answer is the projection's own order rather than a
    // re-reading of it. Asserted in both arrival orders, because a tie broken by
    // anything else would answer differently in one of them.
    const inOneOrder = storeHolding(
      runEntity("run-first", "agent-scout", "2026-09-01T09:00:00.000Z"),
      runEntity("run-second", "agent-scout", "2026-09-01T11:00:00.000+02:00"),
    );
    expect(newestRunIdForAgent(inOneOrder, "agent-scout")).toBe("run-first");

    const inTheOther = storeHolding(
      runEntity("run-second", "agent-scout", "2026-09-01T11:00:00.000+02:00"),
      runEntity("run-first", "agent-scout", "2026-09-01T09:00:00.000Z"),
    );
    expect(newestRunIdForAgent(inTheOther, "agent-scout")).toBe("run-second");
  });

  it("ranks a stamp the platform cannot parse with the unstamped rows", () => {
    // Not `NaN` ordering: a comparison against `NaN` is false in both directions, so
    // a malformed row would win or lose by whichever end of the fold it landed on.
    // It sorts below every readable stamp and stays reachable when it is alone.
    const beside = storeHolding(
      runEntity("run-malformed", "agent-scout", "the day before yesterday"),
      runEntity("run-stamped", "agent-scout", "2026-09-01T09:00:00.000Z"),
    );
    expect(newestRunIdForAgent(beside, "agent-scout")).toBe("run-stamped");

    const alone = storeHolding(runEntity("run-malformed", "agent-scout", "not an instant"));
    expect(newestRunIdForAgent(alone, "agent-scout")).toBe("run-malformed");
  });

  it("negative control: a malformed stamp loses from either end of the fold", () => {
    // Without this, the case above would pass over a selector that ordered on `NaN`
    // and happened to be handed the malformed row second.
    const store = storeHolding(
      runEntity("run-stamped", "agent-scout", "2026-09-01T09:00:00.000Z"),
      runEntity("run-malformed", "agent-scout", "the day before yesterday"),
    );
    expect(newestRunIdForAgent(store, "agent-scout")).toBe("run-stamped");
  });
});
