// `lifecycle.ts` provider commands: what the provider's handshake declares is held per process,
// a command is dispatched only when the live process declared it, compaction settles only on the
// provider's evidence, and the palette is stamped with the account the session was admitted on.

import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
} from "@ai-sidekicks/contracts/provider/driver/length-limits";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import type {
  ClaudeCreationFiguresReading,
  ClaudeHandshakeDeclaration,
} from "../session/transport.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_BINDING_ID,
  TEST_MODEL,
  TEST_RUN_ID,
  TEST_SECOND_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
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

// A measured live `system/init` frame: `slash_commands` and `skills` hold bare names, and
// `terminal_slash_commands` the names that run only in the provider's terminal UI.
function buildHandshake(
  overrides: Partial<ClaudeHandshakeDeclaration> = {},
): ClaudeHandshakeDeclaration {
  return {
    slashCommands: ["compact", "autocompact", "clear"],
    skills: ["pdf-processing"],
    terminalSlashCommands: ["doctor", "color"],
    capabilities: [],
    permissionMode: null,
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

// A live session that has published the default handshake.
async function arrangeCompactableSession(): Promise<{
  readonly harness: LifecycleHarness;
  readonly channel: FakeClaudeProviderProcess;
}> {
  const harness = buildHarness();
  const channel = await createLiveSession(harness);
  publishHandshake(channel);
  return { harness, channel };
}

function emitCompactionBoundary(channel: FakeClaudeProviderProcess, boundaryPosition: number) {
  return channel.emitStreamFrame("system/compact_boundary", {
    compactionBoundary: { boundaryPosition },
  });
}

describe("ClaudeSessionLifecycle.compactContext", () => {
  // Checked before the write: a command the live process lacks would reach the model as words.
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
      const harness = buildHarness({ mintProviderSessionId: mintSequentialProviderSessionIds() });
      const { channel, sessionId } = await arrange(harness);

      await expect(compactTestSession(harness, sessionId)).resolves.toStrictEqual({
        status: "refused",
        reason: "command_absent",
      });
      expect(channel.sentTexts).toStrictEqual([]);
      expect(channel.outboundCallCount).toBe(0);
    },
  );

  it("sends an unmarked command holding the turn to its own end, settling on the boundary", async () => {
    const { harness, channel } = await arrangeCompactableSession();
    armRunDispatch(harness);

    let settled: unknown = undefined;
    const pending = compactTestSession(harness).then((result) => {
      settled = result;
    });
    await drainMicrotasks();

    // Unmarked, since `client_composed` would stop Claude Code from running the command.
    expect(channel.sentUserFrames).toStrictEqual([
      { type: "user", uuid: expect.any(String), message: { role: "user", content: "/compact" } },
    ]);
    // The provider accepted the frame and said nothing, so nothing has happened yet.
    expect(settled).toBeUndefined();
    // The command runs as a turn of its own, whose end would otherwise end the next run.
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toMatchObject({
      fields: { reason: "session_turn_in_flight" },
    });
    await expect(compactTestSession(harness)).rejects.toMatchObject({
      fields: { reason: "session_turn_in_flight" },
    });

    emitCompactionBoundary(channel, 41);
    await pending;
    expect(settled).toStrictEqual({ status: "applied", boundaryPosition: 41 });
    // The command's own end releases the turn and ends no run.
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    expect(harness.runMoves).toStrictEqual([]);
    await expect(harness.lifecycle.startRun(buildStartRunParams())).resolves.toBeUndefined();
  });

  it("settles `not_compacted` when the command's turn ends with no boundary", async () => {
    const { harness, channel } = await arrangeCompactableSession();

    const pending = compactTestSession(harness);
    await drainMicrotasks();
    // Claude Code ends the command's turn as it declines, with nothing to compact.
    channel.emitStreamFrame("result/success", undefined, {
      type: "result",
      subtype: "success",
      result: "Not enough messages to compact.",
    });

    await expect(pending).resolves.toStrictEqual({ status: "failed", reason: "not_compacted" });
  });

  it("settles `binding_lost` at once when the session closes mid-wait", async () => {
    const { harness } = await arrangeCompactableSession();

    const pending = compactTestSession(harness);
    await drainMicrotasks();
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    await expect(pending).resolves.toStrictEqual({ status: "failed", reason: "binding_lost" });
  });

  it.each(["unsent", "indeterminate"] as const)(
    "answers `provider_error` on a failed %s write",
    async (delivery) => {
      const { harness, channel } = await arrangeCompactableSession();
      channel.sendUserTextFailure = new Error("stdin closed");
      channel.sendUserTextDelivery = delivery;

      await expect(compactTestSession(harness)).resolves.toStrictEqual({
        status: "failed",
        reason: "provider_error",
      });

      expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(1);
    },
  );
});

describe("ClaudeSessionLifecycle.listProviderCommands", () => {
  it("carries each declared name once per set, marking terminal-only names", async () => {
    // A name in two sets is two published capabilities; deduping would delete one, and an
    // unmarked terminal name would be offered for dispatch over a transport that cannot run it.
    const harness = buildHarness();
    publishHandshake(await createLiveSession(harness), {
      slashCommands: ["compact", "shared-name"],
      skills: ["pdf-processing", "shared-name"],
      terminalSlashCommands: ["doctor", "shared-name"],
    });

    const group = await listTestSessionCommands(harness);

    expect(group?.entries.map((entry) => [entry.name, entry.kind, entry.scope])).toStrictEqual([
      ["compact", "command", undefined],
      ["shared-name", "command", undefined],
      ["pdf-processing", "skill", undefined],
      ["shared-name", "skill", undefined],
      ["doctor", "command", "terminal"],
      ["shared-name", "command", "terminal"],
    ]);
  });

  it("drops each refused name, keeps its siblings, never echoes the value", async () => {
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

  it(
    "refuses an account member that is present but empty, on create and on resume, before " +
      "spawning",
    async () => {
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
    },
  );

  it("refuses a larger-window figure on create and on resume, before spawning", async () => {
    // Claude Code's model id names its window (`[1m]`), so a figure would be a second source.
    const harness = buildHarness();

    await expect(
      harness.lifecycle.createSession({ ...buildCreateSessionParams(), largerWindow: 1_000_000 }),
    ).rejects.toMatchObject({ fields: { reason: "larger_window_figure_unsupported" } });
    const resumed = await resumeTestSession(harness, { largerWindow: 1_000_000 });

    expect(resumed.status).toBe("failed");
    expect(harness.transport.spawnRequests).toHaveLength(0);
    expect(harness.transport.resumeRequests).toHaveLength(0);
  });

  it("names the run holding a live turn here, only while it holds it", async () => {
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
  it("reports the `initialize` state from spawn until a handshake reports another", async () => {
    const harness = buildHarness();
    harness.transport.initializeFastMode = {
      fastModeState: "off",
      fastModeDisabledReason: "sdk_opt_in_required",
    };
    const channel = await createLiveSession(harness);

    // No frame and no turn yet: the observation comes from the spawn itself.
    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toStrictEqual({
      declared: "off",
      reason: "sdk_opt_in_required",
    });
    publishHandshake(channel, { fastModeState: "on", fastModeDisabledReason: null });
    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toStrictEqual({
      declared: "on",
    });
  });

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

describe("Claude Code's stored figures", () => {
  it("reads a model once for all its sessions, and again after a failed read", async () => {
    const harness = buildHarness();
    const transport = harness.transport;
    const otherModel = "claude-opus-4-5";
    transport.creationFiguresFailure = new Error("the control-only process exited");
    await createLiveSession(harness);
    await drainMicrotasks();
    transport.creationFiguresFailure = undefined;
    transport.creationFiguresReading = {
      ...transport.creationFiguresReading,
      contextReads: [
        { requestedModel: TEST_MODEL, usage: { model: TEST_MODEL, rawMaxTokens: 200_000 } },
        { requestedModel: "claude-haiku-4-5", usage: undefined },
      ],
    };
    await createLiveSession(harness, { sessionId: "session-second" as SessionId });
    await drainMicrotasks();
    await createLiveSession(harness, { sessionId: "session-third" as SessionId });
    await resumeTestSession(harness, { sessionId: "session-resumed" as SessionId });
    await createLiveSession(harness, {
      sessionId: "session-other-model" as SessionId,
      model: otherModel,
      config: { model: otherModel },
    });

    // The failed read is read again; the next session on that model and the resume reuse it.
    expect(transport.creationFiguresRequests.map((request) => request.model)).toEqual([
      TEST_MODEL,
      TEST_MODEL,
      otherModel,
    ]);
    // The other model's process skips every window already read, a refused one included.
    expect(transport.creationFiguresRequests[2]?.contextReadModels).toEqual(
      new Set([TEST_MODEL, "claude-haiku-4-5"]),
    );
  });

  it("never shows one project's styles in a session of another project", async () => {
    // A project's own styles live in its folder, so a list read in one folder is wrong elsewhere.
    const projectTwoSessionId = "session-project-two" as SessionId;
    const harness = buildHarness({
      spawnContext: {
        resolveSpawnContext: async (sessionId) => {
          await Promise.resolve();
          return {
            workingDirectory: sessionId === projectTwoSessionId ? "/project-two" : "/project-one",
            environmentRows: undefined,
            accountFolders: undefined,
            memoryFolders: [],
            advisorModel: null,
            outputStyle: null,
          };
        },
      },
    });
    const transport = harness.transport;
    transport.initializeOutputStyles = ["default", "Reviewer"];
    const readingIn = (project: string): ClaudeCreationFiguresReading => ({
      ...transport.creationFiguresReading,
      outputStyleNames: ["default", "Reviewer"],
      outputStyle: {
        isListed: true,
        outcome: undefined,
        text: `Available styles:\n- default\n- Reviewer: Checks ${project}'s rules`,
      },
    });
    transport.creationFiguresReading = readingIn("project one");
    await createLiveSession(harness);
    await drainMicrotasks();
    transport.creationFiguresReading = readingIn("project two");
    await createLiveSession(harness, { sessionId: projectTwoSessionId });

    const answer = await harness.lifecycle.answerSessionCommand({
      sessionId: projectTwoSessionId,
      text: "/output-style",
    });

    expect(answer).toStrictEqual({
      answered: true,
      line: [
        "Available styles:",
        "- default",
        "- Reviewer: Checks project two's rules",
        "",
        "Usage: /output-style <style>",
      ].join("\n"),
    });
  });
});
