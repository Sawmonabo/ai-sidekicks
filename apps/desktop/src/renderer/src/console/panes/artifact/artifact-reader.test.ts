// What the pane reads, and the one thing it refuses to invent.
//
// The refusal-on-served case is the load-bearing one: a growth port that ANSWERS
// `artifactList` still cannot supply a manifest row, and a reader that mapped four
// summary members into a thirteen-member envelope would be putting a `state` and a
// `visibility` on screen that no read established.

import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

interface PortScript {
  readonly listAnswer: unknown;
  readonly allowlistAnswer: unknown;
}

function bridgeAnswering(script: PortScript): ConsoleBridge {
  return {
    growth: {
      artifactList: async () => script.listAnswer,
      artifactAllowlistRead: async () => script.allowlistAnswer,
    },
  } as unknown as ConsoleBridge;
}

/** One manifest row as the growth port serves it, with every member populated. */
const SERVED_SUMMARY = {
  artifactId: "019b7b30-0280-7c11-8420-b1a5c0de2201",
  sessionId: "session-1",
  runId: "019b7b30-0280-7c11-8420-b1a5c0de2202",
  createdBy: "019b7b30-0280-7c11-8420-b1a5c0de2203",
  artifactType: "diff",
  digest: "sha256:2b4c",
  size: 4096,
  annotations: { "org.opencontainers.image.title": "rate-limit-wiring.patch" },
  visibility: "shared",
  state: "published",
  replicationStatus: "pinned",
  metadata: { mediaType: "text/x-patch", turnOrdinal: 12 },
  createdAt: "2026-09-02T07:00:00.000Z",
};

const REFUSAL = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the artifact CRUD method strings are not registered yet.",
  origin: "growth-port",
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("artifact pane reader — before anything is asked", () => {
  it("starts on the absence that says nobody asked", () => {
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
    });
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
  });

  it("reads nothing at all on a pane with no session behind it", async () => {
    // A bare route has a pane and no session. Reading anyway would mean inventing a
    // session id, so the reader stays where it was.
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: undefined,
    });
    reader.start();
    await settle();
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
  });
});

describe("artifact pane reader — a refused read and a served one", () => {
  it("carries the port's refusal verbatim rather than reporting an empty list", async () => {
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
    });
    reader.start();
    await settle();
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("refused");
    expect(state.kind === "refused" ? state.refusal.code : undefined).toBe("wire-unregistered");
  });

  it("reads a served manifest summary as a row, member for member", async () => {
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [SERVED_SUMMARY] },
        allowlistAnswer: REFUSAL,
      }),
      sessionId: "session-1",
    });
    reader.start();
    await settle();
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : []).toStrictEqual([
      {
        id: "019b7b30-0280-7c11-8420-b1a5c0de2201",
        sessionId: "session-1",
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
    // Negative control for the case above: a reader that published `not-checked` for
    // an empty served list would pass every member assertion and still be wrong about
    // the one thing an empty list says.
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: { status: "served", value: [] },
        allowlistAnswer: REFUSAL,
      }),
      sessionId: "session-1",
    });
    reader.start();
    await settle();
    const state = reader.snapshot.artifacts;
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : undefined).toStrictEqual([]);
  });
});

describe("artifact pane reader — the allow-list hint", () => {
  it("falls back to the shipped default and says so, carrying the refusal", async () => {
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
    });
    reader.start();
    await settle();
    expect(reader.snapshot.allowlist.source).toBe("shipped-default");
    expect(reader.snapshot.allowlist.mediaTypes).toStrictEqual(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(reader.snapshot.allowlist.refusal?.code).toBe("wire-unregistered");
  });

  it("takes the effective list wholesale when the daemon answers", async () => {
    // Wholesale, never merged: an operator override REPLACES the default, so a reading
    // that unioned the two would describe a deployment that does not exist.
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({
        listAnswer: REFUSAL,
        allowlistAnswer: {
          status: "served",
          value: { contentTypes: ["image/svg+xml"], maximumByteLength: 42 },
        },
      }),
      sessionId: "session-1",
    });
    reader.start();
    await settle();
    expect(reader.snapshot.allowlist.source).toBe("effective");
    expect(reader.snapshot.allowlist.mediaTypes).toStrictEqual(["image/svg+xml"]);
    expect(reader.snapshot.allowlist.maximumByteLength).toBe(42);
  });

  it("negative control: a disposed reader publishes nothing further", async () => {
    const reader = new ArtifactPaneReader({
      bridge: bridgeAnswering({ listAnswer: REFUSAL, allowlistAnswer: REFUSAL }),
      sessionId: "session-1",
    });
    reader.dispose();
    reader.start();
    await settle();
    expect(reader.snapshot.artifacts.kind).toBe("not-checked");
  });
});
