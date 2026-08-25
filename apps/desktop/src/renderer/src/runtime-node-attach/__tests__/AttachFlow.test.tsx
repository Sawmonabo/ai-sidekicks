// Plan-003 Phase 5 T5.1 — AttachFlow renderer component suite.
//
// BL-131 exit criterion (b), this view's share: bridge-only data access (no
// `node:*` / `electron` / daemon / control-plane imports), the four render
// states (idle / pending / resolved / rejected), and below-floor read-only
// surfacing on the attach reply. Criterion (c) — the two-client attach E2E that
// replaces the T5.4 manual smoke — is out of scope here and stays open on
// Plan-023 Tier 8.
//
// Spec coverage:
//   • `Spec-003 §Required Behavior` (attach carries node identity, declared
//     capabilities, health, and trust context): the composed-payload case
//     asserts the exact `runtimenode.attach` input the view sends, and the
//     declaration block renders on EVERY state — the operator can always see
//     what the node is declaring, including while the attach is in flight and
//     after it is refused.
//   • `Spec-003 §Acceptance Criteria` AC4 (admitted READ-ONLY below the floor):
//     the read-only reply case asserts the attach SUCCEEDS and renders its
//     read-only access label — admission, not refusal.
//   • I-003-1 (admit-not-eject): the read-only reply is a `resolved` state, not
//     an error state.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the
//     view reaches the control plane ONLY through `window.sidekicks` (the mock
//     bridge below IS that seam), and the bridge-projection source scan at the
//     bottom of this file.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react`
// — see `ADR-022 §Decision Log` (2026-08-25).
//
// The mock bridge is DUPLICATED per test file (the standing renderer-suite
// directive) rather than hoisted to a shared helper — this view's bridge
// surface is `controlPlane.call` ALONE, narrower than NodeRoster's. The arm
// SHAPE is not hand-rolled: it is `Pick<SidekicksBridge["controlPlane"], "call">`,
// so renaming or removing that member fails THIS file's typecheck.

import { fireEvent, render, screen } from "@testing-library/react";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";
import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeAttachResponse,
  SessionId,
  SidekicksBridge,
} from "@ai-sidekicks/contracts";

import { AttachFlow } from "../AttachFlow.js";
import type { RuntimeNodeAttachDraft } from "../AttachFlow.js";

// CP-003-3 source-text read — Vite `import.meta.glob` raw form. See the
// MixedVersionStatus suite's header for the full rationale (`node:fs` is doubly
// banned in renderer programs, so the source text arrives inlined at transform
// time instead). The augmentation is scoped to this test program.
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const runtimeNodeViewSources = import.meta.glob("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Typed bridge arm — `Pick<...>` over the SHIPPED bridge interface rather than a
// hand-written literal, so a renamed or deleted member makes the `Pick`
// constraint itself fail (TS2344) at this line.
type ControlPlaneCallArm = Pick<SidekicksBridge["controlPlane"], "call">;

function installMockBridge(controlPlaneCall: ControlPlaneCallArm["call"]): void {
  const bridge: { controlPlane: ControlPlaneCallArm } = {
    controlPlane: { call: controlPlaneCall },
  };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

const TARGET_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
const OTHER_SESSION_ID = "01970000-0000-7000-8000-0000000000a2" as SessionId;
const ATTACHING_NODE_ID = "01970000-0000-7000-8000-0000000000c1" as NodeId;
const OTHER_NODE_ID = "01970000-0000-7000-8000-0000000000c2" as NodeId;
const OWNING_PARTICIPANT_ID = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;

const ATTACH_DRAFT: RuntimeNodeAttachDraft = {
  participantId: OWNING_PARTICIPANT_ID,
  nodeId: ATTACHING_NODE_ID,
  clientVersion: "2.0" as EventEnvelopeVersion,
  capabilities: { "shell.exec": true, "worktree.write": { maxConcurrency: 2 } },
  healthState: "online",
};

const READ_WRITE_ATTACH_RESPONSE: RuntimeNodeAttachResponse = {
  attachmentId: "01970000-0000-7000-8000-0000000000d1",
  state: "online",
  readOnly: false,
  attachedAt: "2026-06-10T10:00:00.000Z",
};

const READ_ONLY_ATTACH_RESPONSE: RuntimeNodeAttachResponse = {
  attachmentId: "01970000-0000-7000-8000-0000000000d2",
  state: "online",
  readOnly: true,
  attachedAt: "2026-06-10T10:01:00.000Z",
};

function clickAttach(): void {
  fireEvent.click(screen.getByRole("button", { name: "Attach runtime node" }));
}

describe("AttachFlow (Plan-003 Phase 5 T5.1)", () => {
  afterEach(() => {
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  describe("idle state", () => {
    it("renders the declaration and attaches nothing until the operator asks", () => {
      // Unlike the mount-triggered NodeRoster, attach is an explicit ACT: a
      // render must never write to the control plane on its own.
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);

      const idleSection = screen.getByLabelText("runtime-node-attach-idle");
      expect(idleSection.getAttribute("data-attach-state")).toBe("idle");
      expect(controlPlaneCall).not.toHaveBeenCalled();
      expect(screen.getByLabelText("attach-node-declaration")).toBeDefined();
      expect(screen.getByText(`node id: ${ATTACHING_NODE_ID}`)).toBeDefined();
      expect(screen.getByText(`target session: ${TARGET_SESSION_ID}`)).toBeDefined();
      expect(screen.getByText("reported health: online")).toBeDefined();
      expect(screen.getByRole("button", { name: "Attach runtime node" })).toBeDefined();
    });

    it("composes the declared capabilities through CapabilityDeclaration", () => {
      // Proves the child view is COMPOSED, not merely imported: the declared
      // capability rows are reachable from the attach surface.
      const controlPlaneCall = vi.fn();
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);

      const declarationSection = screen.getByLabelText("capability-declaration");
      expect(declarationSection.getAttribute("data-capability-count")).toBe("2");
      expect(screen.getByText("capability: shell.exec")).toBeDefined();
    });

    it("surfaces an empty capability map as the explicit least-privilege state", () => {
      const controlPlaneCall = vi.fn();
      installMockBridge(controlPlaneCall);

      render(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={{ ...ATTACH_DRAFT, capabilities: {} }}
        />,
      );

      expect(screen.getByLabelText("capability-declaration-empty")).toBeDefined();
      expect(
        screen.getByText("No capabilities declared — nothing on this node is schedulable."),
      ).toBeDefined();
    });
  });

  describe("attach request", () => {
    it("sends the draft composed with the session prop as the attach input", () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      expect(controlPlaneCall).toHaveBeenCalledTimes(1);
      expect(controlPlaneCall).toHaveBeenCalledWith("runtimenode.attach", {
        ...ATTACH_DRAFT,
        sessionId: TARGET_SESSION_ID,
      });
    });

    it("lets the session PROP win over a stale sessionId carried on the draft", () => {
      // The draft type omits `sessionId` precisely so the prop is the single
      // source of truth, but a rogue field can still arrive at runtime (a
      // caller spreading a full `RuntimeNodeAttachRequest` into the draft slot).
      // The view's `{ ...attachDraft, sessionId }` spread ORDER is what makes
      // the prop win; reversing it would attach the node to the wrong session.
      // The cast below is the point of the test, not an accident.
      const draftWithStaleSession = {
        ...ATTACH_DRAFT,
        sessionId: OTHER_SESSION_ID,
      } as unknown as RuntimeNodeAttachDraft;
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={draftWithStaleSession} />);
      clickAttach();

      expect(controlPlaneCall).toHaveBeenCalledWith(
        "runtimenode.attach",
        expect.objectContaining({ sessionId: TARGET_SESSION_ID }),
      );
    });

    it("renders the pending state with no clickable control while in flight", () => {
      // The double-fire guard is STRUCTURAL: the pending branch renders no
      // button at all, so a second attach cannot be dispatched by clicking.
      const controlPlaneCall = vi.fn().mockReturnValue(new Promise(() => {}));
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      const pendingSection = screen.getByLabelText("runtime-node-attach-pending");
      expect(pendingSection.getAttribute("data-attach-state")).toBe("pending");
      expect(pendingSection.getAttribute("aria-busy")).toBe("true");
      expect(screen.queryByRole("button")).toBeNull();
      // The declaration stays visible while the attach is in flight.
      expect(screen.getByLabelText("attach-node-declaration")).toBeDefined();
    });
  });

  describe("resolved state", () => {
    it("renders the attachment receipt for a read-write admission", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      const resolvedSection = await screen.findByLabelText("runtime-node-attach-resolved");
      expect(resolvedSection.getAttribute("data-attach-state")).toBe("resolved");
      expect(resolvedSection.getAttribute("data-node-state")).toBe("online");
      expect(resolvedSection.getAttribute("data-read-only")).toBe("false");
      expect(
        screen.getByText(`attachment id: ${READ_WRITE_ATTACH_RESPONSE.attachmentId}`),
      ).toBeDefined();
      expect(
        screen.getByText(`attached at: ${READ_WRITE_ATTACH_RESPONSE.attachedAt}`),
      ).toBeDefined();
      expect(screen.getByText("access: read-write")).toBeDefined();
    });

    it("treats a below-floor read-only reply as an ADMISSION, not a refusal (AC4)", async () => {
      // I-003-1 admit-not-eject at the attach seam: the below-floor node lands
      // in `resolved` with a read-only access label — there is no error arm for
      // it, because it was not refused.
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_ONLY_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      const resolvedSection = await screen.findByLabelText("runtime-node-attach-resolved");
      expect(resolvedSection.getAttribute("data-read-only")).toBe("true");
      expect(screen.getByText("access: read-only (below version floor)")).toBeDefined();
      expect(screen.queryByLabelText("runtime-node-attach-error")).toBeNull();
    });
  });

  describe("rejected state", () => {
    it("surfaces a typed wire-error envelope with its code as the error name", async () => {
      const controlPlaneCall = vi.fn().mockRejectedValue({
        code: "runtimenode.permission_denied",
        message: "caller is not an active member of this session",
      });
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      const errorSection = await screen.findByRole("alert", {
        name: "runtime-node-attach-error",
      });
      expect(errorSection.getAttribute("data-attach-state")).toBe("rejected");
      expect(errorSection.textContent).toContain("runtimenode.permission_denied");
      expect(errorSection.textContent).toContain("caller is not an active member of this session");
      // The declaration survives the refusal — the operator can still see what
      // was being declared, and retry.
      expect(screen.getByLabelText("attach-node-declaration")).toBeDefined();
      expect(screen.getByRole("button", { name: "Retry attach" })).toBeDefined();
    });

    it("catches a bridge method that throws synchronously", async () => {
      // The Tier-1 bridge stub throws `NotImplementedAtTier1Error` SYNCHRONOUSLY
      // rather than returning a rejected promise; the view must land in its
      // error state instead of letting the throw escape the click handler.
      const controlPlaneCall = vi.fn(() => {
        throw new NotImplementedAtTier1Error("controlPlane.call");
      });
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      const errorSection = await screen.findByRole("alert", {
        name: "runtime-node-attach-error",
      });
      expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    });

    it("renders a non-object rejection through the string fallback", async () => {
      const controlPlaneCall = vi.fn().mockRejectedValue("bridge channel closed");
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      const errorSection = await screen.findByRole("alert", {
        name: "runtime-node-attach-error",
      });
      expect(errorSection.textContent).toContain("bridge channel closed");
    });

    it("re-issues the attach when the operator retries", async () => {
      const controlPlaneCall = vi
        .fn()
        .mockRejectedValueOnce(new Error("control plane unreachable"))
        .mockResolvedValueOnce(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();
      await screen.findByRole("alert", { name: "runtime-node-attach-error" });

      fireEvent.click(screen.getByRole("button", { name: "Retry attach" }));

      await screen.findByLabelText("runtime-node-attach-resolved");
      expect(controlPlaneCall).toHaveBeenCalledTimes(2);
      expect(controlPlaneCall).toHaveBeenLastCalledWith("runtimenode.attach", {
        ...ATTACH_DRAFT,
        sessionId: TARGET_SESSION_ID,
      });
    });
  });

  describe("attachment-target reset", () => {
    it("returns to idle when the target node changes", async () => {
      // A receipt belongs to ONE attachment target. Showing node A's
      // `attachmentId` while node B is selected would misreport which node is
      // attached.
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      const { rerender } = render(
        <AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />,
      );
      clickAttach();
      await screen.findByLabelText("runtime-node-attach-resolved");

      rerender(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={{ ...ATTACH_DRAFT, nodeId: OTHER_NODE_ID }}
        />,
      );

      expect(screen.getByLabelText("runtime-node-attach-idle")).toBeDefined();
      expect(
        screen.queryByText(`attachment id: ${READ_WRITE_ATTACH_RESPONSE.attachmentId}`),
      ).toBeNull();
      expect(screen.getByText(`node id: ${OTHER_NODE_ID}`)).toBeDefined();
    });

    it("returns to idle when the target session changes", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      const { rerender } = render(
        <AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />,
      );
      clickAttach();
      await screen.findByLabelText("runtime-node-attach-resolved");

      rerender(<AttachFlow sessionId={OTHER_SESSION_ID} attachDraft={ATTACH_DRAFT} />);

      expect(screen.getByLabelText("runtime-node-attach-idle")).toBeDefined();
      expect(screen.getByText(`target session: ${OTHER_SESSION_ID}`)).toBeDefined();
    });
  });

  describe("bridge-projection (CP-003-3)", () => {
    // Spec-023 §Trust Stance + Plan-003 CP-003-3, and BL-131 exit criterion (b)
    // ("assert bridge-only data access (no `node:*`/`electron` imports)"). The
    // `@ai-sidekicks/runtime-daemon` / `@ai-sidekicks/control-plane` arm has no
    // lint rule today (deferred to the Plan-023 Tier 8 remainder), so for that
    // arm this tripwire is the sole operational enforcement.
    //
    // All three patterns anchor on the IMPORT SURFACE, never on bare words:
    // this source spells "no `electron`, no `node:*`" in PROSE, which a naive
    // substring match would false-positive.
    const bannedModuleSource =
      "(?:@ai-sidekicks/(?:runtime-daemon|control-plane)(?:/[^\"'`]*)?" +
      "|[^\"'`]*packages/(?:runtime-daemon|control-plane)/[^\"'`]*" +
      "|node:[^\"'`]+" +
      "|(?:fs|path|os|net|child_process|process)" +
      "|electron(?:/[^\"'`]*)?)";

    const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp, string]> = [
      [
        "bannedFromImport",
        new RegExp(`from\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import { readFile } from "node:fs/promises";',
      ],
      [
        "bannedSideEffectImport",
        new RegExp(`import\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import "@ai-sidekicks/control-plane";',
      ],
      [
        "bannedDynamicImport",
        new RegExp(`import\\s*\\(\\s*["'\`]${bannedModuleSource}["'\`]`),
        'const daemon = await import("@ai-sidekicks/runtime-daemon");',
      ],
    ];

    const attachFlowSource = runtimeNodeViewSources["../AttachFlow.tsx"];
    if (typeof attachFlowSource !== "string") {
      throw new Error("AttachFlow.tsx source was not loaded by import.meta.glob");
    }

    // Negative control: a tripwire that has never fired positive proves nothing.
    it.each(bannedDirectImportPatterns)(
      "%s matches a synthetic violating import (negative control)",
      (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
        expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
      },
    );

    it.each(bannedDirectImportPatterns)(
      "AttachFlow.tsx source matches no %s",
      (_bannedImportPatternName, bannedImportPattern) => {
        expect(bannedImportPattern.test(attachFlowSource)).toBe(false);
      },
    );
  });
});
