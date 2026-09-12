// What the attach form admits, what the picker offers, and what neither decides.
//
// THE TWO REFUSALS THIS MODULE MAKES ARE THE TWO THE CONTRACT'S PARSER WOULD MAKE, and
// every case below is about not making a third: no resolution, no normalisation, no
// eligibility, and no trimming on the way out.

import { describe, expect, it } from "vitest";

import { REPO_PATH_MAX_LEN } from "@ai-sidekicks/contracts";

import {
  attachNodeOptions,
  EMPTY_ATTACH_FORM,
  NO_HEARTBEAT_YET,
  resolveAttachForm,
  RUNTIME_NODE_ROSTER_EVENT_KINDS,
  soleNodeIdOf,
  type AttachFormState,
  type AttachFormVerdict,
  type AttachNodeOption,
} from "./attach-model.js";
import { rosterEntry } from "./attach-roster.test-support.js";

/** Two nodes the roster is serving, which is a real decision for a participant. */
const SERVED_NODES: readonly AttachNodeOption[] = attachNodeOptions([
  rosterEntry({ nodeId: "node-1" }),
  rosterEntry({ nodeId: "node-2" }),
]);

/** The verdict for one form read against a roster, which is the only way to get one. */
function verdictFor(
  form: AttachFormState,
  servedNodes: readonly AttachNodeOption[] | undefined = SERVED_NODES,
): AttachFormVerdict {
  return resolveAttachForm(form, servedNodes).verdict;
}

describe("resolveAttachForm — the path is met before the node", () => {
  it("asks for the path first, over an empty form", () => {
    const verdict = verdictFor(EMPTY_ATTACH_FORM);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("path");
  });

  it("asks for the node once a path is named", () => {
    const verdict = verdictFor({ localPath: "/Users/dev/code", nodeId: undefined });
    expect(verdict.status === "incomplete" && verdict.because).toContain("node");
  });

  it("refuses a path past the wire's own cap, and says by how much", () => {
    const tooLong = "/".repeat(REPO_PATH_MAX_LEN + 1);
    const verdict = verdictFor({ localPath: tooLong, nodeId: "node-1" });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(String(REPO_PATH_MAX_LEN));
  });

  it("negative control: a path exactly at the cap is sendable", () => {
    // The guard is `>` and not `>=`, because the contract's own `max` admits the
    // boundary — a console refusing it would refuse a path the daemon accepts.
    const atCap = "/".repeat(REPO_PATH_MAX_LEN);
    expect(verdictFor({ localPath: atCap, nodeId: "node-1" }).status).toBe("sendable");
  });

  it("sends what was typed, spaces and all", () => {
    // A leading or trailing space is a legal POSIX filename character. The emptiness
    // guard reads a trimmed COPY; the request carries the original.
    const verdict = verdictFor({ localPath: " /Users/dev/code ", nodeId: "node-1" });
    expect(verdict.status === "sendable" && verdict.localPath).toBe(" /Users/dev/code ");
  });

  it("negative control: whitespace alone is not a path", () => {
    expect(verdictFor({ localPath: "   ", nodeId: "node-1" }).status).toBe("incomplete");
  });
});

describe("resolveAttachForm — the roster decides which node this form is on", () => {
  it("resolves the sole node without a press, and opens the control with it", () => {
    // The state this fix was written for: the picker drew the sole node checked while
    // the verdict read a form that had never held it, so a complete form sat behind a
    // control that would not send — and pressing the already-checked radio emits no
    // change event, so there was no way out of it.
    const sole = attachNodeOptions([rosterEntry({ nodeId: "node-only" })]);
    const resolution = resolveAttachForm({ localPath: "/Users/dev/code", nodeId: undefined }, sole);
    expect(resolution.selectedNodeId).toBe("node-only");
    expect(resolution.verdict).toStrictEqual({
      status: "sendable",
      localPath: "/Users/dev/code",
      nodeId: "node-only",
    });
  });

  it("negative control: two nodes leave the choice unmade and the control shut", () => {
    const resolution = resolveAttachForm(
      { localPath: "/Users/dev/code", nodeId: undefined },
      SERVED_NODES,
    );
    expect(resolution.selectedNodeId).toBeUndefined();
    expect(resolution.verdict.status).toBe("incomplete");
  });

  it("clears a picked node the roster no longer names, and says why", () => {
    // A refresh that removes the picked node used to leave the form holding its id, the
    // picker showing nothing checked, and the control open over a node that had gone.
    const remaining = attachNodeOptions([rosterEntry({ nodeId: "node-1" })]);
    const resolution = resolveAttachForm(
      { localPath: "/Users/dev/code", nodeId: "node-2" },
      remaining,
    );
    expect(resolution.selectedNodeId).toBeUndefined();
    expect(resolution.verdict.status).toBe("incomplete");
    expect(resolution.verdict.status === "incomplete" && resolution.verdict.because).toContain(
      "no longer on this session's roster",
    );
  });

  it("does not substitute the sole survivor for a node that was picked", () => {
    // The quiet failure the sentence above exists instead of: attaching on whichever
    // machine happens to be left is not the act the participant asked for.
    const remaining = attachNodeOptions([rosterEntry({ nodeId: "node-1" })]);
    const { verdict } = resolveAttachForm(
      { localPath: "/Users/dev/code", nodeId: "node-2" },
      remaining,
    );
    expect(verdict.status).not.toBe("sendable");
  });

  it("holds a picked node unconfirmed while the roster has not answered", () => {
    // Different fact, different sentence: a refused re-read cannot say the node is gone.
    const { verdict } = resolveAttachForm(
      { localPath: "/Users/dev/code", nodeId: "node-2" },
      undefined,
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("have not answered");
  });
});

describe("attachNodeOptions — every node the roster named, unfiltered", () => {
  it("offers a revoked, offline, read-only node exactly as the roster gave it", () => {
    // Degraded and offline nodes stay visible and distinguishable. Dropping them
    // would make a refusable attach look impossible.
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
    expect(RUNTIME_NODE_ROSTER_EVENT_KINDS.length).toBeGreaterThan(0);
    for (const kind of RUNTIME_NODE_ROSTER_EVENT_KINDS) {
      expect(kind.startsWith("runtime_node.")).toBe(true);
    }
  });

  it("negative control: names no repo frame, which is the mounts reader's census", () => {
    // A roster that re-read on a repo frame would read on every attach the section
    // already re-read for, and still miss a node going offline.
    expect(RUNTIME_NODE_ROSTER_EVENT_KINDS).not.toContain("repo.mount_attached");
  });

  it("is data, so a controller that builds a set from it holds its own", () => {
    // The census left this module as a `ReadonlySet` once, which is one mutable object
    // shared by every controller in the window: the annotation hides `add` from a
    // reader and from nothing at runtime. Two controllers over one census must not be
    // able to reach each other's trigger set, and the census itself must not be
    // reachable through either of them.
    const first = new Set<string>(RUNTIME_NODE_ROSTER_EVENT_KINDS);
    const second = new Set<string>(RUNTIME_NODE_ROSTER_EVENT_KINDS);
    first.add("runtime_node.invented_by_a_caller");

    expect(second.has("runtime_node.invented_by_a_caller")).toBe(false);
    expect(RUNTIME_NODE_ROSTER_EVENT_KINDS).not.toContain("runtime_node.invented_by_a_caller");
  });
});
