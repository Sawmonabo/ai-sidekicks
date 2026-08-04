// Plan-006 T3.3 — the CP-006-13 outbound-credential seam, end to end.
//
// SCOPE. This file covers the credential seam and the ONE shipped consumer of
// it — `TrpcFetchAnchorUploadTransport`, whose call shape is the thing the
// contract exists to constrain. It deliberately does NOT cover
// `MerkleAnchorService`'s own behaviour (cadence, force-fire, queue drain);
// that is Plan-006 T3.5's file set.
//
// WHY THE CONSUMER'S CALL SHAPE IS PART OF THIS SEAM'S COVERAGE. RFC 9449 §4.3
// binds a DPoP proof to the request's method (`htm`) and target URI (`htu`). A
// provider that mints a correct proof for the wrong method or URI has minted a
// proof of nothing, and no type can express the agreement — it is a property of
// what the caller PASSES versus what it then FETCHES. So the agreement is
// asserted here by capturing both and comparing them, which is the only place
// it is observable.
//
// The interface's implementation is Tier-5-deferred (Plan-018 PASETO auth), so
// what is testable today is exactly: the refusing stub refuses with a
// diagnostic that names the deferral, the consumer-side guard refuses a bearer
// or proofless credential, and the transport's htm/htu agree with its own
// request.
//
// Refs: Plan-006 T3.3, `Plan-006 §Cross-Plan Obligations` CP-006-13,
// RFC 9449 §4.3 + §7.1, ADR-010.

import { describe, expect, it } from "vitest";

import type { AnchorPayload, NodeId, SessionId } from "@ai-sidekicks/contracts";

import {
  assertDpopCredentialMaterial,
  AUTHORIZATION_HEADER_NAME,
  DPOP_AUTHORIZATION_SCHEME,
  DPOP_PROOF_HEADER_NAME,
  Tier5DeferredDaemonCredentialProvider,
  type DaemonCredentialAttempt,
  type DaemonCredentialMaterial,
  type DaemonCredentialProvider,
} from "../daemon-credential-provider.js";
import { TrpcFetchAnchorUploadTransport } from "../merkle-anchor-service.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID = "01970000-0000-7000-8000-00000000a001" as SessionId;
const NODE_ID = "node-alpha" as NodeId;
const ENDPOINT = "https://control-plane.test/trpc";

function wellFormedMaterial(): DaemonCredentialMaterial {
  return {
    headers: {
      [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
      [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
    },
  };
}

function anchorFixture(): AnchorPayload {
  return {
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    startSequence: 1,
    endSequence: 1000,
    merkleRoot: Buffer.alloc(32, 0x11).toString("base64"),
    rootSignature: Buffer.alloc(64, 0x22).toString("base64"),
    anchoredAt: "2026-08-04T00:00:00.000Z",
  };
}

// A provider that records what it was asked for and returns what it was told to.
class RecordingCredentialProvider implements DaemonCredentialProvider {
  readonly attempts: DaemonCredentialAttempt[] = [];
  readonly #material: DaemonCredentialMaterial;

  constructor(material: DaemonCredentialMaterial = wellFormedMaterial()) {
    this.#material = material;
  }

  mintForAttempt(attempt: DaemonCredentialAttempt): Promise<DaemonCredentialMaterial> {
    this.attempts.push(attempt);
    return Promise.resolve(this.#material);
  }
}

function okResponse(stored: boolean): Response {
  return new Response(JSON.stringify({ result: { data: { stored } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ----------------------------------------------------------------------------
// The Tier-5 refusing stub
// ----------------------------------------------------------------------------

describe("Tier5DeferredDaemonCredentialProvider", () => {
  it("refuses every mint rather than returning empty headers", async () => {
    // A no-op provider returning `{}` would let the uploader issue an
    // unauthenticated request, and the operator would then debug a generic
    // control-plane 401 instead of the actual cause.
    const provider = new Tier5DeferredDaemonCredentialProvider();
    await expect(
      provider.mintForAttempt({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        htm: "POST",
        htu: `${ENDPOINT}/eventanchor.upload`,
      }),
    ).rejects.toThrow(/deferred to Tier 5/);
  });

  it("names the deferral, the plan obligation, and the attempt in the diagnostic", async () => {
    const provider = new Tier5DeferredDaemonCredentialProvider();
    const rejection = await provider
      .mintForAttempt({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        htm: "POST",
        htu: `${ENDPOINT}/eventanchor.upload`,
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("CP-006-13");
    expect(message).toContain("Plan-018");
    expect(message).toContain(`${ENDPOINT}/eventanchor.upload`);
    // The reassurance that matters operationally: a daemon running with this
    // stub still ANCHORS correctly, it just never flushes.
    expect(message).toContain("pending_anchor_uploads");
  });
});

// ----------------------------------------------------------------------------
// The consumer-side guard — RFC 9449 §7.1
// ----------------------------------------------------------------------------

describe("assertDpopCredentialMaterial", () => {
  it("accepts a DPoP-schemed token accompanied by a proof header", () => {
    expect(() => assertDpopCredentialMaterial(wellFormedMaterial())).not.toThrow();
  });

  it("REFUSES a Bearer-schemed credential", () => {
    // The load-bearing arm. A bearer credential on this path is replayable by
    // anyone who reads it from a log, a proxy buffer, or a crash dump — and this
    // endpoint writes the audit log's integrity witness. It would also SUCCEED
    // against a permissive control plane, so nothing else would catch it.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: "Bearer v4.public.fake-paseto-token",
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow(/RFC 9449 §7.1/);
  });

  it("accepts a case-varied scheme spelling (RFC 9110 §11.1 makes schemes case-insensitive)", () => {
    // Refusing `dpop` would reject a CONFORMING provider. The guard exists to
    // catch `Bearer`, not to police capitalization.
    for (const scheme of ["dpop", "DPOP", "DPoP"]) {
      expect(() =>
        assertDpopCredentialMaterial({
          headers: {
            [AUTHORIZATION_HEADER_NAME]: `${scheme} v4.public.fake-paseto-token`,
            [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
          },
        }),
      ).not.toThrow();
    }
  });

  it("REFUSES a missing or empty Authorization header", () => {
    expect(() =>
      assertDpopCredentialMaterial({ headers: { [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof" } }),
    ).toThrow(new RegExp(`no ${AUTHORIZATION_HEADER_NAME} header`));

    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: "",
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow();
  });

  it("reads the headers case-insensitively (a Headers-derived provider lowercases them)", () => {
    // RFC 9110 §5.1: header names are case-insensitive, and `Headers` normalizes
    // every name it stores to lowercase. An exact-match read would refuse this
    // CONFORMING provider while reporting "no Authorization header" — naming the
    // wrong cause, on the one boundary whose diagnostics an operator has to
    // trust.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          authorization: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
          dpop: "fake.dpop.proof",
        },
      }),
    ).not.toThrow();
  });

  it("REFUSES a separator-less value WITHOUT echoing one byte of it", () => {
    // The leak this closes: the scheme fallback used to treat a separator-less
    // value as the scheme itself and interpolate it into the message. That
    // message is persisted by `uploadPendingAnchors` into
    // `pending_anchor_uploads.last_error` — so a whole PASETO token landed in
    // cleartext on disk, outliving the request, the process, and the token.
    const bareToken = "v4.public.SUPERSECRETTOKENBYTES.deadbeef";
    let raised: unknown;
    try {
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: bareToken,
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      });
    } catch (error: unknown) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    const message = (raised as Error).message;
    expect(message).toContain("no scheme separator");

    // Not merely "does not contain the whole token" — NO substring of it. A
    // message quoting any run of the credential is still a credential on disk.
    for (let start = 0; start < bareToken.length; start += 1) {
      for (let end = start + 6; end <= bareToken.length; end += 1) {
        expect(message).not.toContain(bareToken.slice(start, end));
      }
    }
  });

  it("REFUSES a bare scheme with no token after it", () => {
    // This passed the old guard outright: `indexOf(" ") === -1` made the whole
    // value the scheme, `"DPoP"` compared equal, and an empty credential went to
    // the wire to come back as a generic 401.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: DPOP_AUTHORIZATION_SCHEME,
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow(/no scheme separator/);

    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME}   `,
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow(/no token after it/);
  });

  it("REFUSES a DPoP-schemed token with no proof header", () => {
    // Without the proof the token is bearer-equivalent in practice while
    // CLAIMING otherwise, which is worse than an honest bearer token: every
    // reviewer downstream sees `DPoP` and assumes possession was proven.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
        },
      }),
    ).toThrow(new RegExp(`no ${DPOP_PROOF_HEADER_NAME} proof header`));
  });
});

// ----------------------------------------------------------------------------
// The consumer's call shape — the htm/htu binding
// ----------------------------------------------------------------------------

describe("TrpcFetchAnchorUploadTransport — the RFC 9449 §4.3 htm/htu binding", () => {
  it("mints the credential for EXACTLY the method and URI it then fetches", async () => {
    // The agreement no type can express: a proof minted against a different
    // method or URI is a proof of nothing. Both sides are captured and compared.
    const provider = new RecordingCredentialProvider();
    let fetchedUrl: string | undefined;
    let fetchedMethod: string | undefined;

    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: ENDPOINT,
      nodeId: NODE_ID,
      credentialProvider: provider,
      fetchImpl: (input, init) => {
        fetchedUrl = String(input);
        fetchedMethod = init?.method;
        return Promise.resolve(okResponse(true));
      },
    });

    await transport.upload(anchorFixture());

    expect(provider.attempts).toHaveLength(1);
    const attempt = provider.attempts[0];
    expect(attempt).toBeDefined();
    if (attempt === undefined) return;

    expect(attempt.htm).toBe(fetchedMethod);
    expect(attempt.htu).toBe(fetchedUrl);
    // And the htu is the canonical form RFC 9449 §4.3 wants: no query, no
    // fragment. An unbatched tRPC mutation POSTs its input as the body, which is
    // what makes that achievable here.
    expect(attempt.htu).toBe(`${ENDPOINT}/eventanchor.upload`);
    expect(attempt.htu).not.toContain("?");
    expect(attempt.htu).not.toContain("#");
    // The attempt is scoped to the anchor's own session and this daemon's node.
    expect(attempt.sessionId).toBe(SESSION_ID);
    expect(attempt.nodeId).toBe(NODE_ID);
  });

  it("merges the minted headers onto the outbound request", async () => {
    const provider = new RecordingCredentialProvider();
    let sentHeaders: Record<string, string> | undefined;

    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: ENDPOINT,
      nodeId: NODE_ID,
      credentialProvider: provider,
      fetchImpl: (_input, init) => {
        sentHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(okResponse(true));
      },
    });

    await transport.upload(anchorFixture());

    expect(sentHeaders?.[AUTHORIZATION_HEADER_NAME]).toContain(DPOP_AUTHORIZATION_SCHEME);
    expect(sentHeaders?.[DPOP_PROOF_HEADER_NAME]).toBe("fake.dpop.proof");
    expect(sentHeaders?.["Content-Type"]).toBe("application/json");
  });

  it("REFUSES a bearer-schemed provider BEFORE anything reaches the wire", async () => {
    // Ordering is the assertion: the guard must fire before `fetch`, or the
    // replayable credential has already left the process by the time anyone
    // notices.
    const provider = new RecordingCredentialProvider({
      headers: {
        [AUTHORIZATION_HEADER_NAME]: "Bearer v4.public.fake-paseto-token",
        [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
      },
    });
    let fetchCallCount = 0;

    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: ENDPOINT,
      nodeId: NODE_ID,
      credentialProvider: provider,
      fetchImpl: () => {
        fetchCallCount += 1;
        return Promise.resolve(okResponse(true));
      },
    });

    await expect(transport.upload(anchorFixture())).rejects.toThrow(/RFC 9449 §7.1/);
    expect(fetchCallCount).toBe(0);
  });

  it("mints a FRESH credential per attempt (a DPoP proof binds to one request)", async () => {
    // RFC 9449 §11.1: reusing a proof across attempts is replay, and a
    // conforming control plane rejects it. Minting inside `upload` — rather than
    // once at construction — is what makes each retry a new proof.
    const provider = new RecordingCredentialProvider();
    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: ENDPOINT,
      nodeId: NODE_ID,
      credentialProvider: provider,
      fetchImpl: () => Promise.resolve(okResponse(true)),
    });

    await transport.upload(anchorFixture());
    await transport.upload(anchorFixture());
    expect(provider.attempts).toHaveLength(2);
  });

  it("normalizes a trailing slash on the endpoint so the htu has no empty path segment", async () => {
    const provider = new RecordingCredentialProvider();
    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: `${ENDPOINT}/`,
      nodeId: NODE_ID,
      credentialProvider: provider,
      fetchImpl: () => Promise.resolve(okResponse(true)),
    });

    await transport.upload(anchorFixture());
    expect(provider.attempts[0]?.htu).toBe(`${ENDPOINT}/eventanchor.upload`);
  });
});

// ----------------------------------------------------------------------------
// The response envelope
// ----------------------------------------------------------------------------

describe("TrpcFetchAnchorUploadTransport — response handling", () => {
  it("reads both idempotent-success arms out of the tRPC envelope", async () => {
    for (const stored of [true, false]) {
      const transport = new TrpcFetchAnchorUploadTransport({
        endpoint: ENDPOINT,
        nodeId: NODE_ID,
        credentialProvider: new RecordingCredentialProvider(),
        fetchImpl: () => Promise.resolve(okResponse(stored)),
      });
      await expect(transport.upload(anchorFixture())).resolves.toEqual({ stored });
    }
  });

  it("throws on a non-2xx response rather than reporting a phantom success", async () => {
    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: ENDPOINT,
      nodeId: NODE_ID,
      credentialProvider: new RecordingCredentialProvider(),
      fetchImpl: () =>
        Promise.resolve(new Response("nope", { status: 503, statusText: "Service Unavailable" })),
    });
    await expect(transport.upload(anchorFixture())).rejects.toThrow(/HTTP 503/);
  });

  it("throws on an unrecognized envelope rather than reading undefined as false", async () => {
    // The failure this prevents: a control plane that changed its envelope would
    // otherwise yield `undefined`, which reads as "not stored" and would keep
    // the anchor queued forever with no diagnostic.
    const transport = new TrpcFetchAnchorUploadTransport({
      endpoint: ENDPOINT,
      nodeId: NODE_ID,
      credentialProvider: new RecordingCredentialProvider(),
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ result: { data: {} } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    });
    await expect(transport.upload(anchorFixture())).rejects.toThrow(
      /unrecognized response envelope/,
    );
  });
});
