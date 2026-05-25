// Shared deterministic derivation of the bootstrap "main" channel id.
//
// THE single source of truth (Plan-002 Phase 3, shared channel-id derivation):
// `deriveMainChannelId` is consumed by BOTH the runtime-daemon session
// projector AND the control-plane `ChannelList` projection. Before this module
// existed, each surface hand-rolled its OWN deterministic derivation:
//   * daemon          — UUIDv5 (SHA-1 over namespace + name) via `node:crypto`
//   * control-plane   — UUIDv8 (SHA-256 over `${sessionId}:main`) via `node:crypto`
// so the "same" channel resolved to two DIFFERENT ids across surfaces. Hoisting
// one derivation here collapses the divergence: both callers now produce a
// byte-identical id for a given `sessionId`.
//
// Why the bootstrap "main" channel has a derived (not stored) id:
//   The bootstrap channel is a PROJECTED structural invariant — exactly one per
//   session, 1:1 with the session, its id a PURE FUNCTION of the session id. It
//   is NOT an event-sourced object: no `ChannelCreated` event is ever emitted
//   for it (that event exists for Plan-016 *user* channels). Because the channel
//   always exists logically the instant a session exists, its id can be computed
//   deterministically rather than read from a row or replayed from an event.
//
// UUIDv8 rationale (RFC 9562 §5.8 — custom/vendor-defined deterministic layout):
//   This id is deterministic, derived from an application-controlled hash of an
//   application-defined input string. A version-4 nibble would falsely advertise
//   "random"; a version-5 nibble would falsely advertise "SHA-1 over a UUID
//   namespace + name" (this uses SHA-256 over a plain string, no namespace).
//   UUIDv8 is the RFC's designated, honest marker for a vendor-defined
//   deterministic layout — so we stamp version nibble = 8.
//
// Canonical input string: `${sessionId}:main`
//   The `:main` suffix prevents a raw session id and its derived channel id from
//   colliding as hash inputs. This input EXACTLY matches the control-plane's
//   prior derivation input, so the control-plane's id value is UNCHANGED after
//   it migrates onto this function. (The daemon's prior UUIDv5 id value DOES
//   change — the daemon migration adopts this canonical UUIDv8 id.)
//
// Isomorphism (R4 — contracts runs on Node + Cloudflare Workers + browser):
//   This module is deliberately `node:crypto`-free and `Buffer`-free. It operates
//   on `Uint8Array` and uses `@noble/hashes` for both the SHA-256 hash and the
//   hex formatting. An ESLint `no-restricted-imports` / `no-restricted-globals`
//   guard (eslint.config.mjs) enforces that `@ai-sidekicks/contracts/src/**`
//   stays free of `node:*` builtins and the `Buffer` global.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { ChannelId } from "./session.js";

// THE canonical name of the bootstrap `main` channel — the single source of
// truth used both as the derivation-input discriminator AND as the channel's
// display name on every surface (daemon projection + control-plane
// `ChannelList`). It is mixed into the deterministic id derivation as the
// `${sessionId}:main` suffix so a session id and its derived channel id never
// collide as raw hash inputs. Deliberate coupling: because the canonical name
// feeds the hash, changing it is a BREAKING id change — the golden-vector test
// (`__tests__/channel-id.test.ts`) catches any drift loudly, which is the
// intended safety for a structural identifier, not a footgun.
export const MAIN_CHANNEL_NAME = "main";

/**
 * Derive the deterministic bootstrap "main" channel id for a session.
 *
 * Same `sessionId` → byte-identical UUID on every call, across processes and
 * restarts (the derivation holds no state and reads no row). Implements an RFC
 * 9562 §5.8 UUIDv8 layout:
 *   1. SHA-256 over the UTF-8 bytes of `${sessionId}:main`.
 *   2. Take the first 16 bytes.
 *   3. Stamp the version nibble to 8 (high nibble of byte 6).
 *   4. Stamp the variant bits to 10 (high two bits of byte 8).
 *   5. Format as canonical 8-4-4-4-12 lowercase hex.
 *
 * The result satisfies the `ChannelId` brand (session.ts:63-65 —
 * `ChannelIdSchema` via `brandedUuidIdSchema`, whose validator is
 * `internal/branded.ts:25` `z.string().uuid()`); that validator accepts any
 * RFC 9562 UUID including v8 (rationale: session.ts:8-11). The
 * return is a cast: the unit tests in `__tests__/channel-id.test.ts` prove the
 * output is a valid lowercase canonical v8 UUID (the `as ChannelId` cast in
 * `deriveMainChannelId`'s return below).
 *
 * `sessionId` is a plain `string`, not a branded `SessionId`: the daemon passes
 * its unbranded internal session id, and a branded `SessionId` (which is
 * `string & {...}`) is assignable to `string`, so both callers type-check. No
 * input VALIDATION is performed — callers pass trusted session ids (consistent
 * with the prior daemon/control-plane derivations' documented no-validation
 * stance). The id is, however, CANONICALIZED before hashing: the hex case is
 * lowercased (`sessionId.toLowerCase()`). RFC 9562 §4 makes UUID hex
 * case-INSENSITIVE while the canonical text representation is lowercase, and
 * `SessionIdSchema` (`z.string().uuid()`, internal/branded.ts:24) therefore
 * ACCEPTS an uppercase or mixed-case UUID. Hashing the raw string would then
 * derive a DIFFERENT channel id for the same logical session — breaking the
 * byte-identical cross-surface invariant this shared helper exists to guarantee
 * (daemon projector vs control-plane `ChannelList`). Lowercasing first makes the
 * id depend only on the session's IDENTITY, not its hex case. The daemon +
 * control-plane callers pass lowercase UUIDs today, so this is a no-op for them
 * and a correctness fix for any schema-accepted case-variant of the same id.
 *
 * THE single source of truth: consumed by both the daemon projector and the
 * control-plane `ChannelList` projection (see module header).
 */
export function deriveMainChannelId(sessionId: string): ChannelId {
  const digest = sha256(utf8ToBytes(`${sessionId.toLowerCase()}:${MAIN_CHANNEL_NAME}`));
  const bytes = digest.subarray(0, 16);
  // Version 8 (RFC 9562 §5.8 — custom/deterministic): clear the high nibble of
  // byte 6 and set it to 1000.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  // Variant 10 (RFC 9562 §4.1): clear the high two bits of byte 8 and set 10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as ChannelId;
}
