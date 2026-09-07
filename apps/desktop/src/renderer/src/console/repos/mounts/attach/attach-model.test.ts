// What the attach form admits, what the picker offers, and what neither decides.
//
// THE TWO REFUSALS THIS MODULE MAKES ARE THE TWO THE CONTRACT'S PARSER WOULD MAKE, and
// every case below is about not making a third: no resolution, no normalisation, no
// eligibility, and no trimming on the way out.

import { describe, expect, it } from "vitest";

import { REPO_PATH_MAX_LEN, type RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import {
  attachFormVerdict,
  attachNodeOptions,
  EMPTY_ATTACH_FORM,
  NO_HEARTBEAT_YET,
  RUNTIME_NODE_ROSTER_EVENT_KINDS,
  soleNodeIdOf,
} from "./attach-model.js";

/**
 * Overrides as a case writes them.
 *
 * The wire's ids are branded and nothing in a test mints one, so the builder loosens
 * exactly those and leaves every union member exact — the shape
 * `repo-mounts.test-support.ts` uses for the same reason. `healthState` is spelled
 * nullable rather than optional because that is what the wire makes it: a node with no
 * presence row carries `null`, and `undefined` is what this module's own reader turns
 * that into.
 */
interface RosterOverrides {
  readonly nodeId?: string;
  readonly state?: RuntimeNodeRosterEntry["state"];
  readonly healthState?: RuntimeNodeRosterEntry["healthState"];
  readonly readOnly?: boolean;
}

function rosterEntry(overrides: RosterOverrides = {}): RuntimeNodeRosterEntry {
  return {
    nodeId: "9f2c4a10-0000-4000-8000-000000000002",
    participantId: "9f2c4a10-0000-4000-8000-000000000010",
    state: "online",
    healthState: "online",
    lastHeartbeatAt: "2026-01-01T09:00:00.000Z",
    readOnly: false,
    capabilities: {},
    clientVersion: "1.4",
    attachedAt: "2026-01-01T08:00:00.000Z",
    ...overrides,
  } as RuntimeNodeRosterEntry;
}

describe("attachFormVerdict — the path is met before the node", () => {
  it("asks for the path first, over an empty form", () => {
    const verdict = attachFormVerdict(EMPTY_ATTACH_FORM);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("path");
  });

  it("asks for the node once a path is named", () => {
    const verdict = attachFormVerdict({ localPath: "/Users/dev/code", nodeId: undefined });
    expect(verdict.status === "incomplete" && verdict.because).toContain("node");
  });

  it("refuses a path past the wire's own cap, and says by how much", () => {
    const tooLong = "/".repeat(REPO_PATH_MAX_LEN + 1);
    const verdict = attachFormVerdict({ localPath: tooLong, nodeId: "node-1" });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(String(REPO_PATH_MAX_LEN));
  });

  it("negative control: a path exactly at the cap is sendable", () => {
    // The guard is `>` and not `>=`, because the contract's own `max` admits the
    // boundary — a console refusing it would refuse a path the daemon accepts.
    const atCap = "/".repeat(REPO_PATH_MAX_LEN);
    expect(attachFormVerdict({ localPath: atCap, nodeId: "node-1" }).status).toBe("sendable");
  });

  it("sends what was typed, spaces and all", () => {
    // A leading or trailing space is a legal POSIX filename character. The emptiness
    // guard reads a trimmed COPY; the request carries the original.
    const verdict = attachFormVerdict({ localPath: " /Users/dev/code ", nodeId: "node-1" });
    expect(verdict.status === "sendable" && verdict.localPath).toBe(" /Users/dev/code ");
  });

  it("negative control: whitespace alone is not a path", () => {
    expect(attachFormVerdict({ localPath: "   ", nodeId: "node-1" }).status).toBe("incomplete");
  });
});

describe("attachNodeOptions — every node the roster named, unfiltered", () => {
  it("offers a revoked, offline, read-only node exactly as the roster gave it", () => {
    // `Spec-003 §Acceptance Criteria` requires degraded and offline nodes visible and
    // distinguishable. Dropping them would make a refusable attach look impossible.
    const options = attachNodeOptions([
      rosterEntry({ nodeId: "node-a", state: "offline", healthState: "offline" }),
      rosterEntry({ nodeId: "node-b", state: "revoked", readOnly: true }),
    ]);
    expect(options.map((option) => option.nodeId)).toStrictEqual(["node-a", "node-b"]);
    expect(options[1]?.readOnly).toBe(true);
  });

  it("keeps the two health axes apart", () => {
    // A slot reading `online` beside a presence reading `offline` is a real and
    // reportable disagreement; collapsing them picks which to believe.
    const [option] = attachNodeOptions([rosterEntry({ state: "online", healthState: "offline" })]);
    expect(option?.state).toBe("online");
    expect(option?.healthState).toBe("offline");
  });

  it("says a node has never beat rather than calling it healthy", () => {
    const [option] = attachNodeOptions([rosterEntry({ healthState: null })]);
    expect(option?.healthState).toBe(NO_HEARTBEAT_YET);
  });

  it("negative control: does not reorder what the daemon returned", () => {
    const options = attachNodeOptions([
      rosterEntry({ nodeId: "node-z", state: "offline" }),
      rosterEntry({ nodeId: "node-a", state: "online" }),
    ]);
    expect(options.map((option) => option.nodeId)).toStrictEqual(["node-z", "node-a"]);
  });
});

describe("soleNodeIdOf", () => {
  it("pre-picks when the roster leaves no choice to make", () => {
    expect(soleNodeIdOf(attachNodeOptions([rosterEntry({ nodeId: "only" })]))).toBe("only");
  });

  it("negative control: picks nothing when there is a real decision", () => {
    // Pre-picking here would choose quietly and be wrong exactly when the path is on
    // the other machine.
    const options = attachNodeOptions([
      rosterEntry({ nodeId: "node-a" }),
      rosterEntry({ nodeId: "node-b" }),
    ]);
    expect(soleNodeIdOf(options)).toBeUndefined();
    expect(soleNodeIdOf([])).toBeUndefined();
  });
});

describe("RUNTIME_NODE_ROSTER_EVENT_KINDS", () => {
  it("is derived from the contract's census rather than hand-listed", () => {
    expect(RUNTIME_NODE_ROSTER_EVENT_KINDS.size).toBeGreaterThan(0);
    for (const kind of RUNTIME_NODE_ROSTER_EVENT_KINDS) {
      expect(kind.startsWith("runtime_node.")).toBe(true);
    }
  });

  it("negative control: names no repo frame, which is the mounts reader's census", () => {
    // A roster that re-read on a repo frame would read on every attach the section
    // already re-read for, and still miss a node going offline.
    expect(RUNTIME_NODE_ROSTER_EVENT_KINDS.has("repo.mount_attached")).toBe(false);
  });
});
