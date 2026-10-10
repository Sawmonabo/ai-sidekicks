// `lifecycle.ts` session establishment: one provider process per canonical session, held across
// every create, resume, close and rewind, with no process left running that the daemon cannot
// reach, and every spawn built on the environment the daemon captured at start, credentials out.

import { describe, expect, it } from "vitest";

import { withScratchBindingStore } from "../../../__fixtures__/binding-store.js";
import { readLeftConversations } from "../../../left-conversations.js";
import { DriverResumeResultSchema } from "../../contract.js";
import { ClaudeAuthenticationRequiredError } from "../session/errors.js";
import {
  buildCreateSessionParams,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  buildHarness,
  createLiveSession,
  openGate,
  resumeTestSession,
  rewindTestSession,
  SANDBOXED_POSTURE,
  startLiveRun,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

const SESSION_ALREADY_LIVE = {
  code: "driver.unavailable",
  fields: { reason: "session_already_live" },
};

async function createTestSession(harness: LifecycleHarness): Promise<unknown> {
  return await harness.lifecycle.createSession(buildCreateSessionParams());
}

async function closeTestSession(harness: LifecycleHarness): Promise<void> {
  await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
}

describe("ClaudeSessionLifecycle.createSession", () => {
  it("refuses a second create for a session that already holds a live channel", async () => {
    const harness = buildHarness();
    await createTestSession(harness);

    await expect(createTestSession(harness)).rejects.toMatchObject(SESSION_ALREADY_LIVE);
    expect(harness.transport.spawnRequests).toHaveLength(1);
  });

  it("disposes and refuses a spawned process that announces a divergent session id", async () => {
    const harness = buildHarness();
    harness.transport.announcedProviderSessionId = "provider-session-other";

    await expect(createTestSession(harness)).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_id_pin_diverged" },
    });
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual([
      "spawn_identity_diverged",
    ]);
  });
});

describe("ClaudeSessionLifecycle.resumeSession failures", () => {
  const RESUME_FAILURES: ReadonlyArray<{
    readonly label: string;
    readonly arrange: (harness: LifecycleHarness) => Promise<unknown> | void;
    readonly recoveryCondition: "recovery-needed" | "reauth-required";
    /** Disposals on the first spawned channel; `null` when the resume spawned none. */
    readonly firstChannelDisposals: readonly string[] | null;
    readonly slotFreeAfterwards: boolean;
  }> = [
    {
      label: "the transport rejects the resume",
      arrange: (harness) => {
        harness.transport.resumeFailure = new Error("claude exited before init");
      },
      recoveryCondition: "recovery-needed",
      firstChannelDisposals: null,
      slotFreeAfterwards: true,
    },
    {
      // Sending the person to retry an expired credential would fail forever.
      label: "the stored credential has expired",
      arrange: (harness) => {
        harness.transport.resumeFailure = new ClaudeAuthenticationRequiredError("expired");
      },
      recoveryCondition: "reauth-required",
      firstChannelDisposals: null,
      slotFreeAfterwards: true,
    },
    {
      // On a working-directory mismatch Claude silently starts a new session under its own id,
      // which would drop the conversation being resumed.
      label: "the provider answers with a fresh session",
      arrange: (harness) => {
        harness.transport.announcedProviderSessionId = "provider-session-fresh";
      },
      recoveryCondition: "recovery-needed",
      firstChannelDisposals: ["resume_identity_diverged"],
      slotFreeAfterwards: true,
    },
    {
      label: "the resumed arm fails the driver contract",
      arrange: (harness) => {
        harness.transport.resumedSessionPosition = -1;
      },
      recoveryCondition: "recovery-needed",
      firstChannelDisposals: ["resume_result_invalid"],
      slotFreeAfterwards: true,
    },
    {
      label: "a live session already holds the slot",
      arrange: async (harness) => await createTestSession(harness),
      recoveryCondition: "recovery-needed",
      firstChannelDisposals: [],
      slotFreeAfterwards: false,
    },
  ];

  it.each(RESUME_FAILURES)(
    "fails through the arm, spawns no replacement, and frees the slot when $label",
    async ({ arrange, recoveryCondition, firstChannelDisposals, slotFreeAfterwards }) => {
      const harness = buildHarness();
      await arrange(harness);
      const spawnCountBeforeResume = harness.transport.spawnRequests.length;

      const result = await resumeTestSession(harness);

      expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ status: "failed", recoveryCondition });
      // No silent fallback to a fresh create beneath the failed resume.
      expect(harness.transport.spawnRequests).toHaveLength(spawnCountBeforeResume);
      expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBeUndefined();
      if (firstChannelDisposals === null) {
        expect(harness.transport.spawnedChannels).toHaveLength(0);
      } else {
        expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(
          firstChannelDisposals,
        );
      }
      if (slotFreeAfterwards) {
        harness.transport.announcedProviderSessionId = undefined;
        await expect(createTestSession(harness)).resolves.toBeDefined();
      }
    },
  );

  // Every caller of the detail renderer is a catch block, so it must be total over whatever was
  // thrown, and must never stringify an arbitrary object into a durable row.
  const HOSTILE_FAILURES: ReadonlyArray<{
    readonly label: string;
    readonly failure: () => unknown;
    readonly check: (detail: string) => void;
  }> = [
    {
      label: "a message getter that throws",
      failure: () => withThrowingGetters(["message"]),
      check: (detail) => expect(detail).toBe("Error"),
    },
    {
      label: "message and name getters that both throw",
      failure: () => withThrowingGetters(["message", "name"]),
      check: (detail) => expect(detail).toContain("no describable detail"),
    },
    {
      label: "a non-string message whose toString would leak a credential",
      failure: () => {
        const error = new Error("unused");
        Object.defineProperty(error, "message", {
          value: { toString: () => "sk-live-should-never-appear" },
        });
        return error;
      },
      check: (detail) => {
        expect(detail).toBe("Error");
        expect(detail).not.toContain("sk-live");
      },
    },
    {
      label: "a whitespace-only message carrying a NUL",
      failure: () => new Error("\u0000   "),
      check: (detail) => {
        expect(detail).not.toContain("\u0000");
        expect(detail).toMatch(/\S/);
      },
    },
  ];

  it.each(HOSTILE_FAILURES)("renders a contract-valid detail from $label", async (row) => {
    const harness = buildHarness();
    harness.transport.resumeFailure = row.failure() as Error;

    const result = await resumeTestSession(harness);

    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    row.check(result.providerFailureDetail);
  });
});

function withThrowingGetters(properties: readonly ("message" | "name")[]): Error {
  const error = new Error("this message is never reachable");
  for (const property of properties) {
    Object.defineProperty(error, property, {
      get: () => {
        throw new Error(`the ${property} getter exploded`);
      },
    });
  }
  return error;
}

// Both entry points await a transport spawn between checking the slot and registering the
// channel; without a claim taken before that await, both would spawn and the second registration
// would orphan the first process.
describe("ClaudeSessionLifecycle establishment races", () => {
  type Establishment = "create" | "resume";

  async function establish(harness: LifecycleHarness, kind: Establishment): Promise<string> {
    if (kind === "create") {
      return await createTestSession(harness).then(
        () => "admitted",
        (error: unknown) => {
          expect(error).toMatchObject(SESSION_ALREADY_LIVE);
          return "refused";
        },
      );
    }
    const result = await resumeTestSession(harness, {
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
    });
    return result.status === "resumed" ? "admitted" : "refused";
  }

  it.each<{ first: Establishment; second: Establishment }>([
    { first: "create", second: "create" },
    { first: "create", second: "resume" },
    { first: "resume", second: "create" },
  ])("admits only the first of a $first and a $second in flight together", async (row) => {
    const harness = buildHarness();
    const { gate, release } = openGate();
    harness.transport.establishmentGate = gate;

    const first = establish(harness, row.first);
    const secondOutcome = await establish(harness, row.second);
    release();

    expect(await first).toBe("admitted");
    expect(secondOutcome).toBe("refused");
    expect(harness.transport.spawnRequests.length + harness.transport.resumeRequests.length).toBe(
      1,
    );
    expect(harness.transport.spawnedChannels).toHaveLength(1);
  });

  it("closes a session whose establishment was still in flight instead of no-opping", async () => {
    const harness = buildHarness();
    const { gate, release } = openGate();
    harness.transport.establishmentGate = gate;

    const creating = createTestSession(harness);
    const closing = closeTestSession(harness);
    release();
    await creating;
    await closing;

    // A close that read the slot as empty would return before the channel registered, and the
    // process would outlive the daemon's record of it.
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["session_closed"]);
    await expect(createTestSession(harness)).resolves.toBeDefined();
  });
});

describe("ClaudeSessionLifecycle.closeSession", () => {
  it("holds the slot until the disposal settles, and disposes the channel once", async () => {
    // Dropping the record before awaiting `dispose` would let a create spawn a replacement
    // beneath a process that is still dying.
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    const { gate, release } = openGate();
    channel.disposeGate = gate;

    const closing = closeTestSession(harness);
    expect(channel.disposals).toStrictEqual(["session_closed"]);
    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBeUndefined();
    await expect(createTestSession(harness)).rejects.toMatchObject(SESSION_ALREADY_LIVE);
    expect((await resumeTestSession(harness)).status).toBe("failed");
    const chainedClose = closeTestSession(harness);
    release();
    await closing;
    await chainedClose;

    // The chained close saw an empty slot rather than tearing down a process already gone.
    expect(channel.disposals).toStrictEqual(["session_closed"]);
    expect(harness.transport.resumeRequests).toHaveLength(0);
    await expect(createTestSession(harness)).resolves.toBeDefined();
    expect(harness.transport.spawnRequests).toHaveLength(2);
  });

  it("quarantines a session with a stuck process until a retry disposes its channel", async () => {
    // A rejected dispose leaves the process running; the retained channel is the only handle on
    // it, and freeing the slot would put a second process under one session.
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.disposeFailure = new Error("the provider process would not exit");

    await expect(closeTestSession(harness)).rejects.toThrow("the provider process would not exit");
    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBeUndefined();
    await expect(createTestSession(harness)).rejects.toMatchObject({
      ...SESSION_ALREADY_LIVE,
      message: expect.stringMatching(/quarantined/),
    });
    expect((await resumeTestSession(harness)).status).toBe("failed");
    await expect(closeTestSession(harness)).rejects.toThrow("the provider process would not exit");
    await expect(createTestSession(harness)).rejects.toMatchObject(SESSION_ALREADY_LIVE);

    channel.disposeFailure = undefined;
    const { gate, release } = openGate();
    channel.disposeGate = gate;
    const retry = closeTestSession(harness);
    await expect(createTestSession(harness)).rejects.toMatchObject(SESSION_ALREADY_LIVE);
    release();
    await retry;

    expect(channel.disposals).toStrictEqual(["session_closed", "session_closed", "session_closed"]);
    expect(harness.transport.resumeRequests).toHaveLength(0);
    await expect(createTestSession(harness)).resolves.toBeDefined();
    expect(harness.transport.spawnRequests).toHaveLength(2);
  });
});

// Between the transport handing back a live channel and its registration, the binding minter,
// the output-schema digest and the transport's terminal-hook registration can each throw. An
// escaping throw would clear the slot claim while leaving the process running and unreferenced.
describe("ClaudeSessionLifecycle adoption window", () => {
  // `JSON.stringify` throws on a BigInt, so this schema's digest cannot be computed.
  const UNSERIALIZABLE_OUTPUT_SCHEMA: Record<string, unknown> = { limit: 10n };

  async function resumeFails(
    harness: LifecycleHarness,
    outputSchema?: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await resumeTestSession(
      harness,
      outputSchema === undefined ? {} : { outputSchema },
    );
    return result.status === "failed";
  }

  async function createFails(
    harness: LifecycleHarness,
    outputSchema?: Record<string, unknown>,
  ): Promise<boolean> {
    return await harness.lifecycle
      .createSession({
        ...buildCreateSessionParams(),
        ...(outputSchema === undefined ? {} : { outputSchema }),
      })
      .then(
        () => false,
        () => true,
      );
  }

  const ADOPTION_FAILURES: ReadonlyArray<{
    readonly label: string;
    readonly build: () => LifecycleHarness;
    readonly establishFails: (harness: LifecycleHarness) => Promise<boolean>;
  }> = [
    {
      label: "a resume whose binding minter throws",
      build: () =>
        buildHarness({
          mintBindingId: () => {
            throw new Error("the runtime_bindings store is unreachable");
          },
        }),
      establishFails: async (harness) => await resumeFails(harness),
    },
    {
      label: "a resume whose terminal-hook registration is refused",
      build: () => withTerminalHookRefused(buildHarness()),
      establishFails: async (harness) => await resumeFails(harness),
    },
    {
      label: "a resume whose output schema cannot be digested",
      build: () => buildHarness(),
      establishFails: async (harness) => await resumeFails(harness, UNSERIALIZABLE_OUTPUT_SCHEMA),
    },
    {
      label: "a create whose terminal-hook registration is refused",
      build: () => withTerminalHookRefused(buildHarness()),
      establishFails: async (harness) => await createFails(harness),
    },
    {
      label: "a create whose output schema cannot be digested",
      build: () => buildHarness(),
      establishFails: async (harness) => await createFails(harness, UNSERIALIZABLE_OUTPUT_SCHEMA),
    },
  ];

  it.each(ADOPTION_FAILURES)(
    "disposes the process and frees the slot for $label",
    async ({ build, establishFails }) => {
      const harness = build();

      expect(await establishFails(harness)).toBe(true);

      expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual([
        "establishment_failed",
      ]);
      harness.transport.onTurnTerminalFailure = undefined;
      await expect(createTestSession(harness)).resolves.toBeDefined();
    },
  );
});

function withTerminalHookRefused(harness: LifecycleHarness): LifecycleHarness {
  harness.transport.onTurnTerminalFailure = new Error("the stream consumer is already closed");
  return harness;
}

describe("ClaudeSessionLifecycle.moveSessionToFork", () => {
  it("points the session's binding at the fork and records the session it left", async () => {
    // A daemon restart resumes from the binding, so one still naming the session the rewind left
    // would bring back the conversation from before it.
    await withScratchBindingStore(async (bindings, database) => {
      const { id: bindingId } = await bindings.create({
        runId: TEST_RUN_ID,
        driverName: "claude",
        contractVersion: "1.0.0",
        resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
        spawnConfig: { executionPosture: SANDBOXED_POSTURE },
      });
      const harness = buildHarness({
        rebindRuntimeBinding: async (rebind) => {
          await bindings.rebind(rebind);
        },
      });
      await createLiveSession(harness);

      const result = await harness.lifecycle.moveSessionToFork({
        sessionId: TEST_SESSION_ID,
        bindingId,
        position: 4,
      });

      expect(result).toStrictEqual({ status: "applied", sessionPosition: 4 });
      expect(bindings.findById(bindingId)?.resumeHandle).toBe("forked-1");
      expect(
        readLeftConversations(database.reader, TEST_SESSION_ID).map((left) => [
          left.driverName,
          left.conversationId,
        ]),
      ).toStrictEqual([["claude", TEST_PINNED_PROVIDER_SESSION_ID]]);
    });
  });

  it("refuses a rewind the provider answered with the SAME session id", async () => {
    // A rewind that kept its id did not fork, so the conversation it was meant to preserve is gone.
    const harness = buildHarness();
    await createLiveSession(harness);
    harness.transport.announcedForkedProviderSessionId = TEST_PINNED_PROVIDER_SESSION_ID;

    const result = await rewindTestSession(harness);

    expect(result).toMatchObject({
      status: "degraded",
      fallbackAction: expect.stringContaining("rewind-not-forked"),
    });
  });
});

describe("ClaudeSessionLifecycle.probeAuth", () => {
  // Only a probe the transport actually took reads as signed in; a typed logout reads as signed
  // out, and anything else, including words that merely look like a credential problem, is
  // indeterminate rather than a guess either way.
  it.each<{ label: string; failure: unknown; status: string }>([
    { label: "a reading taken", failure: undefined, status: "authenticated" },
    {
      label: "the typed logged-out signal",
      failure: new ClaudeAuthenticationRequiredError("no credentials on this node"),
      status: "unauthenticated",
    },
    {
      label: "a generic failure worded like a logout",
      failure: new Error("not authenticated: upstream 401"),
      status: "indeterminate",
    },
    { label: "a thrown non-Error", failure: "just a string", status: "indeterminate" },
  ])("reports $status for $label", async ({ failure, status }) => {
    const harness = buildHarness();
    harness.transport.probeAuthFailure = failure as Error | undefined;

    await expect(harness.lifecycle.probeAuth()).resolves.toMatchObject({ status });
  });
});

describe("ClaudeSessionLifecycle spawn environment", () => {
  it("strips a credential the login shell leaked from every spawn and the auth probe", async () => {
    // The base the daemon captured from the person's login shell, with a curated token in it.
    const leakedName = "GITHUB_TOKEN";
    const harness = buildHarness({
      providerBaseEnvironment: [
        ["HOME", "/Users/person"],
        ["HTTPS_PROXY", "http://proxy.internal:3128"],
        [leakedName, "fake-token-for-the-strip-test"],
      ],
    });

    await createLiveSession(harness);
    await rewindTestSession(harness);
    await closeTestSession(harness);
    await resumeTestSession(harness);
    await harness.lifecycle.probeAuth();

    const environments = [
      ...harness.transport.spawnRequests,
      ...harness.transport.rewindRequests,
      ...harness.transport.resumeRequests,
      ...harness.transport.probeAuthRequests,
    ].map((request) => new Map(request.spawnEnvironment));
    expect(environments).toHaveLength(4);
    for (const environment of environments) {
      expect(environment.has(leakedName)).toBe(false);
      expect(environment.get("HOME")).toBe("/Users/person");
      expect(environment.get("HTTPS_PROXY")).toBe("http://proxy.internal:3128");
    }
  });
});
