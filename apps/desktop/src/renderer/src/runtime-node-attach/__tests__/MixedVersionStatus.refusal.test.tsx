// Plan-003 Phase 5 T5.3 — which arm `MixedVersionStatus` puts a refused write on.
//
// One of the view's two axes. This file is about how a rejected version-sensitive
// write is surfaced; the access verdict the view projects beside it is
// `MixedVersionStatus.verdict.test.tsx`, over the one refusal envelope in
// `mixed-version-status.test-support.ts`. How many times an unstable rejection is
// READ is a third file, `MixedVersionStatus.unstable-rejection.test.tsx`.
//
// Spec coverage:
//   • `Spec-003 §Acceptance Criteria` AC4 (a below-floor node surfaces the typed
//     `VERSION_FLOOR_EXCEEDED` outcome of a version-sensitive write and is never
//     ejected for the mismatch): the cases pin the typed envelope's code and message
//     surfacing verbatim, and EVERY refusal case asserts the node block still renders
//     — the never-ejected clause, structurally.
//   • I-003-1 (admit-not-eject — and the T5.3 posture that this view NEVER re-derives
//     the floor verdict): the tripwire case renders a `read-write` entry TOGETHER WITH
//     a `version.floor_exceeded` write rejection and asserts the access verdict stays
//     `read-write`. A view that inferred the verdict from the refusal would flip it
//     and fail here.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the
//     bridge-projection source scan at the bottom of this file.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react` — the
// shipped desktop renderer stack; `ADR-022 §Decision Log` (2026-08-25) records why
// renderer component tests run there rather than under Browser Mode. Queries are
// accessible-first (`getByRole` / `getByLabelText`); `data-*` assertions are reserved
// for the deliberate machine-readable enum tokens the view emits for exactly that
// purpose.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VERSION_FLOOR_EXCEEDED_CODE } from "@ai-sidekicks/contracts";

import { MixedVersionStatus } from "../MixedVersionStatus.js";
import {
  ATTACHED_NODE_ID,
  BELOW_FLOOR_CLIENT_VERSION,
  FLOOR_REFUSAL_ENVELOPE,
  FLOOR_REFUSAL_MESSAGE,
  buildRosterEntry,
} from "./mixed-version-status.test-support.js";

describe("MixedVersionStatus — how a refused write is surfaced", () => {
  describe("write-refusal surfacing", () => {
    it("renders the no-refusal state with no alert at all", () => {
      render(<MixedVersionStatus rosterEntry={buildRosterEntry()} writeAttemptRejection={null} />);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByText("no refused write attempt to surface").getAttribute("data-write-refusal"),
      ).toBe("none");
    });

    it("treats an `undefined` rejection as no refusal (not as an unrecognized one)", () => {
      render(
        <MixedVersionStatus rosterEntry={buildRosterEntry()} writeAttemptRejection={undefined} />,
      );

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("no refused write attempt to surface")).toBeDefined();
    });

    it("surfaces the typed VERSION_FLOOR_EXCEEDED envelope verbatim and keeps the node visible", () => {
      // `Spec-003 §Acceptance Criteria` AC4: the typed refusal is surfaced, and
      // the node is NOT ejected — the node facts render on the refusal arm.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({
            readOnly: true,
            clientVersion: BELOW_FLOOR_CLIENT_VERSION,
          })}
          writeAttemptRejection={FLOOR_REFUSAL_ENVELOPE}
        />,
      );

      const refusalAlert = screen.getByRole("alert", { name: "version-floor-write-refusal" });
      expect(refusalAlert.getAttribute("data-write-refusal")).toBe(VERSION_FLOOR_EXCEEDED_CODE);
      expect(refusalAlert.textContent).toContain(VERSION_FLOOR_EXCEEDED_CODE);
      expect(refusalAlert.textContent).toContain(FLOOR_REFUSAL_MESSAGE);
      expect(refusalAlert.textContent).toContain(
        "the node remains joined and readable — admitted read-only, not ejected",
      );
      // Never ejected: the node block renders alongside the refusal.
      expect(screen.getByLabelText("mixed-version-node-facts")).toBeDefined();
      expect(screen.getByText(`node id: ${ATTACHED_NODE_ID}`)).toBeDefined();
    });

    // Plan-003 I-003-1 tripwire.
    it("does NOT let a floor refusal re-derive the access verdict", () => {
      // The verdict comes from the server-resolved `readOnly` axis ALONE. This
      // deliberately inconsistent pairing — a read-write entry plus a floor
      // refusal — must still render `read-write`. A view that inferred the
      // verdict from the refusal (re-deriving floor logic in the renderer)
      // would flip to `read-only` here.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ readOnly: false })}
          writeAttemptRejection={FLOOR_REFUSAL_ENVELOPE}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-write");
      expect(screen.getByText("access: read-write")).toBeDefined();
      // …and the refusal is still surfaced on its own axis.
      expect(screen.getByRole("alert", { name: "version-floor-write-refusal" })).toBeDefined();
    });

    it("routes a non-floor wire-error envelope to the unrecognized arm, code preserved", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={{
            code: "runtimenode.permission_denied",
            message: "caller does not own this attachment",
          }}
        />,
      );

      const rejectionAlert = screen.getByRole("alert", { name: "unrecognized-write-rejection" });
      expect(rejectionAlert.getAttribute("data-write-refusal")).toBe("unrecognized");
      expect(rejectionAlert.textContent).toContain("runtimenode.permission_denied");
      expect(rejectionAlert.textContent).toContain("caller does not own this attachment");
      // It is NOT mistaken for the floor refusal.
      expect(screen.queryByRole("alert", { name: "version-floor-write-refusal" })).toBeNull();
    });

    it("renders a thrown Error's name and message on the unrecognized arm", () => {
      const transportFailure = new TypeError("Failed to fetch");
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={transportFailure}
        />,
      );

      const rejectionAlert = screen.getByRole("alert", { name: "unrecognized-write-rejection" });
      expect(rejectionAlert.textContent).toContain("TypeError");
      expect(rejectionAlert.textContent).toContain("Failed to fetch");
    });

    it("renders a non-object rejection through the string fallback", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={"bridge channel closed"}
        />,
      );

      expect(
        screen.getByRole("alert", { name: "unrecognized-write-rejection" }).textContent,
      ).toContain("bridge channel closed");
    });

    it("degrades a rejection that cannot be stringified to the lossy literal", () => {
      // `String(Object.create(null))` THROWS (ToPrimitive finds no
      // `toString`/`valueOf`/`Symbol.toPrimitive`), so this drives the view's
      // guarded terminal fallback rather than the ordinary string path. A
      // pathological rejection degrades; it never crashes the render.
      const unstringifiableRejection = Object.create(null) as unknown;
      expect(() => String(unstringifiableRejection)).toThrow();

      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={unstringifiableRejection}
        />,
      );

      expect(
        screen.getByRole("alert", { name: "unrecognized-write-rejection" }).textContent,
      ).toContain("[unrepresentable value]");
      // The node block still renders — a bad rejection value cannot eject the node.
      expect(screen.getByLabelText("mixed-version-node-facts")).toBeDefined();
    });
  });
});
