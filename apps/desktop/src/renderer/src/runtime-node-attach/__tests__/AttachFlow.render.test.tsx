// What the operator SEES on each of the attach flow's states.
//
// Split from the wire half on the seam `attach-request.ts` draws: this file drives the
// declaration block, the resolved receipt, and the attachment-target reset — what the
// view renders. What it SENDS and how a reply settles is
// `AttachFlow.request.test.tsx`, over the one cast in `attach-flow.test-support.ts`.
//
// Spec coverage:
//   • `Spec-003 §Acceptance Criteria` AC1 (a participant attaches a local runtime node
//     to an already-active session): the idle branch presents the prompt for the live
//     target session, and the declaration block renders on EVERY state — the operator
//     can always see what the node is declaring.
//   • `Spec-003 §Acceptance Criteria` AC4 and I-003-1 (admit-not-eject): the read-only
//     reply renders as a RESOLVED receipt with its read-only access label — an
//     admission, not an error state.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react` —
// see `ADR-022 §Decision Log` (2026-08-25).

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachFlow } from "../AttachFlow.js";
import {
  ATTACHING_NODE_ID,
  ATTACH_DRAFT,
  OTHER_NODE_ID,
  OTHER_SESSION_ID,
  READ_ONLY_ATTACH_RESPONSE,
  READ_WRITE_ATTACH_RESPONSE,
  TARGET_SESSION_ID,
  clickAttach,
  installMockBridge,
  removeMockBridge,
} from "./attach-flow.test-support.js";

describe("AttachFlow — what it renders", () => {
  afterEach(() => {
    removeMockBridge();
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

    // `Spec-003 §Acceptance Criteria` AC4.
    it("treats a below-floor read-only reply as an ADMISSION, not a refusal", async () => {
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
});
