// Plan-003 Phase 5 T5.3 — what access verdict `MixedVersionStatus` renders.
//
// One of the view's two axes. This file is about the verdict the SERVER resolved and
// this view only projects; which arm a refused write lands on is
// `MixedVersionStatus.refusal.test.tsx`, over the one entry builder in
// `mixed-version-status.test-support.ts`.
//
// Spec coverage:
//   • `Spec-003 §Acceptance Criteria` AC4 (a below-floor node is admitted in a
//     read-only state and is never ejected for the mismatch): the cases pin the
//     read-only label to the server-resolved `readOnly` axis alone, across every node
//     state that carries one.
//   • I-003-1 (admit-not-eject): a below-floor node renders as an ADMITTED entry with
//     a read-only label, never as an error or an absence.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react` — the
// shipped desktop renderer stack; `ADR-022 §Decision Log` (2026-08-25) records why
// renderer component tests run there rather than under Browser Mode. Queries are
// accessible-first (`getByRole` / `getByLabelText`); `data-*` assertions are reserved
// for the deliberate machine-readable enum tokens the view emits for exactly that
// purpose.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MixedVersionStatus } from "../MixedVersionStatus.js";
import {
  BELOW_FLOOR_CLIENT_VERSION,
  buildRosterEntry,
} from "./mixed-version-status.test-support.js";

describe("MixedVersionStatus — the access verdict it projects", () => {
  describe("access verdict (server-resolved, never re-derived)", () => {
    it("renders the below-floor read-only verdict off the wire `readOnly` axis", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({
            readOnly: true,
            clientVersion: BELOW_FLOOR_CLIENT_VERSION,
          })}
          writeAttemptRejection={null}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-only");
      expect(statusSection.getAttribute("data-read-only")).toBe("true");
      expect(screen.getByText("access: read-only (below version floor)")).toBeDefined();
      // The node stays visible and its declared version is legible — the
      // below-floor node is annotated, not hidden.
      expect(
        screen.getByText(`declared client version: ${BELOW_FLOOR_CLIENT_VERSION}`),
      ).toBeDefined();
    });

    it("renders the at-floor read-write verdict", () => {
      render(<MixedVersionStatus rosterEntry={buildRosterEntry()} writeAttemptRejection={null} />);

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-write");
      expect(statusSection.getAttribute("data-read-only")).toBe("false");
      expect(screen.getByText("access: read-write")).toBeDefined();
    });

    it("resolves the read-only verdict on the `registering` node state too", () => {
      // `registering` shares the floor-sensitive arm with `online`/`degraded`:
      // a node still registering below the floor is already read-only.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({
            state: "registering",
            healthState: null,
            readOnly: true,
          })}
          writeAttemptRejection={null}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-only");
      expect(statusSection.getAttribute("data-node-state")).toBe("registering");
    });

    it("keeps a `degraded` node read-write when it is at the floor", () => {
      // Liveness (`degraded`) and authority (`readOnly`) are ORTHOGONAL axes:
      // a degraded node at the floor still writes.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ state: "degraded", healthState: "degraded" })}
          writeAttemptRejection={null}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-write");
      expect(statusSection.getAttribute("data-node-state")).toBe("degraded");
    });

    it("renders `detached` for an offline node", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ state: "offline", healthState: "offline" })}
          writeAttemptRejection={null}
        />,
      );

      expect(screen.getByLabelText("mixed-version-status").getAttribute("data-access-status")).toBe(
        "detached",
      );
      expect(screen.getByText("access: detached (no active attachment)")).toBeDefined();
    });

    it("renders `revoked` for a revoked node, distinct from plain detachment", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ state: "revoked", healthState: null })}
          writeAttemptRejection={null}
        />,
      );

      expect(screen.getByLabelText("mixed-version-status").getAttribute("data-access-status")).toBe(
        "revoked",
      );
      expect(
        screen.getByText("access: revoked (authority-issued; re-attach is refused)"),
      ).toBeDefined();
    });

    it("renders `detached` with no node facts when there is no roster entry", () => {
      render(<MixedVersionStatus rosterEntry={null} writeAttemptRejection={null} />);

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("detached");
      // No entry means no state and no authority axis to project — both
      // attributes are absent rather than guessed.
      expect(statusSection.getAttribute("data-node-state")).toBeNull();
      expect(statusSection.getAttribute("data-read-only")).toBeNull();
      expect(screen.queryByLabelText("mixed-version-node-facts")).toBeNull();
      expect(
        screen.getByText("node: no roster entry (not attached to this session)"),
      ).toBeDefined();
    });
  });
});
