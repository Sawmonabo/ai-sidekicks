// What the attach flow SENDS, and what it settles to — the wire half of the suite.
//
// Split from the render half on the seam `attach-request.ts` draws: this file drives
// the composed request, the four settlement paths a bridge reply can take, and the
// CP-003-3 source tripwire over both of the view's modules. What the operator SEES on
// each of those states is `AttachFlow.render.test.tsx`, over the one cast in
// `attach-flow.test-support.ts`.
//
// Spec coverage:
//   • `Spec-003 §Required Behavior` (attach carries node identity, declared
//     capabilities, health, and trust context): the composed-payload case asserts the
//     exact `runtimenode.attach` input the view sends.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the view
//     reaches the control plane ONLY through `window.sidekicks` (the mock bridge IS
//     that seam), and the source scan at the bottom of this file.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react` —
// see `ADR-022 §Decision Log` (2026-08-25).

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";

import { AttachFlow } from "../AttachFlow.js";
import type { RuntimeNodeAttachDraft } from "../attach-request.js";
import {
  ATTACH_DRAFT,
  OTHER_SESSION_ID,
  READ_WRITE_ATTACH_RESPONSE,
  TARGET_SESSION_ID,
  clickAttach,
  installMockBridge,
  removeMockBridge,
} from "./attach-flow.test-support.js";
import {
  BANNED_DIRECT_IMPORT_PATTERNS,
  runtimeNodeSourceNamed,
} from "./runtime-node-source.test-support.js";

describe("AttachFlow — the request it sends and how it settles", () => {
  afterEach(() => {
    removeMockBridge();
    vi.clearAllMocks();
  });

  describe("attach request", () => {
    it("sends the draft composed with the session prop as the attach input", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      expect(controlPlaneCall).toHaveBeenCalledTimes(1);
      expect(controlPlaneCall).toHaveBeenCalledWith("runtimenode.attach", {
        ...ATTACH_DRAFT,
        sessionId: TARGET_SESSION_ID,
      });
      // The mocked reply resolves, so the view transitions out of `pending`
      // after this body would otherwise end. Awaiting the settled arm keeps
      // that update inside act and asserts the dispatch actually completes.
      await screen.findByLabelText("runtime-node-attach-resolved");
    });

    it("lets the session PROP win over a stale sessionId carried on the draft", async () => {
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
      // The mocked reply resolves, so the view transitions out of `pending`
      // after this body would otherwise end. Awaiting the settled arm keeps
      // that update inside act and asserts the dispatch actually completes.
      await screen.findByLabelText("runtime-node-attach-resolved");
    });

    // Plan-003 I-003-3: attach couples no membership mutation to itself.
    it("issues the attach call ALONE, coupling no membership mutation to it", async () => {
      // Attach and membership acceptance are distinct actions. The renderer
      // leg of that invariant is that attaching reaches the control plane
      // EXACTLY once, on the attach procedure — a surface that also mutated
      // `session_memberships` would have to make a second call from here, and
      // the call-count assertion is what forbids it.
      const controlPlaneCall = vi.fn().mockResolvedValue(READ_WRITE_ATTACH_RESPONSE);
      installMockBridge(controlPlaneCall);

      render(<AttachFlow sessionId={TARGET_SESSION_ID} attachDraft={ATTACH_DRAFT} />);
      clickAttach();

      // The count is asserted only AFTER the attach settles. The violation this
      // forbids — a coupled membership mutation — would most plausibly be
      // chained off attach success, so a count taken while the promise is
      // still pending would be blind to exactly the shape it exists to catch.
      await screen.findByLabelText("runtime-node-attach-resolved");
      expect(controlPlaneCall.mock.calls).toHaveLength(1);
      expect(controlPlaneCall).toHaveBeenCalledWith("runtimenode.attach", expect.anything());
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

  describe("bridge-projection", () => {
    // Spec-023 §Trust Stance + Plan-003 CP-003-3, and BL-131 exit criterion (b)
    // ("assert bridge-only data access (no `node:*`/`electron` imports)"). The
    // `@ai-sidekicks/runtime-daemon` / `@ai-sidekicks/control-plane` arm has no
    // lint rule today (deferred to the Plan-023 Tier 8 remainder), so for that
    // arm this tripwire is the sole operational enforcement.
    //
    // The pattern table and the glob are `runtime-node-source.test-support.ts`'s —
    // both view suites had a verbatim copy. What stays here is WHICH modules the
    // claim is about, and it is BOTH halves of this view: the rendering and the wire
    // module the request moved to, so a banned import in the module that performs the
    // call is caught by the surface that names the call.
    const attachFlowSources = ["../AttachFlow.tsx", "../attach-request.ts"].map(
      runtimeNodeSourceNamed,
    );

    // Negative control: a tripwire that has never fired positive proves nothing.
    it.each(BANNED_DIRECT_IMPORT_PATTERNS)(
      "%s matches a synthetic violating import (negative control)",
      (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
        expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
      },
    );

    it.each(BANNED_DIRECT_IMPORT_PATTERNS)(
      "the attach flow's own modules match no %s",
      (_bannedImportPatternName, bannedImportPattern) => {
        for (const source of attachFlowSources) {
          expect(bannedImportPattern.test(source)).toBe(false);
        }
      },
    );
  });
});
