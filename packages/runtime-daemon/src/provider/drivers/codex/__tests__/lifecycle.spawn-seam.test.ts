// What a spawned Codex child is allowed to hold: denied credentials are stripped on every spawn
// path, the provider account a session bills to is never silently swapped, and the websocket
// transport never listens unauthenticated or presents a retired secret. A sandbox setting the
// provider did not apply is reported, never assumed.

import { describe, expect, it } from "vitest";

import { CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider-driver";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import {
  CodexDriver,
  CodexDriverConfigError,
  composeCodexTransportArgv,
  describeCodexPostureDivergence,
  parseCodexSessionConfig,
  type CodexTransportSelection,
  type CodexWebsocketBearerCredential,
} from "../index.js";
import {
  EXECUTABLE_PATH,
  FakeCodexAppServer,
  type Harness,
  RESUME_SPAWN_CONFIG,
  SESSION_CONFIG,
  SESSION_CWD,
  SESSION_ID,
  STUB_MODEL_CATALOG_READ,
  TEST_MODEL,
  THREAD_ID,
  createHarness,
  makeCapabilities,
  resolveNoDeniedCredentialNames,
  threadStartResult,
} from "./codex-test-doubles.js";
import { RESUME_PARAMS } from "./lifecycle.test-support.js";
import { makeManualScheduler } from "../../../__fixtures__/manual-scheduler.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";

describe("Codex credential-policy strip at the spawn seam", () => {
  const DENIED_ENV_VAR = "ANTHROPIC_API_KEY";
  const OTHER_DENIED_ENV_VAR = "OPENAI_API_KEY";
  const DENY_POLICY = { denyEnvVars: [DENIED_ENV_VAR], envNameMatch: "case-sensitive" } as const;
  const SANDBOXED_POSTURE: ExecutionPosture = {
    mode: "sandboxed",
    credentialPolicyRef: "policy://resume",
    networkAccess: "none",
    writableRoots: [SESSION_CWD],
  };
  const STRIPPED_ENV = [
    ["HOME", "/home/agent"],
    [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
  ];

  function envHoldingSecret(): Array<[string, string]> {
    return [
      ["HOME", "/home/agent"],
      [DENIED_ENV_VAR, "sk-live"],
    ];
  }

  const resolvesDenyPolicy = { resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY) };

  async function createWithSecret(
    harness: Harness,
    extra: { credentialEnvPolicy?: typeof DENY_POLICY; executionPosture?: ExecutionPosture } = {},
  ): Promise<void> {
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: envHoldingSecret(),
        ...(extra.credentialEnvPolicy === undefined
          ? {}
          : { credentialEnvPolicy: extra.credentialEnvPolicy }),
      },
      ...(extra.executionPosture === undefined ? {} : { executionPosture: extra.executionPosture }),
    });
  }

  async function resume(harness: Harness, executionPosture?: ExecutionPosture): Promise<void> {
    harness.server.on("thread/resume", () => threadStartResult(1));
    await harness.driver.resumeSession({
      ...RESUME_PARAMS,
      ...(executionPosture === undefined ? {} : { executionPosture }),
    });
  }

  interface StripCase {
    readonly path: string;
    readonly options: Parameters<typeof createHarness>[0];
    readonly spawn: (harness: Harness) => Promise<unknown>;
    /** Which spawn the strip is read off: the resume's is the second when a create precedes it. */
    readonly spawnIndex: number;
  }

  // A session's posture can change between create and resume, and every spawn path composes its
  // child through the same builder, so each path is driven here.
  const stripCases: readonly StripCase[] = [
    {
      path: "a created session, under the config bag's policy",
      options: {},
      spawn: (harness) => createWithSecret(harness, { credentialEnvPolicy: DENY_POLICY }),
      spawnIndex: 0,
    },
    {
      path: "a create whose posture resolves a policy the bag omitted",
      options: resolvesDenyPolicy,
      spawn: (harness) => createWithSecret(harness, { executionPosture: SANDBOXED_POSTURE }),
      spawnIndex: 0,
    },
    {
      path: "a cold resume, under the node-wide spawn config's policy",
      options: {
        resumeSpawnConfig: {
          cwd: "/work/resume",
          env: envHoldingSecret(),
          credentialEnvPolicy: DENY_POLICY,
        },
      },
      spawn: (harness) => resume(harness),
      spawnIndex: 0,
    },
    {
      path: "a cold resume, under the resumed posture's policy",
      options: {
        ...resolvesDenyPolicy,
        resumeSpawnConfig: { cwd: "/work/resume", env: envHoldingSecret() },
      },
      spawn: (harness) => resume(harness, SANDBOXED_POSTURE),
      spawnIndex: 0,
    },
    {
      // The record stores the create's resolution, not the bag's silence.
      path: "a resume stating no posture, after a create whose posture resolved the policy",
      options: resolvesDenyPolicy,
      spawn: async (harness) => {
        await createWithSecret(harness, { executionPosture: SANDBOXED_POSTURE });
        await resume(harness);
      },
      spawnIndex: 1,
    },
    {
      path: "a warm resume whose posture brings a policy the create lacked",
      options: resolvesDenyPolicy,
      spawn: async (harness) => {
        await createWithSecret(harness);
        await resume(harness, SANDBOXED_POSTURE);
      },
      spawnIndex: 1,
    },
    {
      path: "the auth probe",
      options: {
        resumeSpawnConfig: {
          cwd: "/work/resume",
          env: envHoldingSecret(),
          credentialEnvPolicy: DENY_POLICY,
        },
      },
      spawn: (harness) => harness.driver.probeAuth(),
      spawnIndex: 0,
    },
  ];

  it.each(stripCases)("strips a denied name from $path", async (stripCase) => {
    const harness = createHarness(stripCase.options);

    await stripCase.spawn(harness);

    // Byte-exact, so a builder that also dropped or reordered something else fails.
    expect(harness.server.spawnRequests[stripCase.spawnIndex]?.env).toEqual(STRIPPED_ENV);
  });

  it("lets the posture's policy govern whole over a bag that named a different one", async () => {
    // The posture's name is gone and the bag's survives: a fallback-only resolution fails the
    // survival, and a composition that ignored the posture fails the strip.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () =>
        Promise.resolve({ denyEnvVars: [OTHER_DENIED_ENV_VAR], envNameMatch: "case-sensitive" }),
    });
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [...envHoldingSecret(), [OTHER_DENIED_ENV_VAR, "sk-other"]],
        credentialEnvPolicy: DENY_POLICY,
      },
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [DENIED_ENV_VAR, "sk-live"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("refuses a posture that resolves to no policy before anything is spawned", async () => {
    // Degrading an unresolved policy to "deny nothing" would launch the child holding the
    // credentials the reference exists to withhold.
    const unresolved = { resolveCredentialEnvPolicy: () => Promise.resolve(undefined) };
    const creating = createHarness(unresolved);
    const refused = await createWithSecret(creating, {
      executionPosture: SANDBOXED_POSTURE,
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const resuming = createHarness(unresolved);
    resuming.server.on("thread/resume", () => threadStartResult(1));
    const result = await resuming.driver.resumeSession({
      ...RESUME_PARAMS,
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    expect((refused as CodexDriverConfigError).field).toBe(
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    // A resume refuses as a typed result, never a rejection.
    expect(result.status).toBe("failed");
    expect(creating.server.spawnRequests).toEqual([]);
    expect(resuming.server.spawnRequests).toEqual([]);
  });

  it("refuses a policy it cannot read rather than spawning with nothing stripped", () => {
    // A missing `envNameMatch` is refused too: the mode decides whether `path` slips past a list
    // naming `PATH`, and this side of the wire does not know the host.
    const unreadablePolicies: readonly unknown[] = [
      {},
      { denyEnvVars: [], envNameMatch: "whatever-the-host-does" },
      { denyEnvVars: ["A"] },
      { denyEnvVars: "ANTHROPIC_API_KEY", envNameMatch: "case-sensitive" },
      { denyEnvVars: [""], envNameMatch: "case-sensitive" },
      { denyEnvVars: [1], envNameMatch: "case-sensitive" },
      "case-sensitive",
    ];
    for (const credentialEnvPolicy of unreadablePolicies) {
      expect(() => parseCodexSessionConfig({ ...SESSION_CONFIG, credentialEnvPolicy })).toThrow(
        CodexDriverConfigError,
      );
    }
  });
});

describe("Codex provider-account precedence at the spawn seam", () => {
  // An account that moves without saying so re-bills a run to someone else, or reports one
  // account while the child authenticates as another.
  const ADMITTED = "account-admitted";
  const NODE_DEFAULT = "account-node-default";

  interface AccountChannels {
    readonly typed?: string;
    readonly bag?: string;
  }

  interface AccountScenario {
    /** The account the node-wide resume spawn config was built for; absent means none. */
    readonly nodeDefault?: string;
    /** Channels a create names; absent means the session is resumed cold. */
    readonly create?: AccountChannels;
    /** The typed account a resume names; absent means no resume runs. */
    readonly resume?: { readonly typed?: string };
  }

  function accountHarness(nodeDefault: string | undefined): Harness {
    const harness = createHarness(
      nodeDefault === undefined
        ? {}
        : { resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: nodeDefault } },
    );
    // A resume holds the new and the superseded connection at once, and the fake keys listeners by
    // pty session id.
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/start", () => threadStartResult());
    harness.server.on("thread/resume", () => threadStartResult(1));
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));
    harness.server.on("skills/list", () => ({
      result: { data: [{ cwd: SESSION_CWD, skills: [{ name: "review" }], errors: [] }] },
    }));
    return harness;
  }

  async function create(harness: Harness, channels: AccountChannels): Promise<void> {
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config:
        channels.bag === undefined
          ? SESSION_CONFIG
          : { ...SESSION_CONFIG, providerAccountId: channels.bag },
      ...(channels.typed === undefined ? {} : { providerAccountId: channels.typed }),
    });
  }

  async function resume(harness: Harness, typed: string | undefined): Promise<string> {
    const result = await harness.driver.resumeSession({
      ...RESUME_PARAMS,
      ...(typed === undefined ? {} : { providerAccountId: typed }),
    });
    return result.status;
  }

  /** Read back through the consumer that routes on it, the command list's entry binding. */
  async function boundAccountId(harness: Harness): Promise<string | null> {
    const result = await harness.driver.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    return result.bindings[0]?.binding.providerAccountId ?? null;
  }

  // The admitting rows are the controls the refusals below need: an arm that refused every named
  // account would pass the refusals alone.
  const bindings: ReadonlyArray<readonly [string, AccountScenario, string | null]> = [
    ["a create's typed member", { create: { typed: ADMITTED } }, ADMITTED],
    ["a create's config bag", { create: { bag: ADMITTED } }, ADMITTED],
    [
      "a cold resume whose typed member agrees with the node default",
      { nodeDefault: ADMITTED, resume: { typed: ADMITTED } },
      ADMITTED,
    ],
    ["a cold resume naming none", { nodeDefault: NODE_DEFAULT, resume: {} }, NODE_DEFAULT],
    [
      "a warm resume naming none, which keeps the record's account",
      { nodeDefault: NODE_DEFAULT, create: { typed: ADMITTED }, resume: {} },
      ADMITTED,
    ],
    [
      "a warm resume of an accountless session, which never adopts the node default",
      { nodeDefault: NODE_DEFAULT, create: {}, resume: {} },
      null,
    ],
    [
      "a warm resume whose typed member matches the record",
      { nodeDefault: NODE_DEFAULT, create: { typed: ADMITTED }, resume: { typed: ADMITTED } },
      ADMITTED,
    ],
  ];

  it.each(bindings)("binds %s", async (_label, scenario, expected) => {
    const harness = accountHarness(scenario.nodeDefault);
    if (scenario.create !== undefined) {
      await create(harness, scenario.create);
    }
    if (scenario.resume !== undefined) {
      expect(await resume(harness, scenario.resume.typed)).toBe("resumed");
    }

    expect(await boundAccountId(harness)).toBe(expected);
  });

  it.each([
    ["two channels naming different accounts", { typed: ADMITTED, bag: NODE_DEFAULT }],
    // An empty string is a daemon that meant to bind an account and bound nothing.
    ["a present-but-empty typed member", { typed: "" }],
  ])("refuses a create with %s before anything spawns", async (_label, channels) => {
    const harness = accountHarness(undefined);

    const refused = await create(harness, channels).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    expect(harness.server.spawnRequests).toEqual([]);
  });

  const resumeRefusals: ReadonlyArray<
    readonly [string, AccountScenario & { resume: { typed: string } }]
  > = [
    // A cold resume spawns from the node-wide env, built for another account or for none.
    [
      "a cold resume naming an account the node env was not built for",
      { nodeDefault: NODE_DEFAULT, resume: { typed: ADMITTED } },
    ],
    [
      "a cold resume naming an account while the node default is unbound",
      { resume: { typed: ADMITTED } },
    ],
    [
      "a warm resume contradicting the live record",
      { create: { typed: ADMITTED }, resume: { typed: NODE_DEFAULT } },
    ],
    [
      "a warm resume naming an account while the live record bound none",
      { nodeDefault: NODE_DEFAULT, create: {}, resume: { typed: ADMITTED } },
    ],
  ];

  it.each(resumeRefusals)("refuses %s, as a result, spawning nothing", async (_label, scenario) => {
    const harness = accountHarness(scenario.nodeDefault);
    if (scenario.create !== undefined) {
      await create(harness, scenario.create);
    }
    const spawnsBefore = harness.server.spawnRequests.length;

    expect(await resume(harness, scenario.resume.typed)).toBe("failed");

    expect(harness.server.spawnRequests).toHaveLength(spawnsBefore);
    // A failed resume changes nothing: the live predecessor keeps its account.
    if (scenario.create !== undefined) {
      expect(await boundAccountId(harness)).toBe(scenario.create.typed ?? null);
    }
  });
});

describe("Codex sandbox posture realization", () => {
  // The provider accepts and ignores an unrecognized config key, so a network setting that silently
  // stopped applying looks like one that applied. The readback is the only check.
  it("reports a readback narrower or wider than the requested network access", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => ({
      result: {
        thread: { id: THREAD_ID, sessionId: "session-tree-1", turns: [] },
        sandbox: { networkAccess: false },
      },
    }));

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      executionPosture: {
        mode: "ask",
        credentialPolicyRef: "policy://default",
        networkAccess: "full",
        writableRoots: [SESSION_CWD],
      },
    });

    const diverged = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "posture-realization-diverged",
    );
    expect(diverged).toHaveLength(1);
    expect(diverged[0]).toMatchObject({
      requestedNetworkAccess: true,
      realizedNetworkAccess: false,
    });
    // Wider is the sandbox leak: network open where "none" was asked.
    expect(
      describeCodexPostureDivergence(
        {
          mode: "ask",
          credentialPolicyRef: "policy://default",
          networkAccess: "none",
          writableRoots: [],
        },
        { networkAccess: true },
      ),
    ).toStrictEqual({ requestedNetworkAccess: false, realizedNetworkAccess: true });
  });
});

describe("Codex websocket transport", () => {
  const selection: CodexTransportSelection = {
    transport: "websocket",
    endpoint: "ws://127.0.0.1:8451",
    bearerTokenRef: "keyring://codex/ws",
  };

  it("resolves the bearer ref at connection time, once per connection, never at construction", async () => {
    // Resolved once and cached, a rotated credential would go unnoticed and later connections
    // would present a retired secret.
    const resolvedRefs: string[] = [];
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
    server.on("thread/start", () => threadStartResult());
    const driver = new CodexDriver({
      ptyHost: server,
      modelCatalogExchange: STUB_MODEL_CATALOG_READ,
      diagnostics: makeSilentDriverDiagnostics(),
      subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
      reportDiagnostic: () => undefined,
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
      newBindingId: () => "binding-abc",
      readCapabilities: () => makeCapabilities(true),
      transportConfig: selection,
      resolveBearerCredential: async (bearerTokenRef): Promise<CodexWebsocketBearerCredential> => {
        resolvedRefs.push(bearerTokenRef);
        return await Promise.resolve({
          mode: "capability-token",
          tokenFilePath: "/run/codex/ws.token",
        });
      },
      websocketConnector: { connect: async (): Promise<void> => await Promise.resolve() },
    });
    expect(resolvedRefs).toStrictEqual([]);

    await driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await driver.createSession({
      model: TEST_MODEL,
      sessionId: "22222222-2222-4222-8222-222222222222" as SessionId,
      config: SESSION_CONFIG,
    });

    expect(resolvedRefs).toStrictEqual([selection.bearerTokenRef, selection.bearerTokenRef]);
  });

  it("starts the listener with bearer auth on every credential mode, and refuses one without", () => {
    // A listener started without auth is reachable by anything that can open a socket to it.
    expect(
      composeCodexTransportArgv(selection, {
        mode: "capability-token",
        tokenFilePath: "/run/codex/ws.token",
      }),
    ).toStrictEqual([
      "app-server",
      "--listen",
      "ws://127.0.0.1:8451",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/run/codex/ws.token",
    ]);
    expect(
      composeCodexTransportArgv(selection, {
        mode: "capability-token-digest",
        tokenSha256: "a".repeat(64),
      }),
    ).toStrictEqual([
      "app-server",
      "--listen",
      "ws://127.0.0.1:8451",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      "a".repeat(64),
    ]);
    expect(() => composeCodexTransportArgv(selection, null)).toThrow(CodexDriverConfigError);
  });
});
