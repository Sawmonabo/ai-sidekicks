// What the definition authoring suites need to press an act and read what came back. Every case
// drives the real hook; the create is a plain function the case supplies and the host clipboard
// is the one native seam the export reaches.

// The file form's chunk reads its vocabularies from the contracts package, which compiles from
// source on first load; importing it here keeps each case's wait about the act, not the compile.
import "@ai-sidekicks/contracts";
import { act, renderHook } from "@testing-library/react";
import { expect } from "vitest";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type {
  WorkflowDefinitionReadResult,
  WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { PROBE_SESSION_ID, versionChainEntry } from "../../../workflows-probe.test-support.js";
import { useWorkflowDefinitionAuthoring } from "./useWorkflowDefinitionAuthoring.js";
import type { WorkflowDefinitionDetailCalls } from "./useWorkflowDefinitionDetail.js";
import type { WorkflowDefinitionCreateCall } from "../definition-authoring-runtime.js";
import {
  WORKFLOW_DETAIL_REFUSAL_CODES,
  type WorkflowDefinitionAuthoring,
  type WorkflowDetailActOutcome,
  type WorkflowDetailRefusalCode,
} from "../definition-authoring.js";

/** The definition every case is addressed at. */
export const DEFINITION_ID = "019b7a10-0280-7c11-8100-def111150001";

/** The one version body the cases open: a single phase, valid as a definition file. */
export const RELEASE_CHECKS_BODY: WorkflowVersionBody = {
  definitionId: DEFINITION_ID,
  versionNumber: 4,
  workflowVersionId: "019b7a10-0280-7d22-8100-be5100150004",
  contentHash: "b3:0f3c9a1d7e5b42c8a06d1f93be27540ac1d8e6b3927fa04c5de81b6203794acd",
  schemaVersion: "1.0",
  name: "Release checks",
  entry: { startMode: "manual" },
  phaseDefinitions: [
    {
      phaseId: "phase-draft",
      name: "Draft the release note",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
    },
  ],
  createdAt: "2026-01-01T07:04:00.000Z",
};

/** The definition read that names `RELEASE_CHECKS_BODY` as its latest version. */
export const RELEASE_CHECKS_DEFINITION: WorkflowDefinitionReadResult = {
  id: DEFINITION_ID,
  name: RELEASE_CHECKS_BODY.name,
  scope: "session",
  scopeRef: PROBE_SESSION_ID,
  versionNumber: RELEASE_CHECKS_BODY.versionNumber,
  workflowVersionId: RELEASE_CHECKS_BODY.workflowVersionId,
  phaseDefinitions: RELEASE_CHECKS_BODY.phaseDefinitions,
  createdAt: RELEASE_CHECKS_BODY.createdAt,
};

/** The three detail reads, each answering the release-checks definition unless replaced. */
export function answeringDetailCalls(
  replacements: Partial<WorkflowDefinitionDetailCalls> = {},
): WorkflowDefinitionDetailCalls {
  return {
    readDefinition: async () => RELEASE_CHECKS_DEFINITION,
    readVersion: async () => RELEASE_CHECKS_BODY,
    readChain: async () => ({
      versions: [
        versionChainEntry(RELEASE_CHECKS_BODY.workflowVersionId, RELEASE_CHECKS_BODY.versionNumber),
      ],
    }),
    ...replacements,
  };
}

/** A create that answers, for the cases whose subject is not what the daemon says. */
export const answeringCreate: WorkflowDefinitionCreateCall = async () => ({
  definitionId: DEFINITION_ID,
  versionNumber: 1,
  createdAt: "2026-01-01T07:05:00.000Z",
});

/** The host seam an act reaches, replaceable. */
export interface BridgeParts {
  /** Replaces the host's clipboard write. Absent accepts every write. */
  readonly copyToClipboard?: (file: string) => Promise<void>;
}

/** One mounted hook: what it reads now, and a way to press it and let answers land. */
export interface MountedAuthoring {
  readonly current: () => WorkflowDefinitionAuthoring;
  readonly press: (pressed: () => void) => Promise<void>;
}

/** A bridge carrying exactly the seam an act reaches: the host's clipboard. */
export function authoringBridge(parts: BridgeParts = {}): PlatformBridge {
  const copyToClipboard = parts.copyToClipboard ?? (async () => undefined);
  return {
    native: { copyToClipboard },
  } as unknown as PlatformBridge;
}

/**
 * Mount the hook against one definition, and give the caller a way to press it.
 * The session has no default: a default parameter applies to an argument passed as `undefined`,
 * so a case driving an absent session would get the present one.
 */
export function mountAuthoring(
  bridge: PlatformBridge,
  sessionId: string | undefined,
  body: WorkflowVersionBody,
  createDefinition: WorkflowDefinitionCreateCall = answeringCreate,
): MountedAuthoring {
  const mounted = renderHook(() =>
    useWorkflowDefinitionAuthoring(bridge, createDefinition, DEFINITION_ID, sessionId, body),
  );
  return {
    current: () => mounted.result.current,
    press: async (pressed) => {
      await act(async () => {
        pressed();
        // A boundary rather than a counted turn: answers settle through a normalizer and a
        // publish, at a depth a turn count would miss.
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
 * Assert one act refused with a declared code: the specific code, and its membership in the
 * closed tuple, so a refusal raised with an undeclared string cannot pass.
 */
export function expectLocalRefusal(
  outcome: WorkflowDetailActOutcome,
  code: WorkflowDetailRefusalCode,
): void {
  expect(refusalCode(outcome)).toBe(code);
  expect(WORKFLOW_DETAIL_REFUSAL_CODES).toContain(code);
}
