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

import { growthUnavailable } from "../../bridge/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../attachments/attachment-policy.js";
import { readArtifactAllowlist, readArtifactList } from "./artifact-pane-reads.js";
import {
  SERVED_SUMMARY,
  SESSION_ID,
  artifactBridgeAnswering,
  type ArtifactPortScript,
  type GrowthPortAnswer,
} from "./artifact-pane.test-support.js";

/** The bounds read served, so a case can assert the leg that DID answer. */
const SERVED_ALLOWLIST: NonNullable<ArtifactPortScript["allowlistAnswer"]> = {
  status: "served",
  value: { contentTypes: ["image/svg+xml"], maximumByteLength: 42 },
};

/** What an IPC disconnect leaves in the caller's hands: a rejection, not an answer. */
const DISCONNECTED = new Error("the bridge went away mid-read");

/** Both legs of one read, over a port answering whatever the case scripts. */
async function bothLegs(script: ArtifactPortScript): Promise<{
  readonly artifacts: Awaited<ReturnType<typeof readArtifactList>>;
  readonly allowlist: Awaited<ReturnType<typeof readArtifactAllowlist>>;
}> {
  const bridge = artifactBridgeAnswering(script);
  const [artifacts, allowlist] = await Promise.all([
    readArtifactList(bridge, SESSION_ID),
    readArtifactAllowlist(bridge, SESSION_ID),
  ]);
  return { artifacts, allowlist };
}

describe("artifact pane reads — a refused list and a served one", () => {
  it("carries the port's refusal verbatim rather than reporting an empty list", async () => {
    const state = await readArtifactList(
      artifactBridgeAnswering({
        listAnswer: growthUnavailable("artifactList"),
        allowlistAnswer: growthUnavailable("artifactAllowlistRead"),
      }),
      SESSION_ID,
    );
    expect(state.kind).toBe("refused");
    expect(state.kind === "refused" ? state.refusal.code : undefined).toBe("wire-unregistered");
  });

  it("reads a served manifest summary as a row, member for member", async () => {
    const state = await readArtifactList(
      artifactBridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: growthUnavailable("artifactAllowlistRead"),
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
      artifactBridgeAnswering({
        listAnswer: { status: "served", value: [] },
        allowlistAnswer: growthUnavailable("artifactAllowlistRead"),
      }),
      SESSION_ID,
    );
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : undefined).toStrictEqual([]);
  });
});

describe("artifact pane reads — the allow-list hint", () => {
  it("falls back to the shipped default and says so, carrying the refusal", async () => {
    const allowlist = await readArtifactAllowlist(
      artifactBridgeAnswering({
        listAnswer: growthUnavailable("artifactList"),
        allowlistAnswer: growthUnavailable("artifactAllowlistRead"),
      }),
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
      // THE ONE DELIBERATELY OFF-CONTRACT SCRIPT IN THIS FAMILY, and the cast is
      // narrow on purpose. `GrowthUnavailable` requires `status`, so the port's own
      // type cannot express the shape this case is about — which is the point: the
      // regression was a leg reading a `status`-less value as served. Asserting the
      // one member the port forbids is what makes this a negative control rather
      // than a restatement of the type.
      allowlistAnswer: {
        code: "wire-unregistered",
        detail: "Not checked — the artifact CRUD method strings are not registered yet.",
        origin: "growth-port",
      } as unknown as NonNullable<ArtifactPortScript["allowlistAnswer"]>,
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
      artifactBridgeAnswering({
        listAnswer: growthUnavailable("artifactList"),
        allowlistAnswer: SERVED_ALLOWLIST,
      }),
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
    // `call-rejected` and not `wire-unregistered`: the bounds read was MADE and threw,
    // where the wire this build does not carry is the answered refusal the case above
    // this one drives. The two are the port's own members and different next moves.
    expect(allowlist.refusal?.code).toBe("call-rejected");
    // The leg that did not come back is named by the operation it was on, which is a
    // structured member rather than a substring of prose, and the reason travels with
    // it — read through `core/wire-rejection.ts`, so what lands is the sentence the
    // producing side wrote rather than a rendering of the rejected value.
    expect(allowlist.refusal).toMatchObject({ operationId: "artifactAllowlistRead" });
    expect(allowlist.refusal?.detail).toContain(DISCONNECTED.message);
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

    // Each refusal names its OWN operation. A join caught in one place would carry one
    // operation id onto both readings, and the two here are different — which is the
    // claim the sentence used to carry and the structured member now makes exactly.
    expect(artifacts.kind === "refused" ? artifacts.refusal : undefined).toMatchObject({
      operationId: "artifactList",
    });
    expect(allowlist.refusal).toMatchObject({ operationId: "artifactAllowlistRead" });
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

/**
 * A served envelope around a value the port's own type forbids.
 *
 * THE CAST AT EACH USE IS THE CASE AND NOT A CONVENIENCE. `GrowthPortAnswer` is a
 * claim about what the daemon SENDS, the fixture bridge is assembled behind a cast of
 * its own, and the live port is a process boundary away — so the type guards the
 * CALLER and nothing guards what arrives. A case that could not express a reply
 * off-contract could not drive the guard that reads one. Written as a helper so the
 * `value` is `unknown` at the assertion rather than each site needing two of them.
 */
function servedOffContract(value: unknown): {
  readonly status: "served";
  readonly value: unknown;
} {
  return { status: "served", value };
}

/** A served list reply whose value is an envelope rather than the list itself. */
const SERVED_NOT_A_LIST = servedOffContract({
  rows: [SERVED_SUMMARY],
}) as GrowthPortAnswer<"artifactList">;

/** A served bounds reply carrying neither of the two members that leg reads. */
const SERVED_WITHOUT_BOUNDS = servedOffContract({
  limits: { maximumBytes: 42 },
}) as GrowthPortAnswer<"artifactAllowlistRead">;

describe("artifact pane reads — a served value neither leg can use", () => {
  it("refuses the list and leaves the bounds the reply says nothing about", async () => {
    // The counterexample this guard exists for: the served value went to `.map`, the
    // leg REJECTED, and `Promise.all` in the reader's one read rejected with it — so a
    // bounds reply that had come back perfectly well was thrown away and the pane kept
    // the previous reading's. `bothLegs` joins the two exactly as the reader does, so
    // an unguarded leg fails this case by rejecting rather than by asserting.
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: SERVED_NOT_A_LIST,
      allowlistAnswer: SERVED_ALLOWLIST,
    });

    expect(artifacts.kind).toBe("refused");
    expect(artifacts.kind === "refused" ? artifacts.refusal.code : undefined).toBe(
      "reply-unreadable",
    );
    expect(artifacts.kind === "refused" ? artifacts.refusal.detail : "").toContain(
      "The artifact list",
    );
    // The leg that answered is untouched, which is the property the join rests on.
    expect(allowlist.source).toBe("effective");
    expect(allowlist.mediaTypes).toStrictEqual(["image/svg+xml"]);
    expect(allowlist.refusal).toBeUndefined();
  });

  it("shows the shipped bounds when the served reply carries none, and still lists", async () => {
    const { artifacts, allowlist } = await bothLegs({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: SERVED_WITHOUT_BOUNDS,
    });

    expect(allowlist.source).toBe("shipped-default");
    expect(allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(allowlist.refusal?.code).toBe("reply-unreadable");
    // The bounds are the shipped ones and the reply's own number is NOT half-used: a
    // reply carrying a cap under another name is a reply this leg cannot read at all.
    expect(allowlist.maximumByteLength).not.toBe(42);
    expect(artifacts.kind).toBe("listed");
  });

  it("negative control: a served reply carrying both members reads as effective", async () => {
    // Without this the case above would pass against a leg that had stopped reading a
    // served bounds reply at all and always answered the shipped defaults.
    const { allowlist } = await bothLegs({
      listAnswer: { status: "served", value: [SERVED_SUMMARY] },
      allowlistAnswer: SERVED_ALLOWLIST,
    });

    expect(allowlist.source).toBe("effective");
    expect(allowlist.maximumByteLength).toBe(42);
  });
});
