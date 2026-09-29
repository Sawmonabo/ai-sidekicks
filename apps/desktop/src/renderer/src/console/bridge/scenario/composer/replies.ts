// What the composer scenario ANSWERS, as opposed to what it plays.
//
// A reply is a read and a beat is a stream frame, and the fixture serves them through
// different seams: a call is looked up here by method and answered once, while a beat
// is routed to a subscription by kind and arrives on the frozen clock. The split is
// the file's own — this scenario's replies carry their own scripted latencies, which
// is a property of a call and meaningless for a frame.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";
import { RUN_ID, SESSION_ID } from "./identifiers.js";

/**
 * One driver's capability declaration, with every registered flag stated.
 *
 * Built from `DRIVER_CAPABILITY_FLAGS` rather than hand-listed, because
 * `DriverCapabilities.flags` is a TOTAL record over that tuple: a partial literal
 * would read as "the driver did not declare this" for every flag it forgot, which is
 * a different answer from `false`.
 */
function declaredFlags(
  enabled: readonly DriverCapabilityFlag[],
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = enabled.includes(flag);
  }
  return flags;
}

/** What the pinned Claude build declares. */
const CLAUDE_FLAGS: readonly DriverCapabilityFlag[] = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "rollback",
  "session_goals",
  "callback_tools",
  "subagents",
  "context_compaction",
  "provider_commands",
  "output_speed",
];

/**
 * What the pinned Codex build declares.
 *
 * `output_speed` is absent, and its absence is the case a speed control exists to
 * handle: the control is ABSENT rather than disabled for this driver, because a
 * disabled control asserts a capability exists and is momentarily unavailable.
 */
const CODEX_FLAGS: readonly DriverCapabilityFlag[] = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "structured_output",
  "session_goals",
  "callback_tools",
  "subagents",
  "transcript_replay",
  "context_compaction",
  "provider_commands",
];

/** Every call the composer scenario answers, and what it answers with. */
export const COMPOSER_REPLIES: readonly ScenarioReply[] = [
  {
    // The registered `SessionReadResponse` shape.
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
    // The catalog's other half, declared from the two pinned-build flag sets above.
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
];
