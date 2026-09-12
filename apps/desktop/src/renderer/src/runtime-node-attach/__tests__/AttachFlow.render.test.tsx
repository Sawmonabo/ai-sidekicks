// What the operator SEES on each of the attach flow's states.
//
// Split from the wire half on the seam `attach-request.ts` draws: this file drives the
// declaration block, the resolved receipt, and the attachment-target reset — what the
// view renders. What it SENDS and how a reply settles is
// `AttachFlow.request.test.tsx`, over the one cast in `attach-flow.test-support.ts`.
//
// What the cases hold the view to:
//   • Attaching a local runtime node to an already-active session: the idle branch
//     presents the prompt for the live target session, and the declaration block
//     renders on EVERY state — the operator can always see what the node is
//     declaring.
//   • Admit, never eject: the read-only reply renders as a RESOLVED receipt with its
//     read-only access label — an admission, not an error state.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react`.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeNodeAttachResponse } from "@ai-sidekicks/contracts";

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
  createAttachTransport,
  installMockBridge,
  removeMockBridge,
} from "./attach-flow.test-support.js";
// The manually-resolvable promise, taken from the roster suite's scaffolding rather
// than written a second time here: `apps/desktop/AGENTS.md` gives one role one home,
// and holding a reply in flight while a prop moves is the same role in both suites.
import { createDeferred } from "./node-roster.test-support.js";

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

    it("treats a below-floor read-only reply as an ADMISSION, not a refusal", async () => {
      // Admit-not-eject at the attach seam: the below-floor node lands in
      // `resolved` with a read-only access label — there is no error arm for
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

  describe("transport re-addressing", () => {
    // The half a (session, node) comparison cannot see. The console's bridge provider
    // REPLACES its resolution for the same session and the same node without
    // remounting its children, so neither branded string moves and both facts on
    // screen become false at once: the receipt describes an attachment made over a
    // bridge this view has left, and a request the retired bridge is still carrying is
    // about that same departed address.
    it("returns to idle when the transport is replaced for the same target", async () => {
      const firstTransport = createAttachTransport(
        async () => await Promise.resolve(READ_WRITE_ATTACH_RESPONSE),
      );
      const replacementTransport = createAttachTransport(
        async () => await Promise.resolve(READ_ONLY_ATTACH_RESPONSE),
      );

      const { rerender } = render(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={ATTACH_DRAFT}
          reads={firstTransport.reads}
        />,
      );
      clickAttach();
      await screen.findByLabelText("runtime-node-attach-resolved");

      rerender(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={ATTACH_DRAFT}
          reads={replacementTransport.reads}
        />,
      );

      expect(screen.getByLabelText("runtime-node-attach-idle")).toBeDefined();
      expect(
        screen.queryByText(`attachment id: ${READ_WRITE_ATTACH_RESPONSE.attachmentId}`),
      ).toBeNull();
      // The replacement is not asked anything by the re-render itself: attach is a
      // click, and re-addressing must not perform one.
      expect(replacementTransport.attachNode).not.toHaveBeenCalled();
    });

    it("discards a settlement from the transport it has been replaced with", async () => {
      // The receipt is never rendered at all, which is the assertion: a late reply
      // from a retired bridge installs NOWHERE rather than briefly and then being
      // cleaned up. Nothing cancels the call — the seam offers no cancellation — so
      // the reply really does arrive; what changes is that it is published for an
      // address this view no longer holds.
      const heldAttach = createDeferred<RuntimeNodeAttachResponse>();
      const firstTransport = createAttachTransport(async () => await heldAttach.promise);
      const replacementTransport = createAttachTransport(
        async () => await Promise.resolve(READ_ONLY_ATTACH_RESPONSE),
      );

      const { rerender } = render(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={ATTACH_DRAFT}
          reads={firstTransport.reads}
        />,
      );
      clickAttach();
      expect(screen.getByLabelText("runtime-node-attach-pending")).toBeDefined();

      rerender(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={ATTACH_DRAFT}
          reads={replacementTransport.reads}
        />,
      );
      expect(screen.getByLabelText("runtime-node-attach-idle")).toBeDefined();

      await act(async () => {
        heldAttach.resolve(READ_WRITE_ATTACH_RESPONSE);
        await heldAttach.promise;
      });

      expect(screen.getByLabelText("runtime-node-attach-idle")).toBeDefined();
      expect(screen.queryByLabelText("runtime-node-attach-resolved")).toBeNull();
      expect(
        screen.queryByText(`attachment id: ${READ_WRITE_ATTACH_RESPONSE.attachmentId}`),
      ).toBeNull();
    });

    it("keeps the receipt while the transport object is the same one", async () => {
      // The negative half of the rule, and what keeps the two cases above from
      // passing under a view that simply reset on every render: an unchanged
      // transport re-rendered is the SAME address, so the receipt stands.
      const transport = createAttachTransport(
        async () => await Promise.resolve(READ_WRITE_ATTACH_RESPONSE),
      );

      const { rerender } = render(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={ATTACH_DRAFT}
          reads={transport.reads}
        />,
      );
      clickAttach();
      await screen.findByLabelText("runtime-node-attach-resolved");

      rerender(
        <AttachFlow
          sessionId={TARGET_SESSION_ID}
          attachDraft={ATTACH_DRAFT}
          reads={transport.reads}
        />,
      );

      expect(screen.getByLabelText("runtime-node-attach-resolved")).toBeDefined();
      expect(
        screen.getByText(`attachment id: ${READ_WRITE_ATTACH_RESPONSE.attachmentId}`),
      ).toBeDefined();
    });
  });
});
