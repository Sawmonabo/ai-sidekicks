// Plan-002 Phase 3 — `channel-id.ts` (`deriveMainChannelId`) tests.
//
// Backstops the shared deterministic bootstrap "main" channel-id derivation
// that is THE single source of truth consumed by BOTH the runtime-daemon
// session projector AND the control-plane `ChannelList` projection. Before this
// module, each surface hand-rolled a divergent derivation; these tests pin the
// one canonical algorithm so neither surface can drift.
//
// Test surface enumerated (the "what" each block pins):
//   * Golden vector (R1) — `deriveMainChannelId` over a fixed session id equals
//     a HAND-WRITTEN literal UUID. This is the regression anchor: it MUST fail
//     if the hash, the input string, or the version/variant stamping ever
//     changes. The literal is NOT computed by calling the function (that would
//     be tautological) — it was derived ONCE via an independent `node:crypto`
//     one-liner and pasted in by hand.
//   * Lowercase canonical formatting — result equals its own `.toLowerCase()`
//     and matches the canonical 8-4-4-4-12 v8 UUID shape.
//   * Version nibble = 8 (RFC 9562 §5.8 — UUIDv8 / vendor-deterministic).
//   * RFC 9562 §4.1 variant bits = 10 (4th group leads with 8/9/a/b).
//   * Determinism — same session id twice → identical id (the derivation holds
//     no state).
//   * Distinct ids — two different session ids → two different ids.
//
// Refs: Plan-002 Phase 3 (shared channel-id derivation), RFC 9562 §5.8
// (UUIDv8) + §4.1 (variant), contracts session.ts:8-11 (rationale —
// `z.uuid()` accepts any RFC 9562 UUID including v8) + internal/branded.ts:25
// (`z.string().uuid()`, the `ChannelId` brand's actual validator).
import { describe, expect, it } from "vitest";

import { deriveMainChannelId } from "../channel-id.js";

// Documented fixed session id used by the golden vector. The value shape is a
// UUIDv7 (the daemon's session-id format) but ANY string would do — the
// derivation does no validation. Pinning a fixed input lets us pin a fixed
// output.
const FIXED_SESSION_ID = "01970000-0000-7000-8000-0000000d4001";

// GOLDEN VECTOR — the load-bearing regression anchor.
//
// This literal was computed ONCE, by hand, via an independent `node:crypto`
// implementation of the canonical algorithm (SHA-256 over `${sessionId}:main`,
// first 16 bytes, version nibble 8, variant bits 10, lowercase 8-4-4-4-12):
//
//   node -e "const c=require('node:crypto');const s='01970000-0000-7000-8000-0000000d4001';\
//   const h=c.createHash('sha256').update(\`\${s}:main\`).digest();const b=h.subarray(0,16);\
//   b[6]=(b[6]&0x0f)|0x80;b[8]=(b[8]&0x3f)|0x80;const x=b.toString('hex');\
//   console.log(\`\${x.slice(0,8)}-\${x.slice(8,12)}-\${x.slice(12,16)}-\${x.slice(16,20)}-\${x.slice(20,32)}\`)"
//
// It is deliberately NOT produced by calling `deriveMainChannelId` here — doing
// so would make the assertion tautological (the function would always equal
// itself). This vector pins the canonical algorithm and MUST fail if the hash,
// the input string, or the version/variant stamping ever changes — including a
// silent regression in the `@noble/hashes` implementation this module imports.
const GOLDEN_VECTOR_CHANNEL_ID = "d1255c8b-1d16-8c0a-96bf-96dc8609eb2f";

// Canonical lowercase v8 UUID: 8-4-4-4-12 hex, version nibble pinned to `8`,
// variant nibble (4th group lead) pinned to one of 8/9/a/b.
const CANONICAL_V8_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deriveMainChannelId", () => {
  it("matches the hand-written golden vector (pins the canonical algorithm; MUST fail on any hash/input/version change)", () => {
    expect(deriveMainChannelId(FIXED_SESSION_ID)).toBe(GOLDEN_VECTOR_CHANNEL_ID);
  });

  it("returns a lowercase canonical 8-4-4-4-12 v8 UUID", () => {
    const id = deriveMainChannelId(FIXED_SESSION_ID);
    expect(id).toBe(id.toLowerCase());
    expect(id).toMatch(CANONICAL_V8_UUID);
  });

  it("stamps the version nibble to 8 (RFC 9562 §5.8 — UUIDv8)", () => {
    const id = deriveMainChannelId(FIXED_SESSION_ID);
    // 3rd hyphen-delimited group: `xxxxxxxx-xxxx-Vyyy-...` — V is the version.
    const versionGroup = id.split("-")[2]!;
    expect(versionGroup[0]).toBe("8");
  });

  it("stamps the RFC 9562 §4.1 variant bits to 10 (4th group leads with 8/9/a/b)", () => {
    const id = deriveMainChannelId(FIXED_SESSION_ID);
    // 4th hyphen-delimited group: `...-Wyyy-...` — W's high bits encode variant.
    const variantGroup = id.split("-")[3]!;
    expect(["8", "9", "a", "b"]).toContain(variantGroup[0]);
  });

  it("is deterministic — the same session id yields an identical id", () => {
    expect(deriveMainChannelId(FIXED_SESSION_ID)).toBe(deriveMainChannelId(FIXED_SESSION_ID));
  });

  it("yields distinct ids for distinct session ids", () => {
    const first = deriveMainChannelId("01970000-0000-7000-8000-0000000d4001");
    const second = deriveMainChannelId("01970000-0000-7000-8000-0000000d4002");
    expect(first).not.toBe(second);
  });
});
