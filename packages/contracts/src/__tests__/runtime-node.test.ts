// The runtime node's contracts: `NodeIdSchema` accepts a non-UUID opaque id up
// to its length cap, and a below-floor client gets a typed
// `VERSION_FLOOR_EXCEEDED` error that keeps its upgrade path through a parse.
import { describe, expect, it } from "vitest";

import {
  VERSION_FLOOR_EXCEEDED_CODE,
  VersionFloorExceededErrorSchema,
  type VersionBoundExceededDetails,
  type VersionFloorExceededError,
} from "../error.js";
import { NODE_ID_MAX_LEN, NodeIdSchema } from "../node-id.js";

describe("NodeIdSchema (non-UUID opaque daemon-assigned brand)", () => {
  it("accepts a plain non-empty string (does NOT require UUID format)", () => {
    expect(NodeIdSchema.safeParse("node-daemon-abc123").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(NodeIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects an oversized node id (defense-in-depth length cap)", () => {
    expect(NodeIdSchema.safeParse("x".repeat(NODE_ID_MAX_LEN + 1)).success).toBe(false);
  });

  it("accepts a node id at exactly the length cap (boundary)", () => {
    expect(NodeIdSchema.safeParse("x".repeat(NODE_ID_MAX_LEN)).success).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Test C5: typed `VERSION_FLOOR_EXCEEDED` consumer anchor.
// --------------------------------------------------------------------------
//
// This block is a CONSUMER-SIDE conformance anchor, NOT a re-test of the error-schema
// matrix. requires that a below-floor write returns a *typed* `VERSION_FLOOR_EXCEEDED`.
// The two assertions here pin the consuming dependency on that contract — the exact-
// precedent (pinned the dependency on Postgres `min_client_version` column; this pins
// its dependency on typed error).
//
// DELIBERATELY NOT RE-RUN HERE: `error.test.ts`'s
// `describe("VersionFloorExceededErrorSchema")` owns the full
// accept/reject/strict-key/oversize/whitespace/boundary/missing-field matrix.
// This block adds exactly what that matrix does NOT cover — see each `it`.
//
// PHASE-3 TRIPWIRE: only the typed-CONTRACT conformance proven here ships. The RUNTIME
// admit-not-eject behavior — the attach service actually returning this error on a
// below-floor write and then admitting the daemon read-only — lands.
//
describe("VersionFloorExceededErrorSchema (C5: VERSION_FLOOR_EXCEEDED typed-contract conformance — consumer anchor)", () => {
  it("pins the wire code literal to the value registered", () => {
    // The expected string is single-sourced from the INDEPENDENT registry — maps the
    // typed `VERSION_FLOOR_EXCEEDED` name to the dotted wire code
    // `version.floor_exceeded`. That doc, NOT `error.ts`, is the source of the expected
    // value here, so this pin detects drift in `error.ts` rather than tautologically
    // agreeing with it.
    //
    // Error.test.ts: every test there references the constant SYMBOLICALLY
    // (`code: VERSION_FLOOR_EXCEEDED_CODE`), so renaming the constant's VALUE
    // (e.g. This is the only test in the repo that pins the literal string
    // itself.
    expect(VERSION_FLOOR_EXCEEDED_CODE).toBe("version.floor_exceeded");
  });

  it("binds the below-floor rejection payload to its TYPE and preserves the upgradePath through a parse", () => {
    // Error.test.ts's un-annotated `buildValidFloorError()` literal
    // (error.test.ts:377-385,398): that fixture proves the schema ACCEPTS the
    // shape at runtime; the explicit type annotations below prove the CONSUMING
    // code sees a TYPE that agrees with the schema (compile-time-checked by the
    // package's `isolatedDeclarations` + `exactOptionalPropertyTypes` build).
    // `upgradePath` is `string | undefined` on the interface, so including it with
    // a concrete value is correct under `exactOptionalPropertyTypes`.
    const belowFloorDetails: VersionBoundExceededDetails = {
      attemptedVersion: "0.9",
      acceptedRange: { min: "1.0", max: "2.0" },
      upgradePath: "Upgrade the client to 1.0 or higher: https://example.com/upgrade",
    };
    const belowFloorRejection: VersionFloorExceededError = {
      code: VERSION_FLOOR_EXCEEDED_CODE,
      message: "Client protocol version 0.9 is below daemon's accepted floor 1.0.",
      details: belowFloorDetails,
    };

    const result = VersionFloorExceededErrorSchema.safeParse(belowFloorRejection);
    expect(result.success).toBe(true);

    // Assert the schema PRESERVES it through a parse rather than dropping the optional
    // field.
    if (result.success) {
      expect(result.data.details.upgradePath).toBe(belowFloorRejection.details.upgradePath);
    }
  });
});
