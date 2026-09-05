// The reductions one reading makes on the next, driven with no bridge and no clock.
//
// Each case is about a claim the pane would otherwise make falsely: that a read
// answered for a row it did not name, that a row the list never carried belongs to the
// session, or that a refusal still stands after the act it refused was answered.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import type { ArtifactManifestRow, ArtifactsPanelState } from "../artifacts/artifact-model.js";
import {
  NOTHING_READ_YET,
  growthAnswerReading,
  readFailureRefusal,
  withReplacedRow,
  withRowRefusal,
  withoutRow,
  withoutRowRefusal,
} from "./artifact-pane-reading.js";

function row(id: string, state: ArtifactManifestRow["state"]): ArtifactManifestRow {
  return {
    id,
    sessionId: "session-1",
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 4096,
    annotations: {},
    visibility: "shared",
    state,
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  };
}

const REFUSAL = refuse("growth-port", "wire-unregistered", "Not checked.");

describe("artifact pane reading — replacing a row from its own read", () => {
  it("replaces the row the read named and leaves its neighbours alone", () => {
    const listed: ArtifactsPanelState = {
      kind: "listed",
      rows: [row("first", "published"), row("second", "published")],
    };
    const next = withReplacedRow(listed, row("second", "superseded"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.state) : []).toStrictEqual([
      "published",
      "superseded",
    ]);
  });

  it("negative control: a row the list does not carry is not added to it", () => {
    // Without this, a single-artifact read would be able to claim a session
    // membership that no list read established.
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withReplacedRow(listed, row("elsewhere", "published"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withReplacedRow({ kind: "not-checked" }, row("first", "published"))).toStrictEqual({
      kind: "not-checked",
    });
  });
});

describe("artifact pane reading — what a row's last act answered", () => {
  it("records a refusal against the row it was about", () => {
    const recorded = withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL);
    expect(recorded.get("first")).toStrictEqual(REFUSAL);
    expect(NOTHING_READ_YET.refusalByArtifactId.size).toBe(0);
  });

  it("clears the refusal once an act answered for that row", () => {
    const recorded = withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL);
    expect(withoutRowRefusal(recorded, "first").has("first")).toBe(false);
  });

  it("negative control: clearing one row's refusal leaves another's standing", () => {
    const both = withRowRefusal(
      withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL),
      "second",
      REFUSAL,
    );
    const remaining = withoutRowRefusal(both, "first");
    expect(remaining.has("first")).toBe(false);
    expect(remaining.has("second")).toBe(true);
  });
});

describe("artifact pane reading — a read that threw", () => {
  it("names this reader as the origin and never quotes the rejected value", () => {
    // The sentence names the leg and stops there: a rejection off the wire can carry
    // participant content as readily as a schema failure can. The copy this replaces
    // interpolated `error.message` into it.
    const refusal = readFailureRefusal(new Error("/Users/someone/secret-branch"));
    expect(refusal.code).toBe("read-threw");
    expect(refusal.origin).toBe("artifact-pane-reader");
    expect(refusal.detail).not.toContain("secret-branch");
  });

  it("keeps a daemon envelope's dotted code, its own words, and its retry hint", () => {
    // The arm the three-arm copy did not have: everything arrived as `read-threw`
    // with the daemon's code and sentence discarded, so a 403 and a rate limit read
    // the same and neither said what to do next.
    const refusal = readFailureRefusal({
      message: "Deleting this artifact is not permitted.",
      data: { type: "artifact.delete_forbidden", fields: { retryAfter: 30 } },
    });
    expect(refusal.code).toBe("artifact.delete_forbidden");
    expect(refusal.detail).toBe("Deleting this artifact is not permitted.");
    expect(refusal.retry?.afterSeconds).toBe(30);
  });

  it("keeps the origin a refusal thrown across the bridge already named", () => {
    // Structural rather than `instanceof`: the value crossed a realm, so its
    // prototype chain is gone and an `instanceof` reading would silently replace the
    // author's origin with this pane's.
    const refusal = readFailureRefusal({
      refusal: { origin: "growth-port", code: "wire-unregistered", detail: "Not checked." },
    });
    expect(refusal.origin).toBe("growth-port");
    expect(refusal.code).toBe("wire-unregistered");
  });

  it("negative control: a value whose `message` getter throws does not escape", () => {
    // This function runs inside the scheduler's `onError`, which is the one handler
    // that exists so a failure is never swallowed. A throw from here would be a
    // second failure raised while reporting the first, outside every `catch`.
    const hostile = {
      get message(): string {
        throw new Error("read me and see");
      },
    };
    const refusal = readFailureRefusal(hostile);
    expect(refusal.origin).toBe("artifact-pane-reader");
    expect(refusal.detail.length).toBeGreaterThan(0);
  });
});

describe("artifact pane reading — removing a row a delete answered for", () => {
  it("drops the row the delete named and keeps the rest", () => {
    const listed: ArtifactsPanelState = {
      kind: "listed",
      rows: [row("first", "published"), row("second", "published")],
    };
    const next = withoutRow(listed, "first");
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual([
      "second",
    ]);
  });

  it("negative control: a delete for a row not on the list removes nothing", () => {
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withoutRow(listed, "elsewhere");
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withoutRow({ kind: "loading" }, "first")).toStrictEqual({ kind: "loading" });
  });
});

describe("artifact pane reading — reading one port answer", () => {
  it("reads the port's own refusal, keeping the code and the sentence it carries", () => {
    const answer = growthAnswerReading("The allow-list read", {
      ...REFUSAL,
      status: "unavailable",
      code: "wire-unregistered",
      operationId: "artifactAllowlistRead",
      slateRow: "artifact-crud",
      owningDocument: "attachments",
    } as never);
    expect(answer.status).toBe("refused");
    expect(answer.status === "refused" ? answer.refusal : undefined).toMatchObject({
      code: "wire-unregistered",
      origin: "growth-port",
    });
  });

  it("reads a refusal that carries no served discriminant", () => {
    // THE CASE THE OLD NARROWING GOT WRONG, and the reason this function exists. A
    // refusal built by `core`'s `refuse(...)` has the console's three refusal fields
    // and no `status` at all — which is the value `growthUnavailable` spreads to build
    // its own. Read as "not unavailable, therefore served", it was dereferenced for a
    // `value` it does not carry and the pane published a `TypeError` in place of the
    // refusal that had just told it why.
    const answer = growthAnswerReading("The allow-list read", REFUSAL as never);
    expect(answer.status).toBe("refused");
    expect(answer.status === "refused" ? answer.refusal : undefined).toBe(REFUSAL);
  });

  it("reads a served answer's value through untouched", () => {
    const served = { contentTypes: ["text/plain"], maximumByteLength: 42 };
    const answer = growthAnswerReading("The allow-list read", {
      status: "served",
      value: served,
    });
    expect(answer.status).toBe("read");
    expect(answer.status === "read" ? answer.value : undefined).toBe(served);
  });

  it("negative control: a served answer whose VALUE looks like a refusal is still read", () => {
    // Without this, recognising a refusal by its fields could be written to look
    // anywhere in the reply and would refuse a perfectly good read whose payload
    // happened to carry a code, a detail, and an origin. The shape test is about the
    // ANSWER and never about what the answer is carrying.
    const answer = growthAnswerReading("The manifest re-read", {
      status: "served",
      value: REFUSAL,
    });
    expect(answer.status).toBe("read");
    expect(answer.status === "read" ? answer.value : undefined).toBe(REFUSAL);
  });

  it("refuses a reply that is neither, naming the operation and not the reply", () => {
    // Total rather than throwing: a reply of an unexpected shape is a fact a person
    // can act on, and an exception three frames from where the answer arrived is not.
    const answer = growthAnswerReading("The delete", { status: "served" } as never);
    expect(answer.status).toBe("refused");
    const refusal = answer.status === "refused" ? answer.refusal : undefined;
    expect(refusal?.code).toBe("reply-unreadable");
    expect(refusal?.origin).toBe("artifact-pane-reader");
    expect(refusal?.detail).toContain("The delete");
  });
});
