// The artifact read's two arms, and the two members the manifest does NOT carry.
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
// the wire's closed pair — and proves the type rejects it now.
//
// AND THE ABSENCES ARE ASSERTED TOO. The manifest carries no content-type member and
// no expiry member, which is a fact about the registered envelope rather than an
// omission here, so it is checked rather than left to a doc comment nobody re-reads: a
// member added to the mirror for either would fail the case below, and the foil beside
// it proves the case can fail at all.

import { describe, expect, expectTypeOf, it } from "vitest";

import type { GrowthOperationSignatures } from "./growth-signatures.js";
import type { GrowthArtifactRead, GrowthArtifactSummary } from "./growth-values.js";

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
 * The read a pane's manifest fetch takes: the envelope, and no payload members at all.
 *
 * The construction IS the assertion — this only compiles while all three payload
 * members are optional, which is what makes "I did not ask for the bytes" a served
 * answer rather than a reply with three holes in it.
 */
const MANIFEST_ONLY_READ: GrowthArtifactRead = { manifest: MANIFEST };

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

  it("carries the manifest alone when the caller did not ask for bytes", () => {
    expect(MANIFEST_ONLY_READ.manifest.artifactId).toBe("artifact-1");
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
