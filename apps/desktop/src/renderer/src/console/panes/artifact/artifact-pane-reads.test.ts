// What a served, refused, or dropped answer reads as — one leg at a time.
//
// The refusal-on-served case is the load-bearing one: a growth port that ANSWERS
// `artifactList` still cannot supply a manifest row unless every member is there, and
// a leg that mapped four summary members into a thirteen-member envelope would be
// putting a `state` and a `visibility` on screen that no read established.
//
// DRIVEN AGAINST THE TWO FUNCTIONS AND NOT THROUGH THE READER, because the claim here
// is what an answer MEANS and not when it was asked for. The reader's own suite owns
// the scheduling, the join, and the generation stamp; every case below would pass or
// fail identically on a reader that never existed.
//
// NEITHER LEG CAN REJECT, which is the property the last four cases exist for: a
// bridge that dropped one call must leave the other leg's answer untouched, and the
// refusal it produces must name the leg that made the call rather than quote what came
// back off the wire.

import { describe, expect, it } from "vitest";

import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachments/attachment-policy.js";
import { readArtifactAllowlist, readArtifactList } from "./artifact-pane-reads.js";
import {
  REFUSAL,
  SERVED_SUMMARY,
  SESSION_ID,
  bridgeAnswering,
  type PortScript,
} from "./artifact-pane.test-support.js";

/** The bounds read served, so a case can assert the leg that DID answer. */
const SERVED_ALLOWLIST = {
  status: "served",
  value: { contentTypes: ["image/svg+xml"], maximumByteLength: 42 },
};

/** What an IPC disconnect leaves in the caller's hands: a rejection, not an answer. */
const DISCONNECTED = new Error("the bridge went away mid-read");

/** Both legs of one read, over a port answering whatever the case scripts. */
async function bothLegs(script: PortScript): Promise<{
  readonly artifacts: Awaited<ReturnType<typeof readArtifactList>>;
  readonly allowlist: Awaited<ReturnType<typeof readArtifactAllowlist>>;
}> {
  const bridge = bridgeAnswering(script);
  const [artifacts, allowlist] = await Promise.all([
    readArtifactList(bridge, SESSION_ID),
    readArtifactAllowlist(bridge, SESSION_ID),
  ]);
  return { artifacts, allowlist };
}

describe("artifact pane reads — a refused list and a served one", () => {
  it("carries the port's refusal verbatim rather than reporting an empty list", async () => {
    const state = await readArtifactList(
      bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      SESSION_ID,
    );
    expect(state.kind).toBe("refused");
    expect(state.kind === "refused" ? state.refusal.code : undefined).toBe("wire-unregistered");
  });

  it("reads a served manifest summary as a row, member for member", async () => {
    const state = await readArtifactList(
      bridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: REFUSAL,
      }),
      SESSION_ID,
    );
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : []).toStrictEqual([
      {
        id: "019b7b30-0280-7c11-8420-b1a5c0de2201",
        sessionId: SESSION_ID,
        runId: "019b7b30-0280-7c11-8420-b1a5c0de2202",
        createdBy: "019b7b30-0280-7c11-8420-b1a5c0de2203",
        artifactType: "diff",
        digest: "sha256:2b4c",
        size: 4096,
        annotations: { "org.opencontainers.image.title": "rate-limit-wiring.patch" },
        subject: undefined,
        visibility: "shared",
        state: "published",
        replicationStatus: "pinned",
        // Freeform provenance is typed `unknown` on the wire and drawn as a string, so
        // a non-string value is rendered in its own form rather than dropped.
        metadata: { mediaType: "text/x-patch", turnOrdinal: "12" },
        createdAt: "2026-09-02T07:00:00.000Z",
      },
    ]);
  });

  it("distinguishes a read that found none from a read nobody made", async () => {
    // Negative control for the case above: a leg that answered `not-checked` for an
    // empty served list would pass every member assertion and still be wrong about the
    // one thing an empty list says.
    const state = await readArtifactList(
      bridgeAnswering({ listAnswer: { status: "served", value: [] }, allowlistAnswer: REFUSAL }),
      SESSION_ID,
    );
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : undefined).toStrictEqual([]);
  });
});

describe("artifact pane reads — the allow-list hint", () => {
  it("falls back to the shipped default and says so, carrying the refusal", async () => {
    const allowlist = await readArtifactAllowlist(
      bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      SESSION_ID,
    );
    expect(allowlist.source).toBe("shipped-default");
    expect(allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(allowlist.refusal?.code).toBe("wire-unregistered");
  });

  it("falls back on a refusal that carries no served discriminant, and the list still settles", async () => {
    // THE SHAPE A FIXTURE AND THE LIVE PORT BOTH PRODUCE. `core`'s `refuse(...)` is
    // the console's three refusal fields and nothing else — `growthUnavailable`
    // spreads exactly that value to build its own — and a leg that asked only whether
    // `status` was `"unavailable"` read this as served, dereferenced it for
    // `contentTypes`, and turned the whole pane read into a `read-threw` carrying a
    // `TypeError`. So the two assertions that matter are the fallback arm AND the list
    // beside it: the failure this catches took both down at once.
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: {
        code: "wire-unregistered",
        detail: "Not checked — the artifact CRUD method strings are not registered yet.",
        origin: "growth-port",
      },
    });
    expect(allowlist.source).toBe("shipped-default");
    expect(allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(allowlist.refusal?.code).toBe("wire-unregistered");
    expect(artifacts.kind).toBe("listed");
  });

  it("takes the effective list wholesale when the daemon answers", async () => {
    // Wholesale, never merged: an operator override REPLACES the default, so a reading
    // that unioned the two would describe a deployment that does not exist.
    const allowlist = await readArtifactAllowlist(
      bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: SERVED_ALLOWLIST }),
      SESSION_ID,
    );
    expect(allowlist.source).toBe("effective");
    expect(allowlist.mediaTypes).toStrictEqual(["image/svg+xml"]);
    expect(allowlist.maximumByteLength).toBe(42);
  });
});

describe("artifact pane reads — one leg that did not come back", () => {
  it("keeps the manifests a rejected bounds read has nothing to say about", async () => {
    // The whole defect: the two legs used to be joined by a `Promise.all` over calls
    // that could REJECT, so a bridge that dropped only the bounds read rejected the
    // refresh and a session's manifests were discarded because an unrelated read had
    // no answer.
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: DISCONNECTED,
    });

    expect(artifacts.kind).toBe("listed");
    expect(artifacts.kind === "listed" ? artifacts.rows.length : 0).toBe(1);
    // And the leg that did not come back says so, on the arm that arm has: the shipped
    // defaults, named as such, carrying why the deployment's own were not read.
    expect(allowlist.source).toBe("shipped-default");
    expect(allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(allowlist.refusal?.code).toBe("call-rejected");
    // The leg that did not come back is named; the rejected value is not quoted into
    // the sentence, because a rejection off the wire can carry participant content.
    expect(allowlist.refusal?.detail).toContain("The attachment allow-list read");
    expect(allowlist.refusal?.detail).not.toContain(DISCONNECTED.message);
  });

  it("keeps the bounds a rejected list read has nothing to say about", async () => {
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: DISCONNECTED,
      allowlistAnswer: SERVED_ALLOWLIST,
    });

    expect(artifacts.kind).toBe("refused");
    expect(artifacts.kind === "refused" ? artifacts.refusal.code : undefined).toBe("call-rejected");
    expect(allowlist.source).toBe("effective");
    expect(allowlist.mediaTypes).toStrictEqual(["image/svg+xml"]);
  });

  it("gives each leg its own refusal when neither came back", async () => {
    // Negative control for both cases above: a fix that caught the join rather than
    // the legs would satisfy them by producing ONE refusal over both readings — and
    // the sentence a participant read would then name whichever call lost the race.
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: DISCONNECTED,
      allowlistAnswer: DISCONNECTED,
    });

    expect(artifacts.kind === "refused" ? artifacts.refusal.detail : "").toContain(
      "The artifact list",
    );
    expect(allowlist.refusal?.detail).toContain("The attachment allow-list read");
  });

  it("negative control: two answered legs each carry their own answer, unrefused", async () => {
    // Without this the cases above would pass against legs that had stopped answering
    // at all.
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: SERVED_ALLOWLIST,
    });

    expect(artifacts.kind).toBe("listed");
    expect(allowlist.source).toBe("effective");
    expect(allowlist.refusal).toBeUndefined();
  });
});
