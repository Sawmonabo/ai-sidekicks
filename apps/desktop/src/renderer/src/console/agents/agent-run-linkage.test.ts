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
