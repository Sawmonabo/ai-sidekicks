// The (b) set for `daemon-id-factory-tripwire.test.ts`: every `randomUUID`
// line the daemon's non-test sources may hold, keyed `(path, exact trimmed
// line text)` with the reason beside each. It is a data table and nothing
// else — the sweep, the multiset comparison, and the planted negative controls
// live in the test that reads it. Add an entry only for an ephemeral token that
// no row and no event stores, or for prose about one; never for a persisted-row
// or event id, which mints through `../uuid-v7.ts`.

/** One exempt mention: the exact trimmed source line, and why it may stand. */
export interface ExemptOccurrence {
  readonly lineText: string;
  readonly reason: string;
}

/**
 * The (b) set: every `randomUUID` line the daemon may hold, the generator's own
 * home included.
 *
 * The minting entries are all ephemeral tokens — no row and no event stores
 * them, and nothing sorts a set of them — so uniqueness is the whole
 * requirement and v4 supplies it. The import entries pull the minter in for one
 * of those call sites. The prose entries mint nothing and describe a call site
 * that is itself on this list, or — in the generator's case — explain why the
 * generator exists and name this test as the mechanism that keeps it singular.
 *
 * Paths are `/`-separated and relative to `packages/runtime-daemon/src`; line
 * texts are compared after `String.prototype.trim()`, so indentation may move.
 */
export const RANDOM_UUID_OCCURRENCE_ALLOW_LIST: ReadonlyMap<string, readonly ExemptOccurrence[]> =
  new Map([
    [
      "ids/uuid-v7.ts",
      [
        {
          lineText: "// for event ids. Every daemon id source used to call `crypto.randomUUID()`,",
          reason: "prose in the generator's header recording the v4 idiom it replaced",
        },
        {
          lineText: "// stores stay on `crypto.randomUUID()` and say so at their call site.",
          reason: "prose in the generator's header naming the ephemeral-token carve-out",
        },
        {
          lineText: "// `finds no randomUUID mention beyond the allow-listed occurrences`",
          reason: "prose in the generator's header quoting this test's name",
        },
        {
          lineText: "// sweeps the daemon's sources and pairs every `randomUUID` line against an",
          reason: "prose in the generator's header describing this test's sweep",
        },
      ],
    ],
    [
      "provider/drivers/outbound-frame.ts",
      [
        {
          lineText: 'import { randomUUID } from "node:crypto";',
          reason: "pulls the token minter in for the correlation-id default below",
        },
        {
          lineText:
            "this.#mintCorrelationId = options.mintCorrelationId ?? ((): string => randomUUID());",
          reason: "in-flight correlation token for one outbound frame; gone when the leg settles",
        },
      ],
    ],
    [
      "ipc/streaming-primitive.ts",
      [
        {
          lineText: "// `subscriptionId` is a UUID string at runtime; `crypto.randomUUID()`",
          reason: "prose on the branded-type declaration, describing the mint below",
        },
        {
          lineText: "* `subscriptionId` is generated via `crypto.randomUUID()` (Node 22.12+",
          reason: "prose on the subscribe API's doc comment, describing the mint below",
        },
        {
          lineText: "// Branding cast: `crypto.randomUUID()` returns `string`. The runtime",
          reason: "prose explaining the branding cast applied on the mint below",
        },
        {
          lineText: "const subscriptionId = crypto.randomUUID() as SubscriptionId;",
          reason: "in-memory subscription id, alive for the life of one transport connection",
        },
      ],
    ],
    [
      "git/turn-snapshot-service.ts",
      [
        {
          lineText:
            "// concatenation and `randomUUID`), which is what lets the `try` start below them",
          reason: "prose naming the throw-free operations that precede the try block",
        },
        {
          lineText: 'import { createHash, randomUUID } from "node:crypto";',
          reason: "pulls the token minter in for the scratch-index filename below",
        },
        {
          lineText:
            "const scratchIndexPath: string = join(this.#snapshotIndexDirectory, `${randomUUID()}.index`);",
          reason: "collision-free filename for a scratch git index unlinked in the same call",
        },
      ],
    ],
    [
      "pty/node-pty-host.ts",
      [
        {
          lineText: 'import { randomUUID } from "node:crypto";',
          reason: "pulls the token minter in for the PTY handle below",
        },
        {
          lineText: "const sessionId: string = randomUUID();",
          reason:
            "host-local PTY handle; the Rust sidecar backend mints `s-{n}` for the same field",
        },
      ],
    ],
    [
      "ipc/handlers/presence-subscribe.ts",
      [
        {
          lineText: "// generates a fresh `subscriptionId` via `crypto.randomUUID()` and",
          reason:
            "prose only — describes `streaming-primitive.ts`'s subscription id, mints nothing",
        },
      ],
    ],
    [
      "ipc/handlers/session-subscribe.ts",
      [
        {
          lineText: "// generates a fresh `subscriptionId` via `crypto.randomUUID()` and",
          reason:
            "prose only — describes `streaming-primitive.ts`'s subscription id, mints nothing",
        },
      ],
    ],
  ]);
