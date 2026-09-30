// `repo.ts`: a raw string is not a branded mount id, and each instantiation of the lifecycle
// payload factory accepts only its own state vocabulary.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildRepoWorkspaceLifecyclePayloadSchema, type RepoMountId } from "../repo.js";

// A real RFC 9562 UUID; the session id schema checks the version and variant bits.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// Compile-time pin on the brand, checked by the `tsconfig.test.json` typecheck. If the brand
// weakens to a bare `string`, TS reports the directive unused (TS2578).
const brandNominalityPin = (): void => {
  // @ts-expect-error — a raw string is not a RepoMountId without a parse.
  const unbranded: RepoMountId = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
  void unbranded;
};
void brandNominalityPin;

// Stands in for the worktree states: four transitions plus `ready`, the only literal shared
// with either vocabulary.
const worktreeLikeStateSchema = z.enum(["creating", "ready", "dirty", "merged", "retired"]);
const worktreeLikePayloadSchema = buildRepoWorkspaceLifecyclePayloadSchema(worktreeLikeStateSchema);

describe("buildRepoWorkspaceLifecyclePayloadSchema (a parameter, not a third union arm)", () => {
  it.each(["creating", "ready", "dirty", "merged", "retired"])(
    "an instantiation accepts its own vocabulary: %s",
    (state) => {
      expect(worktreeLikePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success).toBe(
        true,
      );
    },
  );

  it.each(["attached", "detached", "preparing", "busy", "stale"])(
    "an instantiation REJECTS state a shared union would have admitted: %s",
    (state) => {
      // A shared third union arm would widen every type at once, so a `worktree.retired`
      // payload could claim `state: "preparing"`.
      expect(worktreeLikePayloadSchema.safeParse({ sessionId: SESSION_ID, state }).success).toBe(
        false,
      );
    },
  );
});
