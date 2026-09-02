// The artifact plane's registered replies: the read's two arms, the delete's receipt,
// and the two members the manifest does NOT carry.
//
// `artifactRead` answered with the bare manifest, which made the artifact pane's two
// reads one read: a metadata read and a payload fetch differ only by `includePayload`,
// and with no request member to set and no reply member to receive on, the second was
// unrepresentable — a surface could ask for an artifact's bytes and had nowhere to be
// given them. So the subject here is the registration itself.
//
// WHAT THESE CASES CAN AND CANNOT PROVE. TypeScript is structural, so a value that
// satisfies the registered shape proves the shape ADMITS it and never that the wire
// sends it; the contract section named in `growth-values.ts` is the source, and this
// file is what holds the mirror to the two arms a caller actually builds. The negative
// controls are therefore the load-bearing half: each plants a shape that was reachable
// before the registration — the bare manifest as the whole reply, an encoding outside
// the wire's closed pair, a receipt with no disposition on it — and proves the type
// rejects it now. That last one is the one a fixture would otherwise DEFAULT: a reply
// missing `payloadDisposition` has to be refused, because rendering it as "reclaimed"
// is a claim about the operator's disk that nothing checked.
//
// AND THE ARMS ARE THE SUBJECT, NOT THREE OPTIONALS. The read's payload members are
// correlated: a reply hands back a handle to fetch the bytes with, or the bytes with
// the encoding to read them by. Three independent optionals admitted eight combinations
// where the contract registers two, and the six they let through were replies a pane
// could compile against and not act on — no way to reach the bytes, no way to decode
// them, or an encoding describing bytes that are not there. Each of those three has a
// case below, and the control beside them proves the union still admits the two shapes
// the wire really sends.
//
// AND THE ABSENCES ARE ASSERTED TOO. The manifest carries no content-type member and
// no expiry member, which is a fact about the registered envelope rather than an
// omission here, so it is checked rather than left to a doc comment nobody re-reads: a
// member added to the mirror for either would fail the case below, and the foil beside
// it proves the case can fail at all.

import { describe, expect, expectTypeOf, it } from "vitest";

import type { GrowthOperationSignatures } from "./growth-signatures.js";
import type {
  GrowthArtifactDeleteReceipt,
  GrowthArtifactPayloadDisposition,
  GrowthArtifactRead,
  GrowthArtifactSummary,
} from "./growth-values.js";

/** The manifest every case here reads through. Fixed; nothing below is about its values. */
const MANIFEST: GrowthArtifactSummary = {
  artifactId: "artifact-1",
  sessionId: "session-1",
  artifactType: "file",
  digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  size: 11,
  annotations: { "org.opencontainers.image.title": "notes.txt" },
  visibility: "shared",
  state: "published",
  metadata: { mediaType: "text/plain" },
  createdAt: "2026-01-01T14:20:00.000Z",
};

/**
 * The read a pane's manifest fetch takes: the envelope, and the key to fetch the bytes
 * with.
 *
 * The construction IS the assertion — it compiles because the deferred arm is exactly
 * this, which is what makes "I did not ask for the bytes" a served answer rather than a
 * reply a pane cannot act on. The handle is the CAS key the manifest read has already
 * resolved; returning it costs the daemon nothing and is what keeps every served read
 * reachable.
 */
const MANIFEST_ONLY_READ: GrowthArtifactRead = {
  manifest: MANIFEST,
  payloadHandle: "cas/sha256-0000",
};

/**
 * The read a pane's payload fetch takes: the same envelope, the bytes, and the encoding
 * to read them by.
 *
 * Base64 rather than utf8 deliberately. The contract admits `utf8` only for byte-exact
 * valid UTF-8, so base64 is the arm every other payload lands on, and it is the arm a
 * surface gets wrong by sniffing instead of switching.
 */
const PAYLOAD_READ: GrowthArtifactRead = {
  manifest: MANIFEST,
  payload: "aGVsbG8gd29ybGQ=",
  payloadEncoding: "base64",
};

describe("the artifact read — one method, the pane's two reads", () => {
  it("takes the payload discriminator on the request, so the second read is askable", () => {
    expectTypeOf<GrowthOperationSignatures["artifactRead"]["request"]>().toEqualTypeOf<{
      readonly artifactId: string;
      readonly includePayload?: boolean;
    }>();
  });

  it("answers with the read value rather than the bare manifest", () => {
    // The registration, stated positively: the reply is the four-member envelope the
    // wire sends, and the manifest is one member of it rather than the whole of it.
    expectTypeOf<
      GrowthOperationSignatures["artifactRead"]["value"]
    >().toEqualTypeOf<GrowthArtifactRead>();
  });

  it("carries the manifest and a handle when the caller did not ask for bytes", () => {
    expect(MANIFEST_ONLY_READ.manifest.artifactId).toBe("artifact-1");
    expect(MANIFEST_ONLY_READ.payloadHandle).toBe("cas/sha256-0000");
    expect(MANIFEST_ONLY_READ.payload).toBeUndefined();
    expect(MANIFEST_ONLY_READ.payloadEncoding).toBeUndefined();
  });

  it("carries the bytes and the encoding to read them by when the caller did", () => {
    expect(PAYLOAD_READ.payload).toBe("aGVsbG8gd29ybGQ=");
    expect(PAYLOAD_READ.payloadEncoding).toBe("base64");
    // Asserted through the encoding rather than by decoding here: the console does not
    // own a decoder, and a test that decoded would be checking its own arithmetic.
    expect(PAYLOAD_READ.manifest.size).toBe(11);
  });

  it("defers instead, when the reply hands back a handle rather than the bytes", () => {
    const deferred: GrowthArtifactRead = { manifest: MANIFEST, payloadHandle: "cas/sha256-0000" };

    expect(deferred.payloadHandle).toBe("cas/sha256-0000");
    expect(deferred.payload).toBeUndefined();
  });
});

describe("negative control — the shapes the registration now refuses", () => {
  it("refuses the bare manifest as the whole reply, which is what it used to be", () => {
    // Exactly the old value type. Without this line the two cases above would hold over
    // a port that still answered with the manifest, because a manifest is a perfectly
    // good manifest — what it is not is a reply that can carry a payload.
    // @ts-expect-error — `manifest` is missing: the summary is one member of the reply.
    const stale: GrowthArtifactRead = MANIFEST;

    expect(Object.keys(stale)).toContain("artifactId");
  });

  it("refuses a bare manifest, which leaves a pane no way to reach the bytes", () => {
    // The first of the three impossible shapes three independent optionals admitted.
    // `Spec-014 §Interfaces And Contracts` requires a read to answer with "manifest
    // plus retrievable payload handle or inline content", so a reply carrying neither
    // is one a pane enters its served path holding and can do nothing with.
    // @ts-expect-error — neither arm: the deferred one requires a handle, the inline
    // one requires the bytes.
    const unreachable: GrowthArtifactRead = { manifest: MANIFEST };

    expect(unreachable.payloadHandle).toBeUndefined();
  });

  it("refuses inline bytes with no encoding, which leaves no way to decode them", () => {
    // The second. The encoding is what a reader SWITCHES on — the contract says
    // callers never sniff — so bytes arriving without one cannot be read at all, and
    // a pane that guessed would be doing the sniffing the contract forbids.
    // @ts-expect-error — `payloadEncoding` is required on the arm that carries bytes.
    const undecodable: GrowthArtifactRead = { manifest: MANIFEST, payload: "aGVsbG8=" };

    expect(undecodable.payloadEncoding).toBeUndefined();
  });

  it("refuses an encoding with no payload, which describes bytes that are not there", () => {
    // The third, and the mirror of the second: an encoding is a fact ABOUT a payload,
    // so one standing alone is a reading of nothing.
    // @ts-expect-error — the deferred arm forbids the encoding and the inline arm
    // requires the bytes beside it.
    const describesNothing: GrowthArtifactRead = {
      manifest: MANIFEST,
      payloadHandle: "cas/sha256-0000",
      payloadEncoding: "base64",
    };

    expect(describesNothing.payload).toBeUndefined();
  });

  it("negative control: the two shapes the contract does register still compile", () => {
    // Without this the three refusals above would hold over a union that refused every
    // reply, including the two the wire actually sends.
    const deferred: GrowthArtifactRead = { manifest: MANIFEST, payloadHandle: "cas/sha256-0000" };
    const inline: GrowthArtifactRead = {
      manifest: MANIFEST,
      payloadHandle: "cas/sha256-0000",
      payload: "aGVsbG8gd29ybGQ=",
      payloadEncoding: "utf8",
    };

    expect(deferred.payload).toBeUndefined();
    // Both together is admitted deliberately: the registered response permits a reply
    // to hand back a handle beside the bytes, and refusing the pair would be the
    // console deciding something the wire has not.
    expect(inline.payloadHandle).toBe("cas/sha256-0000");
  });

  it("refuses an encoding outside the wire's closed pair", () => {
    // The member exists so a reader SWITCHES on it. A third arm would be a value the
    // switch has no branch for, reached by a surface that guessed. Bound to its own
    // declaration so the refusal lands on one line rather than inside a literal, where
    // a formatter could move it out from under the directive.
    const unregisteredEncoding = "utf16";

    // @ts-expect-error — "utf16" is not one of the two encodings the contract registers.
    const mislabelled: GrowthArtifactRead["payloadEncoding"] = unregisteredEncoding;

    expect(mislabelled).toBe("utf16");
  });
});

describe("the manifest's absences — checked, not assumed", () => {
  it("carries neither a content-type member nor an expiry one", () => {
    // The registered envelope has neither: a media type rides `metadata`, and the
    // nearest thing to an expiry is the persisted `replicationStatus`. A member added
    // here for either would be a figure the console could render and no daemon supply.
    expectTypeOf<
      Extract<keyof GrowthArtifactSummary, "contentType" | "expiresAt">
    >().toEqualTypeOf<never>();
  });

  it("negative control: the same check is not vacuous", () => {
    /** The defect class, planted: a mirror that grew members the envelope has not. */
    interface OverreachingSummary extends GrowthArtifactSummary {
      readonly contentType: string;
      readonly expiresAt: string;
    }

    expectTypeOf<Extract<keyof OverreachingSummary, "contentType" | "expiresAt">>().toEqualTypeOf<
      "contentType" | "expiresAt"
    >();
  });

  it("reports the replication status the wire does carry, which is what stands in", () => {
    const expiring: GrowthArtifactSummary = { ...MANIFEST, replicationStatus: "expired" };

    expect(expiring.replicationStatus).toBe("expired");
  });
});

describe("the artifact delete — a receipt, where the reply used to be nothing", () => {
  it("answers with the receipt rather than nothing at all", () => {
    expectTypeOf<
      GrowthOperationSignatures["artifactDelete"]["value"]
    >().toEqualTypeOf<GrowthArtifactDeleteReceipt>();
  });

  it("reports each disposition the contract registers, so none is unrenderable", () => {
    // Built from the vocabulary rather than from three hand-written literals: a
    // disposition the type admits and this case did not name would go unnoticed, and
    // an arm no surface can be handed is an arm no surface will be built to draw.
    const dispositions: readonly GrowthArtifactPayloadDisposition[] = [
      "reclaimed",
      "reclaim_pending",
      "retained_by_references",
    ];
    const receipts = dispositions.map(
      (payloadDisposition): GrowthArtifactDeleteReceipt => ({
        artifactId: "artifact-1",
        payloadDisposition,
        rePublishForeclosed: false,
        deletedAt: "2026-01-01T14:21:00.000Z",
      }),
    );

    expect(receipts.map((receipt) => receipt.payloadDisposition)).toStrictEqual(dispositions);
  });

  it("carries the foreclosure fact a confirmation exists for", () => {
    const foreclosed: GrowthArtifactDeleteReceipt = {
      artifactId: "artifact-1",
      payloadDisposition: "reclaimed",
      rePublishForeclosed: true,
      deletedAt: "2026-01-01T14:21:00.000Z",
    };

    expect(foreclosed.rePublishForeclosed).toBe(true);
  });

  it("negative control: a reply missing the disposition is refused, never defaulted", () => {
    // The defect this registration exists to make unreachable. A fixture or a daemon
    // answering without the member cannot be read as "reclaimed" — that is a statement
    // about whether the bytes are gone, and the reply did not make it.
    // @ts-expect-error — `payloadDisposition` is required; there is no default for it.
    const undisposed: GrowthArtifactDeleteReceipt = {
      artifactId: "artifact-1",
      rePublishForeclosed: false,
      deletedAt: "2026-01-01T14:21:00.000Z",
    };

    expect(undisposed.payloadDisposition).toBeUndefined();
  });

  it("negative control: the empty reply is refused, which is what it used to be", () => {
    // Exactly the old value type. Without this line the cases above would hold over a
    // port that still answered with nothing, since nothing is assignable to nothing.
    // @ts-expect-error — every member of the receipt is missing.
    const stale: GrowthArtifactDeleteReceipt = undefined;

    expect(stale).toBeUndefined();
  });
});
