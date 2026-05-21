# `@ai-sidekicks/crypto-paseto` Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `@ai-sidekicks/crypto-paseto` workspace package — PASETO v4.public + v4.local primitives, PAE helper, and in-memory KeyRing — as the cryptographic substrate that Plan-002 invite-token minting (CP-002-4) and Plan-018 refresh-token issuance depend on.

**Architecture:** In-house TypeScript library built directly on `@noble/curves` (Ed25519), `@noble/ciphers` (XChaCha20), and `@noble/hashes` (BLAKE2b + `equalBytes` + `randomBytes`). No upstream `paseto`/`paseto-js` dependency — satisfies ADR-010:129–136 in-house-lib mandate. Surface is a flat barrel (`src/index.ts`) mirroring `packages/contracts/`. A test-only `encryptV4LocalDeterministic` seam under `src/internal/` enables RFC vector encrypt round-trips without exposing nonce-injection to production callers.

**Tech Stack:** TypeScript (strict + isolatedDeclarations + verbatimModuleSyntax inherited from `tsconfig.node22.json`); Node `>=22.12.0`; Vitest 4.x via `catalog:testing`; `@noble/curves@^2` + `@noble/ciphers@^2` + `@noble/hashes@^2`; ESLint + Prettier via root config; lefthook pre-commit chain (`lint-staged`, `gitleaks`, `commitlint`).

---

## Governing documents

| Source | Role |
| --- | --- |
| [Design spec](../specs/2026-05-20-crypto-paseto-substrate-design.md) | Public surface contract; threat model; invariants I1–I6 |
| [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md):129–136 | In-house lib mandate; dual-primitive coverage; audited deps; RFC conformance release gate |
| [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md):29 | Plan-018 v4.local dependency declared |
| [Plan-025](../../plans/025-self-hostable-node-relay.md) §Tier 1 Partial PR Sequence (lines 256–297) | Owning plan; carves Phase 1 substrate out from Tier 7 relay implementation |
| [Spec-025](../../specs/025-self-hostable-node-relay.md) | Context only; `spec_coverage: []` (Spec-025 governs the relay surface, not package primitives) |
| [Cross-plan dependencies](../../architecture/cross-plan-dependencies.md) §5 + Plan-025 Substrate-vs-Namespace Carve-Out | Names Plan-018 Tier 5 as the persistence owner for KeyRing |
| [Plan-implementation readiness-audit runbook](../../operations/plan-implementation-readiness-audit-runbook.md) §Per-Phase Audit Semantics | Admits `substrate_exempt` for this phase |
| [Plan-002](../../plans/002-invite-membership-and-presence.md) Phase 2 precondition | Downstream consumer (CP-002-4) — invite-token minting |
| [CONTRIBUTING.md](../../../CONTRIBUTING.md) | GitFlow-lite; Conventional Branch; Conventional Commits |
| [AGENTS.md](../../../AGENTS.md) | Primary-source citation discipline |

### Primary cryptographic sources

- PASETO Spec — Version 4: https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md
- PASETO Spec — Common (PAE): https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Common.md
- PASETO Test Vectors v4: https://github.com/paseto-standard/test-vectors/blob/master/v4.json
- noble-curves (ed25519): https://github.com/paulmillr/noble-curves#readme
- noble-ciphers (xchacha20): https://github.com/paulmillr/noble-ciphers#readme
- noble-hashes (blake2b, equalBytes): https://github.com/paulmillr/noble-hashes#readme

---

## Phase-level audit status

This phase is admitted under the readiness-audit runbook's `substrate_exempt` predicate:

```yaml
audit_status: substrate_exempt
substrate_carveout: 1
cross_plan_carve_out: ../architecture/cross-plan-dependencies.md#plan-025-substrate-vs-namespace-carve-out-tier-1--tier-7
spec_coverage: []
```

Plan-readiness audit gates G1–G6 do not apply. ADR-010 acceptance criteria apply at code-review time:

- **In-house lib** — `packages/crypto-paseto/` workspace package; no upstream PASETO library consumed
- **Dual-primitive coverage** — v4.public + v4.local both shipped
- **Audited deps** — `@noble/curves`, `@noble/ciphers`, `@noble/hashes` pinned to `^2` (user-overridden from 1.x externally-audited; reviewer acks in PR description)
- **RFC conformance gating release** — both `rfc-vectors-*.test.ts` suites pass

---

## Branch & PR shape

- **Branch**: `feat/plan-025-tier-1-partial-crypto-paseto` (Conventional Branch 2-segment)
- **Base**: `develop` (GitFlow-lite per CONTRIBUTING.md)
- **Merge**: squash-merge into `develop`
- **Scope**: `crypto-paseto` (REQUIRES adding to `commitlint.config.mjs` `scope-enum` — Task 1)
- **Squash subject template**: `feat(crypto-paseto): ship PASETO v4 substrate (Plan-025 Tier 1 Partial)` (≤72 chars)
- **Footer trailers**: `Refs: ADR-010, Plan-025`

### Plan-025 doc-drift acknowledgement (carried forward from design spec §4.3)

The PASETO v4.local algorithm is **XChaCha20 stream cipher + BLAKE2b-MAC over PAE**, NOT XChaCha20-Poly1305 AEAD as Plan-025 §Implementation Steps 2 narrates. Implementation follows the primary spec (paseto-standard/paseto-spec §v4.local). File `BL-NNN` after this PR merges to amend the Plan-025 doc.

---

## File structure

### Files created (production source)

| Path | Responsibility |
| --- | --- |
| `packages/crypto-paseto/package.json` | Package manifest, deps, scripts |
| `packages/crypto-paseto/tsconfig.json` | Build config (mirrors `packages/contracts/tsconfig.json`) |
| `packages/crypto-paseto/tsconfig.test.json` | Test-typecheck config (noEmit) |
| `packages/crypto-paseto/vitest.config.ts` | Vitest 4.x test runner config |
| `packages/crypto-paseto/src/index.ts` | Flat barrel (placeholder in Task 1; populated in Task 7) |
| `packages/crypto-paseto/src/errors.ts` | `InvalidTokenError`, `InvalidKeyError`, `MacMismatchError` |
| `packages/crypto-paseto/src/pae.ts` | PAE (Pre-Authentication Encoding) helper |
| `packages/crypto-paseto/src/v4-public.ts` | Ed25519 sign/verify (PureEdDSA, no pre-hash) |
| `packages/crypto-paseto/src/v4-local.ts` | XChaCha20 + BLAKE2b-MAC encrypt/decrypt |
| `packages/crypto-paseto/src/internal/v4-local-deterministic.ts` | Test-only `encryptV4LocalDeterministic` seam (NOT re-exported) |
| `packages/crypto-paseto/src/key-ring.ts` | In-memory `KeyRing` + `KeyRingEntry` |

### Files created (test source)

| Path | Responsibility |
| --- | --- |
| `packages/crypto-paseto/src/__tests__/pae.test.ts` | PAE unit tests (known-value vectors) |
| `packages/crypto-paseto/src/__tests__/v4-public.test.ts` | Round-trip sign→verify smoke |
| `packages/crypto-paseto/src/__tests__/v4-local.test.ts` | Round-trip encrypt→decrypt smoke |
| `packages/crypto-paseto/src/__tests__/key-ring.test.ts` | KeyRing invariants + rotation semantics |
| `packages/crypto-paseto/src/__tests__/footer-canonicalization.test.ts` | Footer/IA `undefined ≡ Uint8Array(0)` rule (v4.public + v4.local) |
| `packages/crypto-paseto/src/__tests__/__fixtures__/v4.json` | Vendored upstream RFC vectors |
| `packages/crypto-paseto/src/__tests__/__fixtures__/PROVENANCE.md` | Source URL + commit SHA + retrieval date + sha256 |
| `packages/crypto-paseto/src/__tests__/rfc-vectors-v4-public.test.ts` | `4-S-*` vector conformance suite |
| `packages/crypto-paseto/src/__tests__/rfc-vectors-v4-local.test.ts` | `4-E-*` vector conformance suite |

### Files modified (repo root)

| Path                    | Edit                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `tsconfig.json`         | Append `{ "path": "./packages/crypto-paseto" }` to `references` |
| `commitlint.config.mjs` | Add `"crypto-paseto"` to `scope-enum`                           |

### Possibly modified (conditional on gitleaks signal)

| Path | Edit |
| --- | --- |
| `.gitleaks.toml` (repo root) | Add a `paths`-scoped allowlist entry for the fixture; only if Task 8 surfaces a flag |

---

## Task 1: Workspace scaffold (Phase 1)

**Files:**

- Create: `packages/crypto-paseto/package.json`
- Create: `packages/crypto-paseto/tsconfig.json`
- Create: `packages/crypto-paseto/tsconfig.test.json`
- Create: `packages/crypto-paseto/vitest.config.ts`
- Create: `packages/crypto-paseto/src/index.ts` (placeholder empty barrel)
- Modify: `tsconfig.json` (repo root) — append project reference
- Modify: `commitlint.config.mjs` — add `crypto-paseto` to `scope-enum`

- [ ] **Step 1: Create the new branch off `develop`**

```bash
git checkout develop && git pull origin develop
git checkout -b feat/plan-025-tier-1-partial-crypto-paseto
```

Expected: branch created, working tree clean.

- [ ] **Step 2: Create `packages/crypto-paseto/package.json`**

```json
{
  "name": "@ai-sidekicks/crypto-paseto",
  "version": "0.0.0",
  "type": "module",
  "license": "Apache-2.0",
  "description": "PASETO v4.public + v4.local primitives for AI Sidekicks (substrate for Plan-002 / Plan-018 auth).",
  "engines": {
    "node": ">=22.12.0"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b && tsc -p tsconfig.test.json",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "@noble/curves": "^2",
    "@noble/ciphers": "^2",
    "@noble/hashes": "^2"
  },
  "devDependencies": {
    "vitest": "catalog:testing"
  }
}
```

- [ ] **Step 3: Create `packages/crypto-paseto/tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tsconfig.node22.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "tsBuildInfoFile": "./.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "src/**/__tests__/**", "src/**/*.test-d.ts"]
}
```

- [ ] **Step 4: Create `packages/crypto-paseto/tsconfig.test.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tsconfig.node22.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "./src",
    "composite": false,
    "declaration": true,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 5: Create `packages/crypto-paseto/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
  },
});
```

- [ ] **Step 6: Create empty barrel `packages/crypto-paseto/src/index.ts`**

```ts
// Populated in Task 7 (Public barrel). Empty placeholder so the package
// typechecks before Task 2-6 have landed.
export {};
```

- [ ] **Step 7: Append project reference to root `tsconfig.json`**

Append `{ "path": "./packages/crypto-paseto" }` to the `references` array. The full file becomes:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./packages/contracts" },
    { "path": "./packages/client-sdk" },
    { "path": "./packages/runtime-daemon" },
    { "path": "./packages/control-plane" },
    { "path": "./packages/crypto-paseto" },
    { "path": "./apps/desktop" }
  ]
}
```

- [ ] **Step 8: Add `crypto-paseto` to `commitlint.config.mjs` `scope-enum`**

Insert `"crypto-paseto",` after `"contracts",` in the `scope-enum` array (line ~32). The resulting array section:

```js
"scope-enum": [
  2,
  "always",
  [
    // Per-package nouns
    "contracts",
    "crypto-paseto",
    "client-sdk",
    "daemon",
    "control-plane",
    "desktop",
    "sidecar-rust-pty",
    "pty-sidecar-publishing",
    // Cross-cutting nouns
    "repo",
    "deps",
    "ci",
    "format",
    "release",
  ],
],
```

Also update the leading scope-enum comment block to mention `crypto-paseto` alongside `contracts`, `client-sdk`, etc.

- [ ] **Step 9: Install and resolve workspace**

```bash
pnpm install
```

Expected: pnpm-lock.yaml updates to resolve `@noble/curves@^2`, `@noble/ciphers@^2`, `@noble/hashes@^2`. Second run (`pnpm install` again) reports no changes. If pnpm warns about an unapproved build script for any `@noble/*` package, add it to `allowBuilds` in `pnpm-workspace.yaml` (most likely none — the noble packages are pure JS).

- [ ] **Step 10: Verify the new package typechecks**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto typecheck
```

Expected: no errors. Output includes a tsbuildinfo write for `packages/crypto-paseto/.tsbuildinfo`.

- [ ] **Step 11: Commit the scaffold**

```bash
git add packages/crypto-paseto/package.json packages/crypto-paseto/tsconfig.json \
        packages/crypto-paseto/tsconfig.test.json packages/crypto-paseto/vitest.config.ts \
        packages/crypto-paseto/src/index.ts tsconfig.json commitlint.config.mjs \
        pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(crypto-paseto): scaffold workspace package + commitlint scope

Add packages/crypto-paseto/ with package.json (noble^2 deps), tsconfig
project references, and Vitest config — mirrors packages/contracts/.
Append crypto-paseto to commitlint.config.mjs scope-enum so future
feat(crypto-paseto): commits pass the pre-commit gate.

Refs: ADR-010, Plan-025
EOF
)"
```

Expected: lefthook pre-commit chain passes (gitleaks, lint-staged, docs hooks). commitlint accepts the new `crypto-paseto` scope (this is the first commit using it).

---

## Task 2: PAE (Pre-Authentication Encoding) primitive

**Files:**

- Create: `packages/crypto-paseto/src/pae.ts`
- Create: `packages/crypto-paseto/src/__tests__/pae.test.ts`

**Spec source**: `paseto-spec/docs/01-Protocol-Versions/Common.md` §Authentication Padding (PAE). Algorithm:

```
PAE(pieces) = LE64(len(pieces))
            || LE64(len(pieces[0])) || pieces[0]
            || LE64(len(pieces[1])) || pieces[1]
            || ...
```

Where `LE64(n)` is a 64-bit little-endian unsigned integer with the **high bit (bit 63) cleared** — i.e., clear the most-significant bit of the most-significant byte after little-endian encoding.

- [ ] **Step 1: Write the failing test (`src/__tests__/pae.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { pae } from "../pae.js";

const encoder = new TextEncoder();

describe("pae (Pre-Authentication Encoding)", () => {
  it("encodes the empty piece-list as LE64(0) = 8 zero bytes", () => {
    // PAE([]) = LE64(0). LE64(0) = 0x00 repeated 8 times (high bit already clear).
    expect(pae([])).toEqual(new Uint8Array(8));
  });

  it("encodes a single empty piece as LE64(1) || LE64(0)", () => {
    // PAE([new Uint8Array(0)]) = LE64(1) || LE64(0) || [] = 16 bytes.
    const result = pae([new Uint8Array(0)]);
    expect(result.length).toBe(16);
    // LE64(1): low byte 0x01, rest 0x00.
    expect(result[0]).toBe(0x01);
    for (let i = 1; i < 16; i++) expect(result[i]).toBe(0x00);
  });

  it("encodes a single 'test' piece with correct length-prefix", () => {
    const piece = encoder.encode("test"); // 4 bytes
    const result = pae([piece]);
    // Layout: LE64(1) || LE64(4) || "test"
    expect(result.length).toBe(8 + 8 + 4);
    expect(result[0]).toBe(0x01); // count = 1
    expect(result[8]).toBe(0x04); // first piece length = 4
    expect(Array.from(result.slice(16))).toEqual(Array.from(piece));
  });

  it("encodes two pieces in order with separate length prefixes", () => {
    const a = encoder.encode("hello");
    const b = encoder.encode("worldly");
    const result = pae([a, b]);
    // Layout: LE64(2) || LE64(5) || "hello" || LE64(7) || "worldly"
    expect(result.length).toBe(8 + 8 + 5 + 8 + 7);
    expect(result[0]).toBe(0x02); // count = 2
    expect(result[8]).toBe(0x05); // first piece length = 5
    expect(result[8 + 8 + 5]).toBe(0x07); // second piece length = 7
  });

  it("clears the high bit on the length prefix (LE64 high-bit-cleared)", () => {
    // Construct a piece whose length sets bit 63 of LE64 if left intact.
    // 2^63 is unreachable via a Uint8Array (max ~2^53 in JS), but we can verify
    // the high-bit-clear behavior by simulating with a synthetic length via
    // the implementation's writeLength helper if exposed. Here we settle for
    // checking that the high byte of any normal length stays zero (high bit
    // of byte[7] should always be 0 in practice). This is a sanity check.
    const piece = new Uint8Array(0);
    const result = pae([piece]);
    expect(result[7] & 0x80).toBe(0); // count's MSB cleared
    expect(result[15] & 0x80).toBe(0); // length's MSB cleared
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- pae
```

Expected: FAIL — `Cannot find module '../pae.js'` or test file import error.

- [ ] **Step 3: Implement `src/pae.ts`**

```ts
/**
 * PAE — Pre-Authentication Encoding.
 *
 * Defined in paseto-spec/docs/01-Protocol-Versions/Common.md §Authentication
 * Padding. Encodes a list of byte-strings into a single length-prefixed
 * concatenation that defends against canonicalization attacks (two different
 * piece-sets producing the same byte stream).
 *
 *   PAE(pieces) = LE64(len(pieces))
 *               || LE64(len(pieces[0])) || pieces[0]
 *               || LE64(len(pieces[1])) || pieces[1]
 *               || ...
 *
 * LE64(n) is a 64-bit little-endian unsigned integer with the **high bit
 * (bit 63) cleared** — i.e., the most-significant bit of byte[7] is forced
 * to 0 after encoding. This is the load-bearing detail of PAE.
 */
export function pae(pieces: readonly Uint8Array[]): Uint8Array {
  const totalLength =
    8 + // length prefix for the piece count
    pieces.reduce((acc, piece) => acc + 8 + piece.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;

  writeLE64HighBitCleared(out, offset, pieces.length);
  offset += 8;

  for (const piece of pieces) {
    writeLE64HighBitCleared(out, offset, piece.length);
    offset += 8;
    out.set(piece, offset);
    offset += piece.length;
  }

  return out;
}

function writeLE64HighBitCleared(out: Uint8Array, offset: number, value: number): void {
  // JS safe integer max is 2^53 - 1, well below 2^63. We split value into low
  // 32 bits and high (up to 21) bits, then clear bit 63 explicitly.
  let lo = value >>> 0;
  let hi = Math.floor(value / 0x1_0000_0000) >>> 0;
  for (let i = 0; i < 4; i++) {
    out[offset + i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 0; i < 4; i++) {
    out[offset + 4 + i] = hi & 0xff;
    hi >>>= 8;
  }
  // Clear bit 63 (high bit of byte[7]).
  out[offset + 7] = out[offset + 7]! & 0x7f;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- pae
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/crypto-paseto/src/pae.ts packages/crypto-paseto/src/__tests__/pae.test.ts
git commit -m "$(cat <<'EOF'
feat(crypto-paseto): add PAE encoder (Plan-025 P1)

Implement Pre-Authentication Encoding per paseto-spec Common.md §3.
LE64 length prefix has bit 63 cleared as specified. Unit tests cover
empty / single / two-piece cases plus high-bit-clear verification.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 3: Error taxonomy + v4.public primitive

**Files:**

- Create: `packages/crypto-paseto/src/errors.ts`
- Create: `packages/crypto-paseto/src/v4-public.ts`
- Create: `packages/crypto-paseto/src/__tests__/v4-public.test.ts`

**Spec source**: `paseto-spec/docs/01-Protocol-Versions/Version4.md` §v4.public. Algorithm:

```
sig = Ed25519.sign(PAE([header, payload, footer, implicitAssertion]), secretKey)
token = "v4.public." || b64url(payload || sig) [|| "." || b64url(footer)]
```

PureEdDSA (no pre-hash). Noble 2.x call shape is **message-first**: `ed25519.sign(message, secretKey)` and `ed25519.verify(signature, message, publicKey)`.

- [ ] **Step 1: Write the failing test (`src/__tests__/v4-public.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { generateV4PublicKeyPair, signV4Public, verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("v4.public sign / verify", () => {
  it("round-trips a payload sign→verify", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("hello, paseto");

    const token = signV4Public(payload, secretKey);
    expect(token.startsWith("v4.public.")).toBe(true);

    const verified = verifyV4Public(token, publicKey);
    expect(decoder.decode(verified)).toBe("hello, paseto");
  });

  it("round-trips with a footer", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const footer = encoder.encode("kid:k_2026_05");

    const token = signV4Public(payload, secretKey, footer);
    // Footer present → token has a 4th dot-segment.
    expect(token.split(".").length).toBe(4);

    const verified = verifyV4Public(token, publicKey, footer);
    expect(decoder.decode(verified)).toBe("payload");
  });

  it("round-trips with an implicit assertion (footer absent)", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const ia = encoder.encode("session:abc123");

    const token = signV4Public(payload, secretKey, undefined, ia);
    const verified = verifyV4Public(token, publicKey, undefined, ia);
    expect(decoder.decode(verified)).toBe("payload");
  });

  it("throws InvalidTokenError on a tampered signature", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const token = signV4Public(payload, secretKey);

    // Flip a bit somewhere in the b64url segment (after "v4.public.")
    const head = token.slice(0, "v4.public.".length);
    const body = token.slice("v4.public.".length);
    const tampered = head + body.replace(/.$/, (c) => (c === "A" ? "B" : "A"));

    expect(() => verifyV4Public(tampered, publicKey)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when verifying with the wrong public key", () => {
    const { secretKey } = generateV4PublicKeyPair();
    const { publicKey: otherPublic } = generateV4PublicKeyPair();
    const token = signV4Public(encoder.encode("payload"), secretKey);

    expect(() => verifyV4Public(token, otherPublic)).toThrow(InvalidTokenError);
  });

  it("rejects a token that does not start with v4.public.", () => {
    const { publicKey } = generateV4PublicKeyPair();
    expect(() => verifyV4Public("v4.local.AAAA", publicKey)).toThrow(InvalidTokenError);
    expect(() => verifyV4Public("v2.public.AAAA", publicKey)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when expected footer is absent from token", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const expectedFooter = encoder.encode("kid:k_1");
    // Sign without a footer; verify expects one.
    const token = signV4Public(payload, secretKey);
    expect(() => verifyV4Public(token, publicKey, expectedFooter)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when expected footer mismatches token footer", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const token = signV4Public(payload, secretKey, encoder.encode("kid:k_1"));
    expect(() => verifyV4Public(token, publicKey, encoder.encode("kid:k_2"))).toThrow(
      InvalidTokenError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- v4-public
```

Expected: FAIL — modules `../v4-public.js` and `../errors.js` missing.

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
/**
 * Error taxonomy for `@ai-sidekicks/crypto-paseto`.
 *
 * Messages are structural only — they carry no key, signature, plaintext,
 * or ciphertext bytes (invariant I4 in the design spec §5).
 */

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyError";
  }
}

export class MacMismatchError extends InvalidTokenError {
  constructor(message: string = "MAC mismatch") {
    super(message);
    this.name = "MacMismatchError";
  }
}
```

- [ ] **Step 4: Implement `src/v4-public.ts`**

```ts
import { ed25519 } from "@noble/curves/ed25519.js";
import { pae } from "./pae.js";
import { InvalidKeyError, InvalidTokenError } from "./errors.js";

const HEADER = "v4.public.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const SIGNATURE_LENGTH = 64; // Ed25519 signatures are 64 bytes.

export interface V4PublicKeyPair {
  readonly publicKey: Uint8Array; // 32 bytes
  readonly secretKey: Uint8Array; // 32 bytes (Ed25519 "seed" per RFC 8032)
}

export function generateV4PublicKeyPair(): V4PublicKeyPair {
  // noble-curves v2.x convenience helper: returns { secretKey, publicKey }
  // matching our V4PublicKeyPair shape. Equivalent to:
  //   const secretKey = ed25519.utils.randomSecretKey();
  //   const publicKey = ed25519.getPublicKey(secretKey);
  const pair = ed25519.keygen();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

export function signV4Public(
  payload: Uint8Array,
  secretKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  assertSecretKey(secretKey);

  const f = footer ?? new Uint8Array(0);
  const i = implicitAssertion ?? new Uint8Array(0);

  // PAE input order per paseto-spec §v4.public: [header, payload, footer, ia].
  const m2 = pae([HEADER_BYTES, payload, f, i]);
  const sig = ed25519.sign(m2, secretKey);

  const bodyBytes = concat(payload, sig);
  const body = base64UrlEncode(bodyBytes);

  return f.length === 0 ? `${HEADER}${body}` : `${HEADER}${body}.${base64UrlEncode(f)}`;
}

export function verifyV4Public(
  token: string,
  publicKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): Uint8Array {
  assertPublicKey(publicKey);

  if (!token.startsWith(HEADER)) {
    throw new InvalidTokenError("v4.public header mismatch");
  }

  const remainder = token.slice(HEADER.length);
  const parts = remainder.split(".");
  if (parts.length > 2) {
    throw new InvalidTokenError("v4.public token has too many segments");
  }

  // Footer canonicalization: undefined ≡ Uint8Array(0). See design spec §6.
  const expF = footer ?? new Uint8Array(0);
  const tokenFooterB64 = parts[1] ?? "";

  if (expF.length === 0 && tokenFooterB64.length > 0) {
    throw new InvalidTokenError("footer-absent-but-present");
  }
  if (expF.length > 0 && tokenFooterB64.length === 0) {
    throw new InvalidTokenError("footer-expected-but-absent");
  }

  let tokenFooter = new Uint8Array(0);
  if (tokenFooterB64.length > 0) {
    try {
      tokenFooter = base64UrlDecode(tokenFooterB64);
    } catch {
      throw new InvalidTokenError("footer base64url decode failed");
    }
    if (!bytesEqualStructural(expF, tokenFooter)) {
      throw new InvalidTokenError("footer mismatch");
    }
  }

  let bodyBytes: Uint8Array;
  try {
    bodyBytes = base64UrlDecode(parts[0]!);
  } catch {
    throw new InvalidTokenError("body base64url decode failed");
  }
  if (bodyBytes.length < SIGNATURE_LENGTH) {
    throw new InvalidTokenError("body too short for v4.public signature");
  }

  const sig = bodyBytes.subarray(bodyBytes.length - SIGNATURE_LENGTH);
  const payload = bodyBytes.subarray(0, bodyBytes.length - SIGNATURE_LENGTH);

  const ia = implicitAssertion ?? new Uint8Array(0);
  const m2 = pae([HEADER_BYTES, payload, tokenFooter, ia]);

  // Noble 2.x: ed25519.verify(signature, message, publicKey).
  let ok: boolean;
  try {
    ok = ed25519.verify(sig, m2, publicKey);
  } catch {
    throw new InvalidTokenError("signature decode failed");
  }
  if (!ok) {
    throw new InvalidTokenError("signature verification failed");
  }

  return payload;
}

function assertSecretKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.public secret key must be 32 bytes");
  }
}

function assertPublicKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.public public key must be 32 bytes");
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// Structural (non-secret) equality for footer comparison. Footer is public
// metadata; constant-time discipline is not required here.
function bytesEqualStructural(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- v4-public
```

Expected: PASS — all 8 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/crypto-paseto/src/errors.ts packages/crypto-paseto/src/v4-public.ts \
        packages/crypto-paseto/src/__tests__/v4-public.test.ts
git commit -m "$(cat <<'EOF'
feat(crypto-paseto): add v4.public sign/verify + error taxonomy

Ed25519 PureEdDSA per paseto-spec §v4.public. Noble 2.x message-first
call order. Error taxonomy: InvalidTokenError, InvalidKeyError,
MacMismatchError (extends InvalidTokenError so consumers can catch
all token-verification failures uniformly). No secret bytes in error
messages (invariant I4).

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 4: v4.local primitive + test-only deterministic seam

**Files:**

- Create: `packages/crypto-paseto/src/v4-local.ts`
- Create: `packages/crypto-paseto/src/internal/v4-local-deterministic.ts`
- Create: `packages/crypto-paseto/src/__tests__/v4-local.test.ts`

**Spec source**: `paseto-spec/docs/01-Protocol-Versions/Version4.md` §v4.local. Algorithm (NOT AEAD — see Plan-025 doc-drift):

```
1. h = "v4.local."
2. n = random 32 bytes
3. tmp = BLAKE2b(key=k, msg="paseto-encryption-key" || n, length=56)
   Ek = tmp[0..32]   (XChaCha20 encryption key)
   n2 = tmp[32..56]  (24-byte XChaCha20 nonce)
4. Ak = BLAKE2b(key=k, msg="paseto-auth-key-for-aead" || n, length=32)
5. c = XChaCha20(key=Ek, nonce=n2, msg=m)
6. t = BLAKE2b(key=Ak, msg=PAE([h, n, c, f, i]), length=32)
7. token = h || b64url(n || c || t) [|| "." || b64url(f)]
```

Decrypt is the inverse with **constant-time MAC compare before decryption** (invariant I2).

- [ ] **Step 1: Write the failing test (`src/__tests__/v4-local.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { encryptV4Local, decryptV4Local } from "../v4-local.js";
import { encryptV4LocalDeterministic } from "../internal/v4-local-deterministic.js";
import { InvalidTokenError, MacMismatchError, InvalidKeyError } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("v4.local encrypt / decrypt", () => {
  it("round-trips a payload encrypt→decrypt", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("hello, paseto-local");

    const token = encryptV4Local(payload, key);
    expect(token.startsWith("v4.local.")).toBe(true);

    const recovered = decryptV4Local(token, key);
    expect(decoder.decode(recovered)).toBe("hello, paseto-local");
  });

  it("produces a different token each time (nonce freshness)", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("payload");
    const t1 = encryptV4Local(payload, key);
    const t2 = encryptV4Local(payload, key);
    expect(t1).not.toBe(t2);
  });

  it("round-trips with a footer", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("payload");
    const footer = encoder.encode("kid:k_2026_05");
    const token = encryptV4Local(payload, key, footer);
    expect(token.split(".").length).toBe(4);
    const recovered = decryptV4Local(token, key, footer);
    expect(decoder.decode(recovered)).toBe("payload");
  });

  it("round-trips with an implicit assertion (footer absent)", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("payload");
    const ia = encoder.encode("session:abc");
    const token = encryptV4Local(payload, key, undefined, ia);
    const recovered = decryptV4Local(token, key, undefined, ia);
    expect(decoder.decode(recovered)).toBe("payload");
  });

  it("throws MacMismatchError when the MAC is tampered", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    // Flip the last character of the body segment (which contains MAC bytes).
    const head = "v4.local.";
    const body = token.slice(head.length);
    const tampered = head + body.slice(0, -1) + (body.slice(-1) === "A" ? "B" : "A");
    expect(() => decryptV4Local(tampered, key)).toThrow(MacMismatchError);
    // MacMismatchError extends InvalidTokenError — consumers can catch broadly.
    try {
      decryptV4Local(tampered, key);
    } catch (e) {
      expect(e instanceof InvalidTokenError).toBe(true);
    }
  });

  it("throws MacMismatchError when decrypting with the wrong key", () => {
    const key = randomBytes(32);
    const otherKey = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    expect(() => decryptV4Local(token, otherKey)).toThrow(MacMismatchError);
  });

  it("rejects a token that does not start with v4.local.", () => {
    const key = randomBytes(32);
    expect(() => decryptV4Local("v4.public.AAAA", key)).toThrow(InvalidTokenError);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptV4Local(encoder.encode("p"), new Uint8Array(16))).toThrow(InvalidKeyError);
    expect(() => decryptV4Local("v4.local.AAAA", new Uint8Array(16))).toThrow(InvalidKeyError);
  });

  it("test-only deterministic variant reproduces tokens given a fixed nonce", () => {
    const key = randomBytes(32);
    const nonce = randomBytes(32);
    const payload = encoder.encode("payload");
    const t1 = encryptV4LocalDeterministic(payload, key, nonce);
    const t2 = encryptV4LocalDeterministic(payload, key, nonce);
    expect(t1).toBe(t2);

    // Production path can decrypt what the deterministic variant produced.
    const recovered = decryptV4Local(t1, key);
    expect(decoder.decode(recovered)).toBe("payload");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- v4-local
```

Expected: FAIL — modules `../v4-local.js` and `../internal/v4-local-deterministic.js` missing.

- [ ] **Step 3: Implement `src/internal/v4-local-deterministic.ts`** (the seam, called by production)

```ts
import { xchacha20 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { pae } from "../pae.js";
import { InvalidKeyError } from "../errors.js";

/**
 * Internal-only deterministic v4.local encrypt.
 *
 * NOT re-exported from `src/index.ts`. Production callers must use
 * `encryptV4Local` from `../v4-local.ts`, which calls into this function with
 * a fresh random nonce. This seam exists so RFC vector encrypt round-trips
 * can feed the vector's recorded `nonce` and produce byte-exact tokens.
 *
 * Algorithm: paseto-spec/docs/01-Protocol-Versions/Version4.md §v4.local Encrypt.
 *
 * Step ordering matches the spec — do not reorder. Step 4 (MAC) computes over
 * the nonce, ciphertext, footer, and implicit assertion via PAE; never over
 * the plaintext.
 */

const HEADER = "v4.local.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const ENC_INFO = new TextEncoder().encode("paseto-encryption-key");
const AUTH_INFO = new TextEncoder().encode("paseto-auth-key-for-aead");

export function encryptV4LocalDeterministic(
  payload: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.local key must be 32 bytes");
  }
  if (nonce.length !== 32) {
    throw new InvalidKeyError("v4.local nonce must be 32 bytes");
  }

  const f = footer ?? new Uint8Array(0);
  const i = implicitAssertion ?? new Uint8Array(0);

  // Step 3: derive Ek (32) || n2 (24) = 56 bytes via BLAKE2b keyed by k.
  const tmp = blake2b(concat(ENC_INFO, nonce), { key, dkLen: 56 });
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);

  // Step 4: derive Ak — separate BLAKE2b derivation, NOT a slice of tmp.
  const ak = blake2b(concat(AUTH_INFO, nonce), { key, dkLen: 32 });

  // Step 5: encrypt.
  const ciphertext = xchacha20(ek, n2, payload);

  // Step 6: MAC over PAE([h, n, c, f, i]).
  const m2 = pae([HEADER_BYTES, nonce, ciphertext, f, i]);
  const tag = blake2b(m2, { key: ak, dkLen: 32 });

  // Step 7: assemble body and token.
  const body = concat3(nonce, ciphertext, tag);
  const bodyB64 = base64UrlEncode(body);
  return f.length === 0 ? `${HEADER}${bodyB64}` : `${HEADER}${bodyB64}.${base64UrlEncode(f)}`;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
```

- [ ] **Step 4: Implement `src/v4-local.ts`** (production surface + decrypt)

```ts
import { xchacha20 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { equalBytes, randomBytes } from "@noble/hashes/utils.js";
import { pae } from "./pae.js";
import { InvalidKeyError, InvalidTokenError, MacMismatchError } from "./errors.js";
import { encryptV4LocalDeterministic } from "./internal/v4-local-deterministic.js";

const HEADER = "v4.local.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const ENC_INFO = new TextEncoder().encode("paseto-encryption-key");
const AUTH_INFO = new TextEncoder().encode("paseto-auth-key-for-aead");
const NONCE_LEN = 32; // PASETO v4.local n
const TAG_LEN = 32; // BLAKE2b-MAC output

export function encryptV4Local(
  payload: Uint8Array,
  key: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  // Fresh 32-byte nonce per call (invariant I3). Never reused; never logged.
  const nonce = randomBytes(NONCE_LEN);
  return encryptV4LocalDeterministic(payload, key, nonce, footer, implicitAssertion);
}

export function decryptV4Local(
  token: string,
  key: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.local key must be 32 bytes");
  }

  if (!token.startsWith(HEADER)) {
    throw new InvalidTokenError("v4.local header mismatch");
  }

  const remainder = token.slice(HEADER.length);
  const parts = remainder.split(".");
  if (parts.length > 2) {
    throw new InvalidTokenError("v4.local token has too many segments");
  }

  // Footer canonicalization: undefined ≡ Uint8Array(0). Design spec §6.
  const expF = footer ?? new Uint8Array(0);
  const tokenFooterB64 = parts[1] ?? "";

  if (expF.length === 0 && tokenFooterB64.length > 0) {
    throw new InvalidTokenError("footer-absent-but-present");
  }
  if (expF.length > 0 && tokenFooterB64.length === 0) {
    throw new InvalidTokenError("footer-expected-but-absent");
  }

  let tokenFooter = new Uint8Array(0);
  if (tokenFooterB64.length > 0) {
    try {
      tokenFooter = base64UrlDecode(tokenFooterB64);
    } catch {
      throw new InvalidTokenError("footer base64url decode failed");
    }
    if (!bytesEqualStructural(expF, tokenFooter)) {
      throw new InvalidTokenError("footer mismatch");
    }
  }

  let body: Uint8Array;
  try {
    body = base64UrlDecode(parts[0]!);
  } catch {
    throw new InvalidTokenError("body base64url decode failed");
  }
  if (body.length < NONCE_LEN + TAG_LEN) {
    throw new InvalidTokenError("body too short for v4.local n||c||t layout");
  }

  const nonce = body.subarray(0, NONCE_LEN);
  const ciphertext = body.subarray(NONCE_LEN, body.length - TAG_LEN);
  const tag = body.subarray(body.length - TAG_LEN);

  // Derive Ek, n2, Ak — identical to encrypt path.
  const tmp = blake2b(concat(ENC_INFO, nonce), { key, dkLen: 56 });
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);
  const ak = blake2b(concat(AUTH_INFO, nonce), { key, dkLen: 32 });

  // Step 4 (decrypt): MAC verify BEFORE decryption. Constant-time compare.
  const ia = implicitAssertion ?? new Uint8Array(0);
  const m2 = pae([HEADER_BYTES, nonce, ciphertext, tokenFooter, ia]);
  const expectedTag = blake2b(m2, { key: ak, dkLen: TAG_LEN });

  if (!equalBytes(tag, expectedTag)) {
    throw new MacMismatchError("v4.local MAC mismatch");
  }

  // Step 5 (decrypt): only reached after MAC verifies. XChaCha20 is a stream
  // cipher — same call shape for encrypt and decrypt.
  return xchacha20(ek, n2, ciphertext);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64UrlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// Structural (non-secret) equality for footer comparison only.
function bytesEqualStructural(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- v4-local
```

Expected: PASS — all 9 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/crypto-paseto/src/v4-local.ts \
        packages/crypto-paseto/src/internal/v4-local-deterministic.ts \
        packages/crypto-paseto/src/__tests__/v4-local.test.ts
git commit -m "$(cat <<'EOF'
feat(crypto-paseto): add v4.local encrypt/decrypt + det. nonce seam

XChaCha20 stream cipher + BLAKE2b-MAC per paseto-spec §v4.local
(NOT XChaCha20-Poly1305 AEAD — Plan-025 doc-drift item).
MAC-verify-before-decrypt (invariant I2). Constant-time tag compare
via @noble/hashes equalBytes (I1). Fresh 32-byte random nonce per
encrypt (I3). Test-only deterministic-nonce variant under src/internal/
is NOT re-exported via src/index.ts — production path is nonce-safe
by construction.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 5: KeyRing (in-memory) + rotation semantics

**Files:**

- Create: `packages/crypto-paseto/src/key-ring.ts`
- Create: `packages/crypto-paseto/src/__tests__/key-ring.test.ts`

**Design source**: design spec §3.3 + §8. Invariants enforced at construction:

1. **At least one active entry** (`retiredAt: undefined`) — zero active → `InvalidKeyError`.
2. **At most one active entry** — more than one active → `InvalidKeyError`.

`rotate(next)` returns a **new** `KeyRing` instance; the prior active entry's `retiredAt` is set to the rotation timestamp in the new instance. The pre-rotation instance is unchanged.

- [ ] **Step 1: Write the failing test (`src/__tests__/key-ring.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { KeyRing, type KeyRingEntry } from "../key-ring.js";
import { InvalidKeyError } from "../errors.js";

function entry(id: string, retiredAt?: Date): KeyRingEntry {
  return {
    id,
    key: randomBytes(32),
    createdAt: new Date("2026-05-01T00:00:00Z"),
    retiredAt,
  };
}

describe("KeyRing", () => {
  it("constructs with exactly one active entry", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(ring.active().id).toBe("k_1");
  });

  it("constructs with multiple entries when only one is active", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1");
    const ring = new KeyRing([retired, active]);
    expect(ring.active().id).toBe("k_1");
  });

  it("throws InvalidKeyError when constructed with zero active entries", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    expect(() => new KeyRing([retired])).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError when constructed with no entries at all", () => {
    expect(() => new KeyRing([])).toThrow(InvalidKeyError);
  });

  it("throws InvalidKeyError when constructed with more than one active entry", () => {
    expect(() => new KeyRing([entry("k_a"), entry("k_b")])).toThrow(InvalidKeyError);
  });

  it("byId returns active entries", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(ring.byId("k_1")?.id).toBe("k_1");
  });

  it("byId returns retired entries", () => {
    const retired = entry("k_0", new Date("2026-04-01T00:00:00Z"));
    const active = entry("k_1");
    const ring = new KeyRing([retired, active]);
    expect(ring.byId("k_0")?.id).toBe("k_0");
    expect(ring.byId("k_0")?.retiredAt).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("byId returns undefined for unknown id", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(ring.byId("k_missing")).toBeUndefined();
  });

  it("rotate returns a new instance; prior instance is unchanged", () => {
    const ring1 = new KeyRing([entry("k_1")]);
    const next = entry("k_2");
    const ring2 = ring1.rotate(next);
    expect(ring2).not.toBe(ring1);
    expect(ring1.active().id).toBe("k_1"); // unchanged
    expect(ring2.active().id).toBe("k_2");
  });

  it("rotate retires the prior active entry in the new instance", () => {
    const ring1 = new KeyRing([entry("k_1")]);
    const ring2 = ring1.rotate(entry("k_2"));
    const retired = ring2.byId("k_1");
    expect(retired?.retiredAt).toBeInstanceOf(Date);
  });

  it("rotate refuses a `next` that is already retired", () => {
    const ring = new KeyRing([entry("k_1")]);
    const retiredNext = entry("k_2", new Date("2026-04-01T00:00:00Z"));
    expect(() => ring.rotate(retiredNext)).toThrow(InvalidKeyError);
  });

  it("rotate refuses a `next` whose id collides with an existing entry", () => {
    const ring = new KeyRing([entry("k_1")]);
    expect(() => ring.rotate(entry("k_1"))).toThrow(InvalidKeyError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- key-ring
```

Expected: FAIL — module `../key-ring.js` missing.

- [ ] **Step 3: Implement `src/key-ring.ts`**

```ts
import { InvalidKeyError } from "./errors.js";

export interface KeyRingEntry {
  readonly id: string; // e.g., "k_2026_05"
  readonly key: Uint8Array; // 32 bytes
  readonly createdAt: Date;
  readonly retiredAt?: Date; // undefined when active
}

/**
 * In-memory key ring with rotation semantics.
 *
 * Phase 1 scope: no persistence, no I/O. Plan-018 Tier 5 will load entries
 * from its storage backend and hand them to the constructor.
 *
 * Constructor invariants (design spec §3.3):
 *   1. At least one entry with `retiredAt: undefined` (active).
 *   2. At most one entry with `retiredAt: undefined`.
 *   Together: exactly one active entry per instance.
 */
export class KeyRing {
  readonly #entries: readonly KeyRingEntry[];

  constructor(entries: readonly KeyRingEntry[]) {
    const active = entries.filter((e) => e.retiredAt === undefined);
    if (active.length === 0) {
      throw new InvalidKeyError("KeyRing requires at least one active entry");
    }
    if (active.length > 1) {
      throw new InvalidKeyError("KeyRing requires at most one active entry");
    }
    // Defensive copy so callers can't mutate our backing array.
    this.#entries = [...entries];
  }

  active(): KeyRingEntry {
    // Invariant guarantees exactly one match.
    return this.#entries.find((e) => e.retiredAt === undefined)!;
  }

  byId(id: string): KeyRingEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }

  /**
   * Returns a **new** `KeyRing` instance with the prior active entry retired
   * (its `retiredAt` set to the rotation timestamp) and `next` as the new
   * active entry. The pre-rotation instance is unchanged.
   *
   * Callers must reassign the variable holding the `KeyRing` after rotation —
   * `keyRing = keyRing.rotate(next)`. Calling `rotate()` and discarding the
   * return value silently keeps the old key active. See design spec §8.3.
   */
  rotate(next: KeyRingEntry): KeyRing {
    if (next.retiredAt !== undefined) {
      throw new InvalidKeyError("rotate() refuses a `next` that is already retired");
    }
    if (this.#entries.some((e) => e.id === next.id)) {
      throw new InvalidKeyError(`rotate() refuses duplicate entry id: ${next.id}`);
    }
    const now = new Date();
    const retiredPrior = this.#entries.map((e) =>
      e.retiredAt === undefined ? { ...e, retiredAt: now } : e,
    );
    return new KeyRing([...retiredPrior, next]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- key-ring
```

Expected: PASS — all 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/crypto-paseto/src/key-ring.ts packages/crypto-paseto/src/__tests__/key-ring.test.ts
git commit -m "$(cat <<'EOF'
feat(crypto-paseto): add in-memory KeyRing with rotation

KeyRing constructor enforces exactly-one-active invariant. rotate(next)
is immutable — returns a new instance with the prior active entry's
retiredAt set to the rotation timestamp. No persistence at this layer;
Plan-018 Tier 5 owns the storage backend per cross-plan-deps §5.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 6: Footer / implicit-assertion canonicalization tests

**Files:**

- Create: `packages/crypto-paseto/src/__tests__/footer-canonicalization.test.ts`

**Design source**: spec §6. The canonicalization rule:

> `undefined ≡ new Uint8Array(0)` at the public API boundary.

Both `v4.public` and `v4.local` already implement this (Task 3 and Task 4). This task adds explicit cross-module tests to lock the behavior in.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { generateV4PublicKeyPair, signV4Public, verifyV4Public } from "../v4-public.js";
import { encryptV4Local, decryptV4Local } from "../v4-local.js";
import { InvalidTokenError } from "../errors.js";

const encoder = new TextEncoder();
const empty = new Uint8Array(0);

describe("footer / implicit-assertion canonicalization (undefined ≡ Uint8Array(0))", () => {
  describe("v4.public", () => {
    it("signing with `undefined` footer matches signing with empty Uint8Array footer", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const payload = encoder.encode("payload");

      const tokenUndef = signV4Public(payload, secretKey, undefined);
      const tokenEmpty = signV4Public(payload, secretKey, empty);

      // Ed25519 is deterministic — undefined and empty must produce the same token.
      expect(tokenUndef).toBe(tokenEmpty);
      // Neither should have a footer segment.
      expect(tokenUndef.split(".").length).toBe(3);
    });

    it("verify accepts either form for an unfooted token", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const token = signV4Public(encoder.encode("p"), secretKey);
      expect(() => verifyV4Public(token, publicKey, undefined)).not.toThrow();
      expect(() => verifyV4Public(token, publicKey, empty)).not.toThrow();
    });

    it("implicit assertion `undefined` and empty Uint8Array sign to the same token", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const payload = encoder.encode("payload");
      const t1 = signV4Public(payload, secretKey, undefined, undefined);
      const t2 = signV4Public(payload, secretKey, undefined, empty);
      expect(t1).toBe(t2);
      expect(() => verifyV4Public(t1, publicKey, undefined, empty)).not.toThrow();
    });

    it("rejects mismatch: footer expected, token has none", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const token = signV4Public(encoder.encode("p"), secretKey);
      expect(() => verifyV4Public(token, publicKey, encoder.encode("kid"))).toThrow(
        InvalidTokenError,
      );
    });

    it("rejects mismatch: footer absent expected, token has one", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const token = signV4Public(encoder.encode("p"), secretKey, encoder.encode("kid"));
      expect(() => verifyV4Public(token, publicKey, undefined)).toThrow(InvalidTokenError);
      expect(() => verifyV4Public(token, publicKey, empty)).toThrow(InvalidTokenError);
    });
  });

  describe("v4.local", () => {
    it("implicit assertion `undefined` and empty Uint8Array round-trip equivalently", () => {
      const key = randomBytes(32);
      const payload = encoder.encode("payload");
      const t1 = encryptV4Local(payload, key, undefined, undefined);
      // Same token can be decrypted with either undefined or empty IA.
      expect(() => decryptV4Local(t1, key, undefined, undefined)).not.toThrow();
      expect(() => decryptV4Local(t1, key, undefined, empty)).not.toThrow();
    });

    it("decrypt accepts either footer form for an unfooted token", () => {
      const key = randomBytes(32);
      const token = encryptV4Local(encoder.encode("p"), key);
      expect(() => decryptV4Local(token, key, undefined)).not.toThrow();
      expect(() => decryptV4Local(token, key, empty)).not.toThrow();
    });

    it("rejects mismatch: footer expected, token has none", () => {
      const key = randomBytes(32);
      const token = encryptV4Local(encoder.encode("p"), key);
      expect(() => decryptV4Local(token, key, encoder.encode("kid"))).toThrow(InvalidTokenError);
    });

    it("rejects mismatch: footer absent expected, token has one", () => {
      const key = randomBytes(32);
      const token = encryptV4Local(encoder.encode("p"), key, encoder.encode("kid"));
      expect(() => decryptV4Local(token, key, undefined)).toThrow(InvalidTokenError);
      expect(() => decryptV4Local(token, key, empty)).toThrow(InvalidTokenError);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- footer-canonicalization
```

Expected: PASS — all 9 tests green. (Behavior was implemented in Tasks 3+4; this test pins it down.)

- [ ] **Step 3: Commit**

```bash
git add packages/crypto-paseto/src/__tests__/footer-canonicalization.test.ts
git commit -m "$(cat <<'EOF'
test(crypto-paseto): pin footer / IA canonicalization rule

Cross-module tests assert undefined ≡ Uint8Array(0) for both
v4.public and v4.local, plus expected/actual footer mismatch
rejections. Locks in design spec §6 canonicalization rule.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 7: Public barrel (Phase 4)

**Files:**

- Modify: `packages/crypto-paseto/src/index.ts` (replace placeholder)

The barrel re-exports every production symbol. The `src/internal/` deterministic seam is **not** re-exported.

- [ ] **Step 1: Replace `src/index.ts` with the populated barrel**

```ts
export * from "./pae.js";
export * from "./errors.js";
export * from "./v4-public.js";
export * from "./v4-local.js";
export * from "./key-ring.js";
```

- [ ] **Step 2: Verify the build produces dist with all surface exports**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto build
```

Expected: writes `packages/crypto-paseto/dist/index.js` + `dist/index.d.ts`. Inspect `dist/index.d.ts` and confirm it re-exports `pae`, `InvalidTokenError`, `InvalidKeyError`, `MacMismatchError`, `generateV4PublicKeyPair`, `signV4Public`, `verifyV4Public`, `V4PublicKeyPair`, `encryptV4Local`, `decryptV4Local`, `KeyRing`, `KeyRingEntry`.

```bash
grep -E "(^export|^declare)" packages/crypto-paseto/dist/index.d.ts | head -30
```

Expected: lines for each public symbol above. **Verify `encryptV4LocalDeterministic` is NOT present** — it lives under `src/internal/` and must not leak into the public surface.

- [ ] **Step 3: Smoke-import from `packages/control-plane/`**

From repo root:

```bash
pnpm --filter @ai-sidekicks/control-plane exec node --input-type=module -e \
  "import('@ai-sidekicks/crypto-paseto').then(m => console.log(Object.keys(m).sort()))"
```

Expected: prints a sorted list of the public symbols above.

- [ ] **Step 4: Commit**

```bash
git add packages/crypto-paseto/src/index.ts
git commit -m "$(cat <<'EOF'
feat(crypto-paseto): populate public barrel (src/index.ts)

Flat barrel mirrors packages/contracts/. Re-exports pae, v4.public,
v4.local, KeyRing, and the error taxonomy. The src/internal/
deterministic-nonce seam is NOT re-exported — production callers
cannot inject a nonce.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 8: Vendor RFC test vectors + provenance

**Files:**

- Create: `packages/crypto-paseto/src/__tests__/__fixtures__/v4.json`
- Create: `packages/crypto-paseto/src/__tests__/__fixtures__/PROVENANCE.md`
- Conditionally modify: gitleaks config (only if Step 4 surfaces a flag)

**Vendor source**: `https://github.com/paseto-standard/test-vectors/blob/master/v4.json`. Pin to a specific commit SHA. Vendoring is hermetic — no network calls in tests.

- [ ] **Step 1: Download `v4.json` and record provenance**

```bash
mkdir -p packages/crypto-paseto/src/__tests__/__fixtures__
cd packages/crypto-paseto/src/__tests__/__fixtures__

# Capture commit SHA from the upstream raw URL pinning to a specific tree.
# Use `gh` or curl against the GitHub API to resolve master → SHA at fetch time.
UPSTREAM_SHA=$(gh api repos/paseto-standard/test-vectors/commits/master --jq .sha)
echo "Upstream SHA at fetch time: $UPSTREAM_SHA"

curl --fail --show-error --silent --location \
  "https://raw.githubusercontent.com/paseto-standard/test-vectors/$UPSTREAM_SHA/v4.json" \
  -o v4.json

# Compute sha256 of the vendored file.
FIXTURE_SHA256=$(shasum -a 256 v4.json | awk '{print $1}')
echo "v4.json sha256: $FIXTURE_SHA256"

# Verify the JSON parses and has the expected schema (sanity check).
node --input-type=module -e "
  const f = await import('node:fs/promises');
  const j = JSON.parse(await f.readFile('v4.json', 'utf8'));
  if (!Array.isArray(j.tests)) throw new Error('expected j.tests to be an array');
  const counts = j.tests.reduce((acc, t) => {
    if (t.name.startsWith('4-S-')) acc.public++;
    else if (t.name.startsWith('4-E-')) acc.local++;
    else acc.other++;
    return acc;
  }, { public: 0, local: 0, other: 0 });
  console.log(JSON.stringify(counts));
"
```

Expected: `counts` shows non-zero `public` and `local` counts (typical: 9 each, plus 2+ negative vectors). Record `$UPSTREAM_SHA` and `$FIXTURE_SHA256` for the next step.

- [ ] **Step 2: Write `__fixtures__/PROVENANCE.md`**

Replace the `<placeholder>` values with the actual SHAs from Step 1.

```markdown
# `v4.json` — vendored upstream test vectors

**Source**: https://github.com/paseto-standard/test-vectors/blob/master/v4.json **Upstream commit SHA**: `<UPSTREAM_SHA from Step 1>` **Retrieval date**: 2026-05-20 (or current date when run) **SHA-256 of vendored file**: `<FIXTURE_SHA256 from Step 1>`

## Update protocol

When upstream publishes new vectors:

1. Re-run the download + `shasum -a 256` from `Task 8 Step 1` of the implementation plan.
2. Update this file with the new commit SHA + sha256.
3. Run `pnpm --filter @ai-sidekicks/crypto-paseto test` to confirm the suite still passes.
4. Commit as a single follow-up PR: `chore(crypto-paseto): bump RFC v4 vector fixture`.

## Audit log

| Date       | Commit SHA       | sha256             | Reason                                     |
| ---------- | ---------------- | ------------------ | ------------------------------------------ |
| 2026-05-20 | `<UPSTREAM_SHA>` | `<FIXTURE_SHA256>` | Initial vendor for Plan-025 Tier 1 Partial |
```

- [ ] **Step 3: Stage the fixture and run gitleaks locally**

```bash
git add packages/crypto-paseto/src/__tests__/__fixtures__/v4.json \
        packages/crypto-paseto/src/__tests__/__fixtures__/PROVENANCE.md

# Run gitleaks against staged changes. If not installed locally, CI is the
# authoritative gate per the dotfiles bootstrap note.
gitleaks detect --staged --no-banner --redact 2>&1 | tee /tmp/gitleaks-output.txt
```

Expected: one of two outcomes:

- **(A) No findings.** Move on to Step 5.
- **(B) Findings.** Gitleaks may flag the hex test keys in `v4.json`. Note the rule name(s) in the output (e.g., `generic-api-key`).

- [ ] **Step 4: (Conditional) Add a scoped gitleaks allowlist entry**

Only execute this step if Step 3 reported findings. Edit `.gitleaks.toml` at the repo root and append a new top-level `[[allowlists]]` array entry (gitleaks v8.18+ supports the plural-array form alongside the existing single `[allowlist]` block):

```toml
[[allowlists]]
description = "PASETO v4 RFC test vectors (hex keys are deliberate; vendored from paseto-standard/test-vectors)"
paths = [
  '''packages/crypto-paseto/src/__tests__/__fixtures__/v4\.json''',
]
```

If the installed gitleaks version does not support `[[allowlists]]` (older v8.x), instead extend the existing top-level `[allowlist]` block by adding a `paths` field — but **prefer the `[[allowlists]]` form** when supported because it keeps the AWS-KMS-enum allowlist semantically separate from the fixture allowlist.

Re-run `gitleaks detect --staged --no-banner --redact` and confirm zero findings. Add `.gitleaks.toml` to staging.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(crypto-paseto): vendor PASETO v4 RFC test vectors

Pin upstream paseto-standard/test-vectors v4.json to a specific commit
SHA recorded in PROVENANCE.md alongside sha256. Hermetic CI — no
network calls from test runs. Updates handled by follow-up PRs that
bump the SHA in PROVENANCE.md.

Refs: ADR-010, Plan-025
EOF
)"
```

If Step 4 added a gitleaks allow-list change, include the config file in the same `git add` before commit.

---

## Task 9: RFC vector suite — v4.public conformance

**Files:**

- Create: `packages/crypto-paseto/src/__tests__/rfc-vectors-v4-public.test.ts`

**Vector schema** (verified against upstream `v4.json`):

```json
{
  "tests": [
    {
      "name": "4-S-1",
      "expect-fail": false,
      "public-key": "<hex>",
      "secret-key": "<hex>",
      "secret-key-seed": "<hex>",
      "secret-key-pem": "...",
      "public-key-pem": "...",
      "token": "v4.public....",
      "payload": "{\"data\":\"...\"}",
      "footer": "",
      "implicit-assertion": ""
    }
  ]
}
```

Filter: `name.startsWith("4-S-")`. Each positive vector: `verifyV4Public(token, publicKey, footer, ia)` returns the expected payload bytes; sign round-trip produces byte-exact token (Ed25519 is deterministic). Negative vectors: `verifyV4Public(...)` throws an `InvalidTokenError` (or subclass).

- [ ] **Step 1: Write the test file**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signV4Public, verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

interface PasetoV4Vector {
  name: string;
  "expect-fail": boolean;
  "public-key"?: string;
  "secret-key"?: string;
  "secret-key-seed"?: string;
  token: string;
  payload: string | null;
  footer: string;
  "implicit-assertion": string;
}

interface VectorFile {
  tests: PasetoV4Vector[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "__fixtures__/v4.json");
const FILE: VectorFile = JSON.parse(readFileSync(FIXTURE, "utf8"));

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// Some vectors record secret-key as 64 bytes (Ed25519 seed||public). Noble 2.x
// accepts the 32-byte seed; we slice the seed if a 64-byte secret-key is given.
function seedFromVector(v: PasetoV4Vector): Uint8Array {
  if (v["secret-key-seed"]) return hex(v["secret-key-seed"]);
  if (v["secret-key"]) {
    const raw = hex(v["secret-key"]);
    return raw.length === 64 ? raw.subarray(0, 32) : raw;
  }
  throw new Error(`vector ${v.name} missing secret-key / secret-key-seed`);
}

describe("PASETO v4.public RFC vector conformance (4-S-*)", () => {
  const publicVectors = FILE.tests.filter((t) => t.name.startsWith("4-S-"));

  it("filter covers at least one positive and one negative vector", () => {
    expect(publicVectors.length).toBeGreaterThan(0);
    expect(publicVectors.some((v) => !v["expect-fail"])).toBe(true);
  });

  for (const v of publicVectors) {
    if (v["expect-fail"]) {
      it(`${v.name} (negative) — verify throws InvalidTokenError`, () => {
        const pub = hex(v["public-key"]!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        expect(() => verifyV4Public(v.token, pub, footer, ia)).toThrow(InvalidTokenError);
      });
    } else {
      it(`${v.name} (positive) — verify returns expected payload`, () => {
        const pub = hex(v["public-key"]!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const recovered = verifyV4Public(v.token, pub, footer, ia);
        expect(utf8Decode(recovered)).toBe(v.payload);
      });

      it(`${v.name} (positive) — sign round-trip reproduces vector token byte-exact`, () => {
        const seed = seedFromVector(v);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const produced = signV4Public(utf8(v.payload!), seed, footer, ia);
        expect(produced).toBe(v.token);
      });
    }
  }

  it(`processed ${publicVectors.length} vectors`, () => {
    expect(publicVectors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- rfc-vectors-v4-public
```

Expected: PASS — every `4-S-*` vector verifies; sign round-trips produce byte-exact tokens.

If any positive vector fails the sign round-trip with a byte mismatch, this is a real conformance bug. Investigate the failing vector's payload bytes vs. the spec — common causes: wrong PAE input order, wrong key derivation, or a base64url canonicalization issue. Fix and re-run before moving on. **Do not skip failing vectors.**

If a fixture-schema surprise surfaces (e.g., an upstream vector adds a new field), update the `PasetoV4Vector` interface and `seedFromVector` helper accordingly.

- [ ] **Step 3: Commit**

```bash
git add packages/crypto-paseto/src/__tests__/rfc-vectors-v4-public.test.ts
git commit -m "$(cat <<'EOF'
test(crypto-paseto): RFC v4.public vector conformance suite

Iterates upstream 4-S-* vectors. Positive vectors assert verify
returns the expected payload AND sign round-trip reproduces the
recorded token byte-exact (Ed25519 is deterministic). Negative
vectors assert verify throws InvalidTokenError. Non-zero-count
guard defends against an accidentally-empty filter.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 10: RFC vector suite — v4.local conformance

**Files:**

- Create: `packages/crypto-paseto/src/__tests__/rfc-vectors-v4-local.test.ts`

Filter: `name.startsWith("4-E-")`. Each positive vector: `decryptV4Local(token, key, footer, ia)` returns the expected payload bytes; the test-only `encryptV4LocalDeterministic(payload, key, vector.nonce, footer, ia)` reproduces the vector's token byte-exact. Negative vectors throw `InvalidTokenError`.

- [ ] **Step 1: Write the test file**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptV4Local } from "../v4-local.js";
import { encryptV4LocalDeterministic } from "../internal/v4-local-deterministic.js";
import { InvalidTokenError } from "../errors.js";

interface PasetoV4Vector {
  name: string;
  "expect-fail": boolean;
  key?: string;
  nonce?: string;
  token: string;
  payload: string | null;
  footer: string;
  "implicit-assertion": string;
}

interface VectorFile {
  tests: PasetoV4Vector[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "__fixtures__/v4.json");
const FILE: VectorFile = JSON.parse(readFileSync(FIXTURE, "utf8"));

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

describe("PASETO v4.local RFC vector conformance (4-E-*)", () => {
  const localVectors = FILE.tests.filter((t) => t.name.startsWith("4-E-"));

  it("filter covers at least one positive vector", () => {
    expect(localVectors.length).toBeGreaterThan(0);
    expect(localVectors.some((v) => !v["expect-fail"])).toBe(true);
  });

  for (const v of localVectors) {
    if (v["expect-fail"]) {
      it(`${v.name} (negative) — decrypt throws InvalidTokenError`, () => {
        const key = hex(v.key!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        expect(() => decryptV4Local(v.token, key, footer, ia)).toThrow(InvalidTokenError);
      });
    } else {
      it(`${v.name} (positive) — decrypt returns expected payload`, () => {
        const key = hex(v.key!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const recovered = decryptV4Local(v.token, key, footer, ia);
        expect(utf8Decode(recovered)).toBe(v.payload);
      });

      it(`${v.name} (positive) — deterministic encrypt reproduces vector token byte-exact`, () => {
        const key = hex(v.key!);
        const nonce = hex(v.nonce!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const produced = encryptV4LocalDeterministic(utf8(v.payload!), key, nonce, footer, ia);
        expect(produced).toBe(v.token);
      });
    }
  }

  it(`processed ${localVectors.length} vectors`, () => {
    expect(localVectors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
pnpm --filter @ai-sidekicks/crypto-paseto test -- rfc-vectors-v4-local
```

Expected: PASS — every `4-E-*` vector decrypts; deterministic encrypts produce byte-exact tokens.

If any positive vector fails the encrypt round-trip, investigate as in Task 9 Step 2 — likely culprits are PAE input ordering, key-derivation step (`tmp[0..32]` vs `tmp[32..56]` split), or XChaCha20 nonce mis-handling. **Do not skip failing vectors.**

If a vector divergence cannot be resolved (e.g., noble 2.x produces a different ciphertext than the vector expects), file `BL-NNN` per the source plan's Risk row 8 and surface to the PR description before merge.

- [ ] **Step 3: Commit**

```bash
git add packages/crypto-paseto/src/__tests__/rfc-vectors-v4-local.test.ts
git commit -m "$(cat <<'EOF'
test(crypto-paseto): RFC v4.local vector conformance suite

Iterates upstream 4-E-* vectors. Positive vectors assert decrypt
returns the expected payload AND deterministic-encrypt reproduces
the recorded token byte-exact (consumes the vector's nonce field via
the internal seam). Negative vectors assert decrypt throws
InvalidTokenError. Non-zero-count guard defends against an
accidentally-empty filter.

Closes the ADR-010 "RFC conformance gating release" criterion.

Refs: ADR-010, Plan-025
EOF
)"
```

---

## Task 11: End-to-end verification gates + PR

**Files:** (none modified — verification only, plus PR creation)

This task runs the gates listed in the source plan's §Verification — End-to-End Gates table and creates the PR.

- [ ] **Step 1: Run all verification gates from repo root**

| Gate | Command | Expected |
| --- | --- | --- |
| Install | `pnpm install` | No lockfile drift; new workspace already resolved |
| Typecheck (package) | `pnpm --filter @ai-sidekicks/crypto-paseto typecheck` | Clean |
| Lint (package) | `pnpm --filter @ai-sidekicks/crypto-paseto lint` | Clean |
| Test (package) | `pnpm --filter @ai-sidekicks/crypto-paseto test` | All suites pass; non-zero vector counts |
| Build (package) | `pnpm --filter @ai-sidekicks/crypto-paseto build` | `dist/index.{js,d.ts}` produced |
| Typecheck (workspace) | `pnpm typecheck` | All packages clean |
| Lint (workspace) | `pnpm lint` | Clean |
| Test (workspace) | `pnpm test` | All packages pass |
| Build (workspace) | `pnpm build` | All packages build |
| Format check | `pnpm format:check` | Clean (or run `pnpm format` to fix) |

Run each in sequence; do not proceed past a failing gate.

- [ ] **Step 2: Smoke-import test from `packages/control-plane/`**

```bash
pnpm --filter @ai-sidekicks/control-plane exec node --input-type=module -e \
  "import('@ai-sidekicks/crypto-paseto').then(m => {
    if (typeof m.signV4Public !== 'function') process.exit(1);
    if (typeof m.encryptV4Local !== 'function') process.exit(1);
    if (typeof m.KeyRing !== 'function') process.exit(1);
    if ('encryptV4LocalDeterministic' in m) {
      console.error('LEAK: deterministic seam exported via barrel');
      process.exit(1);
    }
    console.log('crypto-paseto barrel resolves');
  })"
```

Expected: `crypto-paseto barrel resolves`. Exit code 0.

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin feat/plan-025-tier-1-partial-crypto-paseto
```

Then create the PR with `gh`:

```bash
gh pr create --base develop \
  --title "feat(crypto-paseto): ship PASETO v4 substrate (Plan-025 Tier 1 Partial)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `@ai-sidekicks/crypto-paseto` workspace package: PASETO v4.public + v4.local primitives, PAE helper, in-memory KeyRing.
- Implements ADR-010:129–136 in-house-lib mandate; no upstream PASETO library consumed.
- RFC v4 vector conformance suites (`4-S-*` and `4-E-*`) gate the release per ADR-010 acceptance criterion.

## Plan-025 doc-drift acknowledgement

The PASETO v4.local algorithm is **XChaCha20 stream cipher + BLAKE2b-MAC** — NOT XChaCha20-Poly1305 AEAD as Plan-025 §Implementation Steps 2 narrates. Implementation follows the primary spec (paseto-standard/paseto-spec §v4.local). Follow-up: file `BL-NNN` post-merge to amend Plan-025.

## Noble 2.x override

Dependencies use `@noble/curves@^2`, `@noble/ciphers@^2`, `@noble/hashes@^2` (Paul Miller self-audit, April 2026). The 1.x line is externally audited (Cure53 / Kudelski); user-confirmed override of "audited 1.x" recommendation. Re-evaluation milestone: V1.1 if/when 2.x receives external audit.

## ADR-010 acceptance criteria

- [x] In-house lib — `packages/crypto-paseto/`; no upstream PASETO library consumed
- [x] Dual-primitive coverage — v4.public + v4.local
- [x] Audited deps — `@noble/*@^2` (override per above)
- [x] RFC conformance gating release — both vector suites pass

## Test plan

- [x] `pnpm --filter @ai-sidekicks/crypto-paseto test` — all suites green
- [x] `pnpm --filter @ai-sidekicks/crypto-paseto typecheck` clean
- [x] `pnpm --filter @ai-sidekicks/crypto-paseto build` produces `dist/index.{js,d.ts}`
- [x] Smoke-import from `packages/control-plane/` resolves `KeyRing`, `signV4Public`, etc.; deterministic seam NOT exported
- [x] Workspace-wide `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green

## Governance

- Carve-out: Plan-025 Tier 1 Partial Phase 1, `audit_status: substrate_exempt`. Plan-readiness audit gates G1–G6 do not apply; ADR-010 ACs apply at code-review time. Carve-out governance landed in PR #86.
- Design spec: `docs/superpowers/specs/2026-05-20-crypto-paseto-substrate-design.md`.
- Implementation plan: `docs/superpowers/plans/2026-05-20-crypto-paseto-substrate.md`.

Refs: ADR-010, Plan-025

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Mark PR ready (`gh pr ready <num>`) so Codex auto-review fires. The squash-merge subject line is the PR title.

---

## Task 12: Post-merge bookkeeping (separate follow-up PRs)

This task is **not** part of the code PR — it's the doc-only follow-ups owed after the substrate merges. Track via the workflow below; each item gets its own `docs(repo): …` PR per CONTRIBUTING.md and `feedback_housekeeping_always_via_pr`.

- [ ] **Item 1: Plan-002 Phase 2 precondition update**

File: `docs/plans/002-invite-membership-and-presence.md`. Phase 2 precondition reads "Plan-025 Tier 1 Partial merged". Update its satisfaction state and cite this PR's squash-merge SHA on `develop`.

- [ ] **Item 2: File `BL-NNN` — Plan-025 doc drift**

Open a new backlog item under `docs/backlog.md` with:

- Title: `Plan-025 narrative drift: v4.local algorithm + test-dir + vector-file shape`
- References: Plan-025 lines 72–74 (cf. design spec §4.3 + this plan's Phase-level Doc-drift acknowledgement)
- Exit criteria: Plan-025 §Implementation Steps 2 amended to "XChaCha20 stream cipher + BLAKE2b-MAC over PAE"; §Target Areas amended to `src/__tests__/` and single `v4.json` filtered by name prefix.

- [ ] **Item 3: Cross-plan dependencies changelog**

File: `docs/architecture/cross-plan-dependencies.md` §6. Append a changelog entry noting Plan-025 Tier 1 Partial Phase 1 substrate merged with the squash-merge SHA.

- [ ] **Item 4: Plan-025 Tier 7 unblock note**

No code change; just record in §6 changelog that the Tier 7 relay-server work (Fastify, WebSocket, `/healthz`/`/readyz`/`/metrics`, rate-limiter, Docker/Caddyfile, operator runbook, Spec-027 rows) is unblocked against the substrate but explicitly out of scope for this PR.

- [ ] **Item 5: (Optional) Plan-018 reference**

No change required — ADR-010:29 already declares the dependency. Plan-018 will pick up the workspace dep when its Tier 5 phase starts.

---

## Risks (carried forward from design spec §12)

| Risk | Mitigation |
| --- | --- |
| Noble 2.x self-audit only (vs. externally Cure53/Kudelski-audited 1.x line) | User-confirmed override. PR description calls this out so reviewer acks. Re-evaluate at V1.1 if/when 2.x gets external audit. |
| Plan-025 narrative says XChaCha20-Poly1305 AEAD; actual spec is XChaCha20 + BLAKE2b-MAC | Implementation follows primary spec. File `BL-NNN` post-merge per Task 12 Item 2. |
| Vendored vector file lifecycle (upstream updates) | Pinned to specific commit SHA in `PROVENANCE.md`; updates handled by follow-up PRs with auditable diff. |
| Constant-time discipline in TypeScript (compiler does not enforce) | Use `equalBytes` for all MAC/signature compares; never `===` or `Buffer.compare` on secret material. Code-review checklist enforces. |
| Supply-chain on `@noble/*` | Pinned to `^2`; `pnpm-workspace.yaml` has `minimumReleaseAge: 1440` + `blockExoticSubdeps: true`. SBOM coverage in CI. |
| Key material in test fixtures triggers gitleaks | Allow-list scoped narrowly to `packages/crypto-paseto/src/__tests__/__fixtures__/v4.json` per Task 8 Step 4 (conditional). |
| KeyRing persistence pre-empting Plan-018 Tier 5 | In-memory only; constructor accepts pre-loaded entries — no DB/file I/O at this layer. |
| Test vectors might assume PASETO 2.x library behavior incompatible with noble 2.x | Tasks 9 + 10 surface mismatches as test failures; file `BL-NNN` before merge if any vector diverges. |
