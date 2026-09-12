// The cast both `AttachFlow` suites drive the view with.
//
// Hoisted because the suite splits on the module's own seam — what the flow SENDS
// (`attach-request.ts`) and what it DRAWS (`AttachFlow.tsx`) — and both halves need
// the same mock bridge arm, the same identifiers, the same draft, and the same
// response fixtures. A second copy of the draft is two files disagreeing about what
// this view declares.
//
// The header's standing directive — the mock bridge is duplicated per test FILE
// rather than hoisted — is about not sharing a bridge across VIEWS, whose bridge
// surfaces differ: this view's is `controlPlane.call` alone, narrower than
// NodeRoster's. Two halves of one view's suite are one subject, and `apps/desktop`
// AGENTS.md gives one role one home.
//
// WHERE RETURN-TYPE DRIFT IS ACTUALLY CAUGHT — and where it is NOT (PR #355 Codex
// round 1). The bridge declares `call<P extends CpProcedure>(procedure, input):
// Promise<CpOutput<P>>`, and `CpOutput<P>` is the deferred conditional `P extends
// CpProcedure ? unknown : never`, i.e. `unknown`. So NO typing of the mock arm can
// constrain what the call resolves to — measured, not assumed: `vi.fn<Arm["call"]>()`
// is not even assignable to that generic signature (TS2322), and a typed mock
// resolving `{ bogus: true }` compiles clean. Drift is caught instead by the RESPONSE
// FIXTURES below, each annotated with its shipped contract type, so a changed
// `RuntimeNodeAttachResponse` fails HERE at the fixture line. Verified by mutation:
// adding a required member to that interface in `packages/contracts/src/runtime-node.ts`
// fails with TS2741 at both fixtures. The `expectTypeOf` assertion beside them makes
// that protection STRUCTURAL rather than incidental — a future edit that loosens a
// fixture annotation to satisfy some other constraint re-fails here.

import { fireEvent, screen } from "@testing-library/react";
import { expectTypeOf, vi } from "vitest";
import type { Mock } from "vitest";

import type {
  EventEnvelopeVersion,
  NodeId,
  UserId,
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  SessionId,
  SidekicksBridge,
} from "@ai-sidekicks/contracts";

import type { RuntimeNodeAttachDraft, RuntimeNodeAttachReads } from "../attach-request.js";

// Typed bridge arm — `Pick<...>` over the SHIPPED bridge interface rather than a
// hand-written literal, so a renamed or deleted member makes the `Pick` constraint
// itself fail (TS2344) at this line.
type ControlPlaneCallArm = Pick<SidekicksBridge["controlPlane"], "call">;

/** Install the one bridge arm this view reaches, and nothing else. */
export function installMockBridge(controlPlaneCall: ControlPlaneCallArm["call"]): void {
  const bridge: { controlPlane: ControlPlaneCallArm } = {
    controlPlane: { call: controlPlaneCall },
  };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

/** Take the bridge back off the window, so no case inherits another's stub. */
export function removeMockBridge(): void {
  delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
}

export const TARGET_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
export const OTHER_SESSION_ID = "01970000-0000-7000-8000-0000000000a2" as SessionId;
export const ATTACHING_NODE_ID = "01970000-0000-7000-8000-0000000000c1" as NodeId;
export const OTHER_NODE_ID = "01970000-0000-7000-8000-0000000000c2" as NodeId;
// Not exported: no case names the owning user directly — it reaches the
// assertions only through the draft below.
const OWNING_USER_ID = "01970000-0000-7000-8000-0000000000b1" as UserId;

export const ATTACH_DRAFT: RuntimeNodeAttachDraft = {
  userId: OWNING_USER_ID,
  nodeId: ATTACHING_NODE_ID,
  clientVersion: "2.0" as EventEnvelopeVersion,
  capabilities: { "shell.exec": true, "worktree.write": { maxConcurrency: 2 } },
  healthState: "online",
};

export const READ_WRITE_ATTACH_RESPONSE: RuntimeNodeAttachResponse = {
  attachmentId: "01970000-0000-7000-8000-0000000000d1",
  state: "online",
  readOnly: false,
  attachedAt: "2026-06-10T10:00:00.000Z",
};

export const READ_ONLY_ATTACH_RESPONSE: RuntimeNodeAttachResponse = {
  attachmentId: "01970000-0000-7000-8000-0000000000d2",
  state: "online",
  readOnly: true,
  attachedAt: "2026-06-10T10:01:00.000Z",
};

// The drift tripwire, asserted rather than merely annotated. `toEqualTypeOf` is
// invariant, so widening `RuntimeNodeAttachResponse` (a new required member) OR
// loosening either fixture's annotation fails HERE, at typecheck, naming this
// contract — not somewhere downstream with an opaque message.
expectTypeOf(READ_WRITE_ATTACH_RESPONSE).toEqualTypeOf<RuntimeNodeAttachResponse>();
expectTypeOf(READ_ONLY_ATTACH_RESPONSE).toEqualTypeOf<RuntimeNodeAttachResponse>();

/** Press the idle branch's one control. */
export function clickAttach(): void {
  fireEvent.click(screen.getByRole("button", { name: "Attach runtime node" }));
}

/** What one case's attach answers. Concrete, so its return type is checked. */
export type AttachNodeMock = Mock<
  (request: RuntimeNodeAttachRequest) => Promise<RuntimeNodeAttachResponse>
>;

/** A built transport, plus the handle a case drives it by. */
export interface DrivenAttachTransport {
  readonly reads: RuntimeNodeAttachReads;
  readonly attachNode: AttachNodeMock;
}

/**
 * Build one transport for the view to attach through.
 *
 * A BUILDER RATHER THAN AN OBJECT LITERAL PER CASE, because the transport's IDENTITY
 * is what the addressing cases are about: the view stamps its settled receipt with the
 * seam it was attached through, so a case has to hold one object across a re-render and
 * hand a DIFFERENT one in to express a replacement. A literal composed inline in the
 * JSX would be a new object on every pass, which re-addresses the holder on every
 * render and would make every one of those cases pass for the wrong reason.
 *
 * Mirrors `createDrivenSeam` on the roster suite beside it, one member narrower
 * because this view's seam is one call.
 */
export function createAttachTransport(
  attachNode: (request: RuntimeNodeAttachRequest) => Promise<RuntimeNodeAttachResponse>,
): DrivenAttachTransport {
  const mockedAttachNode: AttachNodeMock = vi.fn(attachNode);
  return { reads: { attachNode: mockedAttachNode }, attachNode: mockedAttachNode };
}
