// What the composer scenario ANSWERS, as opposed to what it plays.
//
// A reply is a read and a beat is a stream frame, and the fixture serves them through
// different seams: a call is looked up here by method and answered once, while a beat
// is routed to a subscription by kind and arrives on the frozen clock. The split is
// the file's own — this scenario's replies carry their own scripted latencies, which
// is a property of a call and meaningless for a frame.

import type { ScenarioReply } from "../scenario-runtime/index.js";
import { CLAUDE_FLAGS, CODEX_FLAGS, declaredFlags } from "./agents-cast.js";
import { COMPOSER_AGENTS, RUN_ID, SESSION_ID } from "./composer.identifiers.js";

/** Every call the composer scenario answers, and what it answers with. */
export const COMPOSER_REPLIES: readonly ScenarioReply[] = [
  {
    // The registered `SessionReadResponse` shape. `state: "active"` is what the
    // fixture's directory derivation reads to list this session on the node —
    // a scenario that declares no session state declares no session to list.
    call: "session.read",
    result: {
      session: {
        id: SESSION_ID,
        state: "active",
        config: {},
        metadata: {},
        createdAt: "2026-01-01T11:05:00.000Z",
        updatedAt: "2026-01-01T11:05:00.000Z",
      },
      timelineCursors: { latest: "composer-cursor-1" },
    },
  },
  {
    call: "agent.list",
    result: {
      agents: COMPOSER_AGENTS.map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        driverName: agent.driverName,
        modelId: agent.modelId,
        // The EFFECTIVE binding, which is where the wire carries the paying account
        // — `bridge/wire-shapes/agent-plane.ts` declares it there and the roster
        // reading reads it there. Spread rather than written as `undefined`, so a
        // row for an agent the provider's default account pays for OMITS the member
        // exactly as the wire does: absence is the statement, and a present-but-empty
        // member is a different one.
        config:
          agent.providerAccountId === undefined
            ? {}
            : { providerAccountId: agent.providerAccountId },
        // `AgentState` is the four-state lifecycle — `configured` / `ready` /
        // `disabled` / `archived`. A run being blocked is a RUN state and is read
        // from the run, never folded into the agent row.
        state: "ready",
        createdAt: agent.attachedAtIso,
      })),
    },
  },
  {
    // The queue shelf's opening read. The registered `QueueItemListResponse` is
    // `{ items }` parsed `.strict()`; an empty list is the served, complete queue
    // — nothing waiting behind the running turn — which is the state every
    // composer reference pins. A queue with rows is the runs scenario's subject.
    call: "run.queueList",
    result: { items: [] },
  },
  {
    // The step-in control's dispatch. `RunControlAck` is `.strict()` and carries
    // exactly these three members, so the reply is the post-pause reading of the
    // run above rather than a fresh invention: `runVersion` advances by one and
    // `currentState` is the state the verb reached.
    call: "run.pause",
    result: { runId: RUN_ID, currentState: "paused", runVersion: 5 },
  },
  {
    // The discovery popover's dispatch, agent-addressed within the session. The
    // reply is the GROUP LIST the wire declares and never a flat entry array: the
    // group is what carries the `(driverName, providerAccountId)` the entries were
    // read under, and the invariant this surface renders is that an entry is
    // offered only under the binding it came from.
    //
    // `runId` is the run this scenario plays, which is the one live run on this
    // binding — the arm the contract says answers with THAT run rather than with
    // `null`. `providerAccountId` is `null`, the positive statement that this
    // fixture binds no provider account: the composer scenario attaches agents and
    // registers no account, and a synthesized placeholder would make the routing
    // pair compare equal where it must not.
    //
    // The two entries differ in what the provider published, deliberately: the
    // command carries a description and the skill carries a scope and an `enabled`
    // flag, so the row that renders a provider-supplied description and the row
    // that renders its absence are both reachable.
    call: "driver.listProviderCommands",
    result: {
      bindings: [
        {
          runId: RUN_ID,
          binding: { driverName: "claude", providerAccountId: null },
          entries: [
            {
              name: "compact",
              kind: "command",
              description: "Compact the conversation context.",
              binding: { driverName: "claude", providerAccountId: null },
            },
            {
              name: "review",
              kind: "skill",
              scope: "project",
              enabled: true,
              binding: { driverName: "claude", providerAccountId: null },
            },
          ],
          complete: true,
        },
      ],
    },
  },
  {
    // The accessory rail's quota chips, read off the ACCOUNT PLANE rather than out
    // of this scenario's timeline. `usage.rate_limit_update` is bound to the
    // node-scope sentinel session, so no beat here could have carried one and the
    // chips were previously reachable only through a fold no daemon could feed.
    //
    // The reply is the registered `ProviderAccountListResponse` and carries all
    // three required members. Two accounts and three windows, chosen so the two
    // rules the chips encode are both reachable: the two Claude windows share a
    // `windowMins` and differ only by `limitId` — the pair key, and the reason a
    // duration key was abandoned — and the `weekly-opus` reading was observed at
    // generation 1 while its account is on 2, so the stale glyph renders.
    //
    // `usedPercent` values sit in the two visible bands (below 50 remaining) so a
    // screenshot has chips at all; the third window is healthy and deliberately
    // renders nothing, which is the band rule's own negative case.
    //
    // NOTHING SCRIPTS THE SUBSCRIPTION. `providerAccount.subscribe` is a
    // `daemon.subscribe` name the fixture routes as an event type, and no beat
    // carries that kind, so the tail attaches and stays silent — the chips are
    // seeded by this read and do not move, which is exactly what a byte-stable
    // screenshot needs.
    call: "providerAccount.list",
    result: {
      accounts: [
        {
          accountId: "acct-claude-team",
          provider: "claude",
          displayLabel: "Claude — team",
          credentialGeneration: 2,
          billingMode: "subscription",
          isDefault: true,
          healthState: "authenticated",
          healthObservedAt: "2026-01-01T11:00:00.000Z",
          observedAuthMode: "oauth_subscription",
          loggedInAt: "2026-01-01T09:00:00.000Z",
          expectedReloginAtEstimate: null,
          probeEnabled: true,
        },
        {
          accountId: "acct-codex-personal",
          provider: "codex",
          displayLabel: "Codex — personal",
          credentialGeneration: 1,
          billingMode: "metered",
          isDefault: false,
          healthState: "authenticated",
          healthObservedAt: "2026-01-01T11:00:00.000Z",
          observedAuthMode: "api_key",
          loggedInAt: null,
          expectedReloginAtEstimate: null,
          probeEnabled: true,
        },
      ],
      usageWindows: [
        {
          accountId: "acct-claude-team",
          limitId: "weekly-all",
          windowMins: 10080,
          label: "Weekly, all models",
          usedPercent: 62,
          resetsAt: "2026-01-03T11:00:00.000Z",
          observedAt: "2026-01-01T11:04:00.000Z",
          observedCredentialGeneration: 2,
          source: "probe",
        },
        {
          accountId: "acct-claude-team",
          limitId: "weekly-opus",
          windowMins: 10080,
          label: "Weekly, Opus",
          usedPercent: 91,
          resetsAt: "2026-01-04T11:00:00.000Z",
          observedAt: "2026-01-01T11:02:00.000Z",
          observedCredentialGeneration: 1,
          source: "run",
        },
        {
          accountId: "acct-codex-personal",
          limitId: "default",
          windowMins: 300,
          usedPercent: 8,
          observedAt: "2026-01-01T11:03:00.000Z",
          observedCredentialGeneration: 1,
          source: "probe",
        },
      ],
      readiness: [
        {
          provider: "claude",
          state: "authenticated",
          resolvedAccountId: "acct-claude-team",
          observedAt: "2026-01-01T11:00:00.000Z",
        },
        {
          provider: "codex",
          state: "authenticated",
          resolvedAccountId: "acct-codex-personal",
          observedAt: "2026-01-01T11:00:00.000Z",
        },
      ],
    },
  },
  {
    // The compaction control's dispatch. `DriverCompactionResult` is a
    // discriminated union whose `applied` arm REQUIRES `boundaryPosition`, typed
    // `number | null` — null being the positive statement that the provider's
    // frame carried no position, which is a different fact from a driver that
    // forgot to report one. This scenario reports a position, so the boundary the
    // compaction landed on is renderable.
    call: "driver.compactContext",
    // A scripted latency, so the in-flight half of the control is reachable: a
    // compaction that settled instantly would let a surface ship without ever
    // rendering the state a person actually watches.
    afterMs: 200,
    result: { status: "applied", boundaryPosition: 8 },
  },
  {
    // The first half of the driver catalog the target chip's axis popover renders.
    // Armed by the chip rail on every composer mount, so it is scripted whether or
    // not anybody opens the popover — an unscripted call is the fixture's authoring
    // error, and a refusal pinned into every composer reference would be a statement
    // about a read this scenario never meant to refuse.
    //
    // TWO DRIVERS, BECAUSE THE CAST RUNS TWO. `COMPOSER_AGENTS` mixes `claude` and
    // `codex` so the chip has a real target choice, and a catalog carrying only one
    // of them would hold the popover's actions back on the agent whose own driver the
    // catalog could not vouch for.
    call: "driver.listModels",
    result: {
      drivers: [
        {
          driverName: "claude",
          models: [
            {
              id: "claude-sonnet-5",
              name: "Sonnet 5",
              capabilities: ["reasoning", "tool_calls"],
              effortLevels: ["low", "medium", "high", "xhigh", "max"],
            },
            {
              id: "claude-opus-5[1m]",
              name: "Opus 5 (1M)",
              capabilities: ["reasoning", "tool_calls"],
              effortLevels: ["low", "medium", "high", "xhigh", "max"],
            },
          ],
        },
        {
          driverName: "codex",
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              capabilities: ["reasoning", "tool_calls"],
              effortLevels: ["low", "medium", "high", "xhigh"],
            },
          ],
        },
      ],
    },
  },
  {
    // The catalog's other half, declared from the two pinned-build flag sets rather
    // than from a list written here: what each driver declares is `agents-cast.ts`'s
    // to say, and a second list in this file would be a second answer that goes stale
    // the day the contract registers another flag.
    //
    // `outputSpeedLevels` rides the CLAUDE row only, because it is present exactly
    // where the flag is true — the daemon's own composition rule, which a fixture
    // publishing a level list beside a false flag would quietly break.
    call: "driver.listCapabilities",
    result: {
      drivers: [
        {
          driverName: "claude",
          capabilities: { flags: declaredFlags(CLAUDE_FLAGS), contractVersion: "1.0" },
          outputSpeedLevels: ["standard", "fast"],
        },
        {
          driverName: "codex",
          capabilities: { flags: declaredFlags(CODEX_FLAGS), contractVersion: "1.0" },
        },
      ],
    },
  },
  {
    // The axis popover's own dispatch, answered on the PENDING arm — the ordinary
    // outcome of a switch at a boundary that has not arrived yet, and the arm whose
    // settlement the chip re-reads the roster on. The failed arm is driven by the
    // suite that is about it rather than scripted here: `replyFor` matches on the
    // method name alone, so a second `agent.configUpdate` entry would be unreachable
    // rather than conditional.
    call: "agent.configUpdate",
    // A real switch is not instant. The latency keeps the form's in-flight rendering
    // and the latch's second-press refusal both reachable; the caller moves the
    // frozen clock, and nothing here does.
    afterMs: 200,
    result: {
      switch: {
        status: "pending",
        switchId: "019b7a11-1100-7c22-8110-d1a4c1150411",
        appliesAt: "run_boundary",
      },
    },
  },
];
