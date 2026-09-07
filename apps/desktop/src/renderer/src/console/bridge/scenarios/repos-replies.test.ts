// Every scripted answer this scenario serves, held to one rule about time.
//
// THE CLAIM IS ABOUT DIRECTION, NOT VALUES. A fixture that states what a session
// already has — a mount attached, a root created, a probe taken — has to state it in
// the past, because the surfaces that draw those rows measure an age from the read's
// own instant and the read lands one debounce interval after the scenario opens. Every
// record in `repos-replies.ts` was stamped a fraction of a second AFTER the start, so
// four committed screenshot references shipped with "Created in 1 second" on them.
// Read as a table of literals nobody could see it; asserted here, no record can rejoin
// them quietly.

import { describe, expect, it } from "vitest";

import { compareInstants, parseInstant } from "../../core/index.js";
import { REPOS_SCENARIO_STARTED_AT_ISO } from "./repos-beats.js";
import {
  DRIFTED_MOUNT_ID,
  DRIFTED_WORKSPACE_ID,
  EPHEMERAL_CLONE_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REVIEWER_WORKTREE_ID,
} from "./repos-fixture-data.js";
import { REPOS_SCENARIO_REPLIES } from "./repos-replies.js";

/**
 * The reply members that record something that ALREADY HAPPENED.
 *
 * Named rather than matched on a suffix, because `expiresAt` shares the suffix and is
 * the one member on this fixture that is a future instant by definition: a disposal
 * deadline the clone has not reached yet is what separates the elapsed clone from the
 * reclaimed one.
 */
const PAST_TENSE_REPLY_INSTANT_MEMBERS: readonly string[] = [
  "attachedAt",
  "checkedAt",
  "cleanedAt",
  "createdAt",
  "updatedAt",
];

/** Every `(member, instant)` pair a scripted answer carries, at any depth. */
function pastTenseInstantsIn(answer: unknown, found: [string, string][] = []): [string, string][] {
  if (Array.isArray(answer)) {
    for (const element of answer) {
      pastTenseInstantsIn(element, found);
    }
    return found;
  }
  if (typeof answer !== "object" || answer === null) {
    return found;
  }
  for (const [member, value] of Object.entries(answer)) {
    if (typeof value === "string" && PAST_TENSE_REPLY_INSTANT_MEMBERS.includes(member)) {
      found.push([member, value]);
      continue;
    }
    pastTenseInstantsIn(value, found);
  }
  return found;
}

/**
 * Every answer this scenario can serve, computed ones included.
 *
 * The entity-scoped reads answer through `resultFor`, so a walk over the table alone
 * would see none of the rows those tables hold — which is where most of the stamps
 * live. Each is asked under every identity this fixture declares, the mounts and
 * workspaces the section draws and the roots and paths the mutating surfaces name.
 */
function scriptedAnswers(): readonly unknown[] {
  const requests: readonly Readonly<Record<string, string>>[] = [
    { repoMountId: GIT_MOUNT_ID },
    { repoMountId: PLAIN_MOUNT_ID },
    { repoMountId: DRIFTED_MOUNT_ID },
    { workspaceId: GIT_WORKSPACE_ID },
    { workspaceId: PLAIN_WORKSPACE_ID },
    { workspaceId: DRIFTED_WORKSPACE_ID },
    { workspaceId: GIT_WORKSPACE_ID, worktreeId: IMPLEMENTER_WORKTREE_ID },
    { workspaceId: GIT_WORKSPACE_ID, worktreeId: REVIEWER_WORKTREE_ID },
    { localPath: "/Users/dev/code/telemetry-agent" },
    { workspaceId: GIT_WORKSPACE_ID, branchName: "feat/fresh-root" },
    { worktreeId: REVIEWER_WORKTREE_ID },
    { cloneId: EPHEMERAL_CLONE_ID },
  ];
  return REPOS_SCENARIO_REPLIES.flatMap((reply) =>
    reply.resultFor === undefined ? [reply.result] : requests.map(answerOf(reply.resultFor)),
  );
}

/**
 * One computed answer, or nothing where the fixture refuses that request.
 *
 * THE REFUSALS ARE ANSWERS TOO, and a scripted one is thrown rather than returned —
 * that is how a computed reply holds a refusal and a success for one call, since the
 * reply table is keyed by method and a second entry for one method is unreachable. A
 * refusal carries no instants, so it contributes nothing to either walk; what matters
 * is that asking for one does not abort the walk before it reaches the rows that do.
 */
function answerOf(resultFor: (request: unknown) => unknown): (request: unknown) => unknown {
  return (request) => {
    try {
      return resultFor(request);
    } catch {
      return undefined;
    }
  };
}

describe("the repos scenario — no scripted answer is dated in its own future", () => {
  it("stamps every past-tense reply member at or before the scenario's start", () => {
    // THE DEFECT THIS EXISTS AGAINST rendered on four committed references: every
    // record in `repos-replies.ts` was stamped a fraction of a second AFTER the
    // scenario's declared start, the section's read lands one debounce interval
    // after that start, and `WorktreeCard` measures its age from the two — so both
    // execution-root cards read "Created in 1 second", a creation age in the future
    // on a card describing a root the session was already running in.
    const observed = scriptedAnswers().flatMap((answer) => pastTenseInstantsIn(answer));

    // The walk found something. Without this the assertion below passes over a table
    // whose computed answers were never reached.
    expect(observed.length).toBeGreaterThan(0);
    const start = parseInstant(REPOS_SCENARIO_STARTED_AT_ISO);
    for (const [member, instant] of observed) {
      // Read through the console's own stamp reader rather than the platform's: a
      // malformed fixture stamp sorts LAST here, so a record this walk cannot read
      // fails the assertion instead of passing it as a number nobody checked.
      expect(
        compareInstants(parseInstant(instant), start),
        `${member} is stamped ${instant}, which is after the scenario's own start`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it("negative control: a deadline is still allowed to be ahead of the start", () => {
    // Without this the rule above could be widened to every `*At` member, and the
    // reclaimed clone — whose disposal deadline is deliberately still ahead — would
    // have to be re-dated into the past, which is the one fixture state that reaches
    // the reclaimed-ahead-of-deadline reading at all.
    const deadlines = scriptedAnswers().flatMap((answer) => expiresAtInstantsIn(answer));
    const start = parseInstant(REPOS_SCENARIO_STARTED_AT_ISO);
    const anyAhead = deadlines.some((instant) => compareInstants(parseInstant(instant), start) > 0);
    expect(anyAhead).toBe(true);
  });
});

/** Every `expiresAt` a scripted answer carries, at any depth. */
function expiresAtInstantsIn(answer: unknown, found: string[] = []): string[] {
  if (Array.isArray(answer)) {
    for (const element of answer) {
      expiresAtInstantsIn(element, found);
    }
    return found;
  }
  if (typeof answer !== "object" || answer === null) {
    return found;
  }
  for (const [member, value] of Object.entries(answer)) {
    if (member === "expiresAt" && typeof value === "string") {
      found.push(value);
      continue;
    }
    expiresAtInstantsIn(value, found);
  }
  return found;
}
