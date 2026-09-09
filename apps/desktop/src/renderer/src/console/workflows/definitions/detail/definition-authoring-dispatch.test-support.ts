// What both of this dispatch's suites need to press an act and read what came back.
//
// TWO SUITES BECAUSE THE MODULE HAS TWO HALVES, and the seam is its own: exporting
// reaches the HOST and submits nothing, while importing and promoting both ride the one
// create on the growth port. The two ask different questions of different seams — when
// a clipboard write may be called settled, and what a create body carries — so they are
// two files, and everything they share is here rather than typed out twice.
//
// EVERY CASE DRIVES THE REAL HOOK OVER A REAL GROWTH PORT. The port is the refusing one
// with a single arm replaced, which is what a build with no `workflow.*` wire actually
// hands this surface; a hand-built port would let a suite agree with whatever the hook
// did with it.

import { act, renderHook } from "@testing-library/react";
import { expect } from "vitest";

import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import {
  workflowDefinitionReadFor,
  workflowVersionBodyFor,
} from "../../../bridge/scenario/workflows/bodies.js";
import { DEFINITION_RELEASE_CHECKS_SESSION } from "../../../bridge/scenario/workflows/ids.js";
import type { ConsoleBridge, GrowthPort, WorkflowVersionBody } from "../../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { useWorkflowDefinitionAuthoring } from "./definition-authoring-dispatch.js";
import {
  WORKFLOW_DETAIL_REFUSAL_CODES,
  type WorkflowDefinitionAuthoring,
  type WorkflowDetailActOutcome,
  type WorkflowDetailRefusalCode,
} from "./definition-authoring.js";

/**
 * The body the fixture states for the definition every case is addressed at.
 *
 * The version number is READ off the definition rather than written down: the fixture
 * answers a body for the latest version alone, so a number restated here would be a
 * second copy of a fact that moves whenever the scenario's table does.
 */
export function scriptedBody(): WorkflowVersionBody {
  const definition = workflowDefinitionReadFor(DEFINITION_RELEASE_CHECKS_SESSION);
  const body =
    definition === undefined
      ? undefined
      : workflowVersionBodyFor(definition.id, definition.versionNumber);
  if (body === undefined) {
    throw new Error("the fixture states no body for the definition these cases open");
  }
  return body;
}

/** The two seams an act reaches, each replaceable and each optional. */
export interface BridgeParts {
  /** Replaces the port's create arm. Absent leaves the refusing one in place. */
  readonly create?: GrowthPort["workflowDefinitionCreate"];
  /** Replaces the host's clipboard write. Absent accepts every write. */
  readonly copyToClipboard?: (file: string) => Promise<void>;
}

/** A bridge carrying exactly the two seams an act reaches: the port and the clipboard. */
export function authoringBridge(parts: BridgeParts = {}): ConsoleBridge {
  const refusing = createRefusingGrowthPort();
  const growth: GrowthPort = {
    ...refusing,
    ...(parts.create === undefined ? {} : { workflowDefinitionCreate: parts.create }),
  };
  const copyToClipboard = parts.copyToClipboard ?? (async () => undefined);
  return {
    growth,
    sidekicks: { native: { copyToClipboard } },
  } as unknown as ConsoleBridge;
}

/** One mounted hook: what it reads now, and a way to press it and let answers land. */
export interface MountedAuthoring {
  readonly current: () => WorkflowDefinitionAuthoring;
  readonly press: (pressed: () => void) => Promise<void>;
}

/**
 * Mount the hook against one definition, and give the caller a way to press it.
 *
 * BOTH SUBJECTS ARE REQUIRED AND NEITHER DEFAULTS, which is a decision these suites made
 * the hard way: a default parameter is applied to an argument passed as `undefined`, so
 * the two cases that exist to drive an absent session and an absent body were each
 * getting the present one and passing against the wrong arm.
 */
export function mountAuthoring(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  body: WorkflowVersionBody | undefined,
): MountedAuthoring {
  const mounted = renderHook(() =>
    useWorkflowDefinitionAuthoring(bridge, DEFINITION_RELEASE_CHECKS_SESSION, sessionId, body),
  );
  return {
    current: () => mounted.result.current,
    press: async (pressed) => {
      await act(async () => {
        pressed();
        // A boundary and not a counted turn: the clipboard write and the create both
        // settle through the normalizer and a publish, and a chain one link deeper
        // would leave a case asserting about the state from before the answer landed.
        await crossMacrotaskBoundary();
      });
    },
  };
}

/** The code on an outcome that refused, or the kind it took instead. */
export function refusalCode(outcome: WorkflowDetailActOutcome): string {
  return outcome.kind === "refused" ? outcome.refusal.code : `not refused: ${outcome.kind}`;
}

/** Whatever sentence an outcome carries, or the kind it took instead. */
export function outcomeDetail(outcome: WorkflowDetailActOutcome): string {
  return outcome.kind === "dispatching" || outcome.kind === "settled"
    ? outcome.detail
    : `no detail: ${outcome.kind}`;
}

/**
 * Assert one act refused with a code this surface DECLARES.
 *
 * Two claims and not one: the specific code, and its membership in the closed tuple.
 * Without the second a refusal raised with a string nobody declared would pass every
 * case that names it, which is the whole failure mode the vocabulary exists to stop.
 */
export function expectLocalRefusal(
  outcome: WorkflowDetailActOutcome,
  code: WorkflowDetailRefusalCode,
): void {
  expect(refusalCode(outcome)).toBe(code);
  expect(WORKFLOW_DETAIL_REFUSAL_CODES).toContain(code);
}
