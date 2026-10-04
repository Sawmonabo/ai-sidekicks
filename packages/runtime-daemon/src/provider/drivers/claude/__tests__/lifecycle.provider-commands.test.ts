// `lifecycle.ts` provider commands: what the provider's handshake declares is held per process,
// a command is dispatched only when the live process declared it, compaction settles only on the
// provider's evidence, and the palette is stamped with the account the session was admitted on.

import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
} from "@ai-sidekicks/contracts/provider-driver";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import { describe, expect, it } from "vitest";

import { COMPACTION_WAIT_MS, type CompactionWaitScheduler } from "../../../compaction-wait.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { ClaudeSessionUnavailableError } from "../session-errors.js";
import type { ClaudeHandshakeDeclaration } from "../session-transport.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_BINDING_ID,
  TEST_RUN_ID,
  TEST_SECOND_RUN_ID,
  TEST_SESSION_ID,
} from "./claude-test-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  resumeTestSession,
  rewindTestSession,
  spawnedChannel,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

// A distinct provider session id per spawn, so a fork or a second session is told apart.
function mintSequentialProviderSessionIds(): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `provider-session-${issued}`;
  };
}

// A hand-fired compaction timer that records arms and cancels.
interface ManualCompactionScheduler {
  readonly schedule: CompactionWaitScheduler;
  fireAll(): void;
  armedCount(): number;
  armedDelays(): number[];
  canceledCount(): number;
}

function makeManualCompactionScheduler(): ManualCompactionScheduler {
  const armed: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
  let canceledCount = 0;
  return {
    schedule: (callback, delayMs) => {
      armed.push({ callback, delayMs });
      return (): void => {
        canceledCount += 1;
      };
    },
    fireAll: () => {
      for (const entry of [...armed]) {
        entry.callback();
      }
    },
    armedCount: () => armed.length,
    armedDelays: () => armed.map((entry) => entry.delayMs),
    canceledCount: () => canceledCount,
  };
}

// A measured live `system/init` frame: `slash_commands` and `skills` hold bare names, and
// `terminal_slash_commands` the names that run only in the provider's terminal UI.
function buildHandshake(
  overrides: Partial<ClaudeHandshakeDeclaration> = {},
): ClaudeHandshakeDeclaration {
  return {
    slashCommands: ["compact", "autocompact", "clear"],
    skills: ["pdf-processing"],
    terminalSlashCommands: ["doctor", "color"],
    fastModeState: "off",
    fastModeDisabledReason: "sdk_opt_in_required",
    ...overrides,
  };
}

function publishHandshake(
  channel: FakeClaudeProviderProcess,
  overrides: Partial<ClaudeHandshakeDeclaration> = {},
): void {
  channel.emitStreamFrame("system/init", { handshake: buildHandshake(overrides) });
}

async function compactTestSession(
  harness: LifecycleHarness,
  sessionId: SessionId = TEST_SESSION_ID,
): Promise<unknown> {
  return await harness.lifecycle.compactContext({ sessionId, bindingId: TEST_BINDING_ID });
}

async function listTestSessionCommands(harness: LifecycleHarness) {
  return (
    await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    })
  ).bindings[0];
}

// A live session that has published the default handshake, compacting on a manual timer.
async function arrangeCompactableSession(): Promise<{
  readonly harness: LifecycleHarness;
  readonly channel: FakeClaudeProviderProcess;
  readonly scheduler: ManualCompactionScheduler;
}> {
  const scheduler = makeManualCompactionScheduler();
  const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
  const channel = await createLiveSession(harness);
  publishHandshake(channel);
  return { harness, channel, scheduler };
}

function emitCompactionBoundary(channel: FakeClaudeProviderProcess, boundaryPosition: number) {
  return channel.emitStreamFrame("system/compact_boundary", {
    compactionBoundary: { boundaryPosition },
  });
}

describe("ClaudeSessionLifecycle.compactContext", () => {
  // The command frame is tripwire-exempt, so discovering after the write that the live process
  // lacks the command would leave provider-interpreted text on the wire with nothing watching.
  const ABSENT_COMMAND_CASES: ReadonlyArray<{
    readonly label: string;
    /** Arranges the sessions and returns the live channel and session the compaction targets. */
    readonly arrange: (
      harness: LifecycleHarness,
    ) => Promise<{ channel: FakeClaudeProviderProcess; sessionId: SessionId }>;
  }> = [
    {
      label: "the live process does not enumerate it",
      arrange: async (harness) => {
        const channel = await createLiveSession(harness);
        publishHandshake(channel, { slashCommands: ["clear", "cost"] });
        return { channel, sessionId: TEST_SESSION_ID };
      },
    },
    {
      label: "no handshake has arrived yet",
      arrange: async (harness) => ({
        channel: await createLiveSession(harness),
        sessionId: TEST_SESSION_ID,
      }),
    },
    {
      // Terminal-only names are published precisely because they cannot run over this transport.
      label: "it is published only as terminal-only",
      arrange: async (harness) => {
        const channel = await createLiveSession(harness);
        publishHandshake(channel, {
          slashCommands: ["clear", "cost"],
          skills: ["compact"],
          terminalSlashCommands: ["compact", "doctor"],
        });
        return { channel, sessionId: TEST_SESSION_ID };
      },
    },
    {
      label: "only the process a rewind replaced enumerated it",
      arrange: async (harness) => {
        publishHandshake(await createLiveSession(harness));
        await rewindTestSession(harness);
        return { channel: spawnedChannel(harness, 1), sessionId: TEST_SESSION_ID };
      },
    },
    {
      label: "a retired channel publishes it after its successor is live",
      arrange: async (harness) => {
        await createLiveSession(harness);
        await rewindTestSession(harness);
        publishHandshake(spawnedChannel(harness, 0));
        return { channel: spawnedChannel(harness, 1), sessionId: TEST_SESSION_ID };
      },
    },
    {
      label: "only a sibling session enumerates it",
      arrange: async (harness) => {
        const otherSessionId = "session-peer" as SessionId;
        publishHandshake(await createLiveSession(harness));
        const channel = await createLiveSession(harness, { sessionId: otherSessionId });
        publishHandshake(channel, { slashCommands: ["clear"] });
        return { channel, sessionId: otherSessionId };
      },
    },
  ];

  it.each(ABSENT_COMMAND_CASES)(
    "refuses `command_absent` and sends nothing when $label",
    async ({ arrange }) => {
      const scheduler = makeManualCompactionScheduler();
      const harness = buildHarness({
        compactionWaitScheduler: scheduler.schedule,
        mintProviderSessionId: mintSequentialProviderSessionIds(),
      });
      const { channel, sessionId } = await arrange(harness);

      await expect(compactTestSession(harness, sessionId)).resolves.toStrictEqual({
        status: "refused",
        reason: "command_absent",
      });
      expect(channel.sentWireTexts).toStrictEqual([]);
      expect(channel.outboundCallCount).toBe(0);
      expect(scheduler.armedCount()).toBe(0);
    },
  );

  it("sends a tripwire-exempt frame, blocks no later run, and settles only on the boundary", async () => {
    const { harness, channel, scheduler } = await arrangeCompactableSession();
    armRunDispatch(harness);

    let settled: unknown = undefined;
    const pending = compactTestSession(harness).then((result) => {
      settled = result;
    });
    await drainMicrotasks();

    expect(channel.sentWireTexts).toStrictEqual(["/compact"]);
    expect(channel.sentTextFrames[0]?.tripwireExempt).toBe(true);
    expect(scheduler.armedDelays()).toStrictEqual([COMPACTION_WAIT_MS]);
    // The provider accepted the frame and said nothing, so nothing has happened yet.
    expect(settled).toBeUndefined();
    // Registered with the tripwire, the command frame would block every later run.
    await expect(harness.lifecycle.startRun(buildStartRunParams())).resolves.toBeUndefined();

    emitCompactionBoundary(channel, 41);
    await pending;
    expect(settled).toStrictEqual({ status: "applied", boundaryPosition: 41 });
  });

  it("settles `wait_expired` on the bound and still routes a late boundary", async () => {
    // Bounding the operation never drops the boundary's own record.
    const { harness, channel, scheduler } = await arrangeCompactableSession();

    const pending = compactTestSession(harness);
    await drainMicrotasks();
    scheduler.fireAll();

    await expect(pending).resolves.toStrictEqual({ status: "failed", reason: "wait_expired" });
    expect(emitCompactionBoundary(channel, 88).decision).toBe("project");
  });

  it("settles `binding_lost` at once when the session closes mid-wait", async () => {
    const { harness, scheduler } = await arrangeCompactableSession();

    const pending = compactTestSession(harness);
    await drainMicrotasks();
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    await expect(pending).resolves.toStrictEqual({ status: "failed", reason: "binding_lost" });
    expect(scheduler.canceledCount()).toBe(1);
  });

  it.each(["unsent", "indeterminate"] as const)(
    "answers `provider_error` on a failed %s write and withdraws its wait",
    async (delivery) => {
      const { harness, channel, scheduler } = await arrangeCompactableSession();
      channel.sendUserTextFailure = new Error("stdin closed");
      channel.sendUserTextDelivery = delivery;

      await expect(compactTestSession(harness)).resolves.toStrictEqual({
        status: "failed",
        reason: "provider_error",
      });

      // The wait is armed before the write, closing the race with a fast compaction, and
      // withdrawn on failure; this double's canceler leaves the timer live, so firing it
      // exercises a clear that races the fire.
      expect(scheduler.armedCount()).toBe(1);
      expect(scheduler.canceledCount()).toBe(1);
      scheduler.fireAll();
      await drainMicrotasks();
      expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(1);
    },
  );

  it("withdraws only its own wait, so a concurrent caller still settles on the evidence", async () => {
    const { harness, channel, scheduler } = await arrangeCompactableSession();
    const surviving = compactTestSession(harness);
    await drainMicrotasks();
    channel.sendUserTextFailure = new Error("stdin closed");
    channel.sendUserTextDelivery = "unsent";

    await expect(compactTestSession(harness)).resolves.toStrictEqual({
      status: "failed",
      reason: "provider_error",
    });

    expect(scheduler.armedCount()).toBe(2);
    expect(scheduler.canceledCount()).toBe(1);
    emitCompactionBoundary(channel, 12);
    await expect(surviving).resolves.toStrictEqual({ status: "applied", boundaryPosition: 12 });
  });

  it("withdraws its wait and lets the throw through when composing the frame throws", async () => {
    const scheduler = makeManualCompactionScheduler();
    let mintShouldThrow = false;
    const harness = buildHarness({
      compactionWaitScheduler: scheduler.schedule,
      mintOutboundFrameCorrelationId: (): string => {
        if (mintShouldThrow) {
          throw new Error("correlation minting failed");
        }
        return "correlation-ok";
      },
    });
    publishHandshake(await createLiveSession(harness));
    mintShouldThrow = true;

    await expect(compactTestSession(harness)).rejects.toThrow("correlation minting failed");

    expect(scheduler.canceledCount()).toBe(1);
    scheduler.fireAll();
    await drainMicrotasks();
    expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toStrictEqual([]);
  });
});

describe("ClaudeSessionLifecycle.listProviderCommands", () => {
  it("carries every declared name once per set, marking only terminal-only names as such", async () => {
    // A name in two sets is two published capabilities; deduping would delete one, and an
    // unmarked terminal name would be offered for dispatch over a transport that cannot run it.
    const harness = buildHarness();
    publishHandshake(await createLiveSession(harness), {
      slashCommands: ["compact", "shared-name"],
      skills: ["pdf-processing", "shared-name"],
      terminalSlashCommands: ["doctor", "shared-name"],
    });

    const group = await listTestSessionCommands(harness);

    expect(group?.complete).toBe(true);
    expect(group?.entries.map((entry) => [entry.name, entry.kind, entry.scope])).toStrictEqual([
      ["compact", "command", undefined],
      ["shared-name", "command", undefined],
      ["pdf-processing", "skill", undefined],
      ["shared-name", "skill", undefined],
      ["doctor", "command", "terminal"],
      ["shared-name", "command", "terminal"],
    ]);
  });

  it("drops each name the contract refuses, keeps its siblings, and never echoes the value", async () => {
    // Skill names come from front matter the person can write, so they are untrusted output.
    const harness = buildHarness();
    publishHandshake(await createLiveSession(harness), {
      slashCommands: ["clear", `leak\u0000canary`],
      skills: ["pdf-processing", "   "],
      terminalSlashCommands: ["doctor", "x".repeat(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN + 1), ""],
    });

    const group = await listTestSessionCommands(harness);

    expect(group?.entries.map((entry) => entry.name)).toStrictEqual([
      "clear",
      "pdf-processing",
      "doctor",
    ]);
    const rejected = harness.diagnostics.recentRecordsOfKind("provider_command_entry_rejected");
    expect(rejected).toHaveLength(4);
    expect(JSON.stringify(rejected)).not.toContain("canary");
  });

  it("caps the reply but not what the driver holds, so a name past the cap stays dispatchable", async () => {
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    const channel = await createLiveSession(harness);
    const filler = Array.from(
      { length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 5 },
      (_unused, index) => `filler-${index}`,
    );
    publishHandshake(channel, {
      slashCommands: [...filler, "compact"],
      skills: [],
      terminalSlashCommands: [],
    });

    const group = await listTestSessionCommands(harness);

    expect(group?.complete).toBe(false);
    expect(group?.entries.map((entry) => entry.name)).toStrictEqual(
      filler.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    );
    const pending = compactTestSession(harness);
    await drainMicrotasks();
    expect(channel.sentWireTexts).toStrictEqual(["/compact"]);
    emitCompactionBoundary(channel, 3);
    await expect(pending).resolves.toStrictEqual({ status: "applied", boundaryPosition: 3 });
  });

  // A resumed process announces the same provider session id as its predecessor, so only an
  // unconditional discard keeps the old enumeration from answering for the new process.
  it.each([
    {
      label: "a close and a fresh create",
      reestablish: async (harness: LifecycleHarness) => {
        await harness.lifecycle.createSession(buildCreateSessionParams());
      },
    },
    {
      label: "a close and a resume under the unchanged provider session id",
      reestablish: async (harness: LifecycleHarness) => {
        const resumed = await resumeTestSession(harness, {
          resumeHandle: "provider-session-stable",
        });
        expect(resumed.status).toBe("resumed");
      },
    },
  ])("discards the held enumeration across $label", async ({ reestablish }) => {
    const harness = buildHarness({ mintProviderSessionId: () => "provider-session-stable" });
    publishHandshake(await createLiveSession(harness));
    expect((await listTestSessionCommands(harness))?.entries.length).toBeGreaterThan(0);
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    await reestablish(harness);

    expect((await listTestSessionCommands(harness))?.entries).toStrictEqual([]);
    publishHandshake(spawnedChannel(harness, -1), {
      slashCommands: ["compact"],
      skills: [],
      terminalSlashCommands: [],
    });
    expect((await listTestSessionCommands(harness))?.entries.map((entry) => entry.name)).toEqual([
      "compact",
    ]);
  });

  // The routing check treats `null` as matching nothing, so a session admitted on an account must
  // be stamped with it, and a registry that disagrees must not launder the divergence.
  const ACCOUNT_STAMPS: ReadonlyArray<{
    readonly label: string;
    readonly registryAccountId?: string;
    readonly establish: (harness: LifecycleHarness) => Promise<unknown>;
    readonly stampedAccountId: string | null | "refused";
  }> = [
    {
      label: "an accountless session",
      establish: async (harness) => await createLiveSession(harness),
      stampedAccountId: null,
    },
    {
      label: "a session whose create named no account, from the registry",
      registryAccountId: "account-registry",
      establish: async (harness) => await createLiveSession(harness),
      stampedAccountId: "account-registry",
    },
    {
      label: "the account a create was admitted on, with no registry bound",
      establish: async (harness) =>
        await createLiveSession(harness, { providerAccountId: "account-admitted" }),
      stampedAccountId: "account-admitted",
    },
    {
      label: "the admitted account when the registry agrees",
      registryAccountId: "account-admitted",
      establish: async (harness) =>
        await createLiveSession(harness, { providerAccountId: "account-admitted" }),
      stampedAccountId: "account-admitted",
    },
    {
      label: "nothing when a stale registry names another account",
      registryAccountId: "account-stale",
      establish: async (harness) =>
        await createLiveSession(harness, { providerAccountId: "account-admitted" }),
      stampedAccountId: "refused",
    },
    {
      label: "the admitted account inherited through a rewind",
      establish: async (harness) => {
        await createLiveSession(harness, { providerAccountId: "account-admitted" });
        expect((await rewindTestSession(harness)).status).toBe("applied");
      },
      stampedAccountId: "account-admitted",
    },
    {
      label: "the account a resume was admitted on",
      establish: async (harness) =>
        await resumeTestSession(harness, { providerAccountId: "account-admitted" }),
      stampedAccountId: "account-admitted",
    },
  ];

  it.each(ACCOUNT_STAMPS)("stamps $label", async (row) => {
    const registryAccountId = row.registryAccountId;
    const harness = buildHarness(
      registryAccountId === undefined
        ? {}
        : { readBoundProviderAccountId: () => registryAccountId },
    );
    await row.establish(harness);
    publishHandshake(spawnedChannel(harness, -1));

    const listing = listTestSessionCommands(harness);

    if (row.stampedAccountId === "refused") {
      const refused = await listing.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(refused).toBeInstanceOf(ClaudeSessionUnavailableError);
      expect(refused).toMatchObject({ fields: { reason: "provider_account_ambiguous" } });
      return;
    }
    const group = await listing;
    const binding = { driverName: "claude", providerAccountId: row.stampedAccountId };
    expect(group?.binding).toStrictEqual(binding);
    for (const entry of group?.entries ?? []) {
      expect(entry.binding).toStrictEqual(binding);
    }
  });

  it("refuses an account member that is present but empty, on create and on resume, before spawning", async () => {
    // An empty id is a daemon that meant to bind an account and bound nothing; carried, two such
    // bindings would compare equal in the routing check.
    const harness = buildHarness();

    await expect(
      harness.lifecycle.createSession({ ...buildCreateSessionParams(), providerAccountId: "" }),
    ).rejects.toMatchObject({ fields: { reason: "provider_account_unusable" } });
    const resumed = await resumeTestSession(harness, { providerAccountId: "" });

    expect(resumed.status).toBe("failed");
    expect(harness.transport.spawnRequests).toHaveLength(0);
    expect(harness.transport.resumeRequests).toHaveLength(0);
  });

  it("names the run holding a live turn on this session only, and only while it holds it", async () => {
    const peerSessionId = "session-peer-runs" as SessionId;
    const harness = buildHarness({ mintProviderSessionId: mintSequentialProviderSessionIds() });
    const channel = await createLiveSession(harness);
    await createLiveSession(harness, { sessionId: peerSessionId });
    publishHandshake(channel);
    expect(await listTestSessionCommands(harness)).toMatchObject({ runId: null });

    armRunDispatch(harness);
    armRunDispatch(harness, TEST_SECOND_RUN_ID, "the peer session's own turn", peerSessionId);
    await harness.lifecycle.startRun(buildStartRunParams());
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });
    expect((await listTestSessionCommands(harness))?.runId).toBe(TEST_RUN_ID);

    // The peer's run is still live, and must not be attributed here.
    channel.emitStreamFrame("result/success");
    expect((await listTestSessionCommands(harness))?.runId).toBeNull();
  });
});

describe("ClaudeSessionLifecycle.observedOutputSpeedFor", () => {
  // The handshake's fast-mode state reaches a client screen, so a reading the contract's bounds
  // refuse is absent rather than shown, and the refused value never rides the record.
  it.each([
    {
      label: "a NUL-bearing state",
      declaration: { fastModeState: `on\u0000x` },
      field: "declared",
    },
    { label: "a whitespace-only state", declaration: { fastModeState: "   " }, field: "declared" },
    {
      label: "an over-long reason",
      declaration: {
        fastModeState: "off",
        fastModeDisabledReason: "r".repeat(DRIVER_OUTPUT_SPEED_REASON_MAX_LEN + 1),
      },
      field: "reason",
    },
  ])("observes nothing for $label", async ({ declaration, field }) => {
    const harness = buildHarness();
    publishHandshake(await createLiveSession(harness), declaration);

    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toBeUndefined();
    const rejected = harness.diagnostics.recentRecordsOfKind("output_speed_state_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.details["rejectedField"]).toBe(field);
    expect(JSON.stringify(rejected[0])).not.toContain("rrrr");
  });
});
