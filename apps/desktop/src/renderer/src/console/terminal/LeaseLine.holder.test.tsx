// The holder line — every state 8.8 names, and the sentence each one renders.
//
// The lease STATE is a value here rather than a fold from a scenario, because
// `lease-model.test.ts` already holds the fold to the wire and this file's subject is
// what each state RENDERS. Its cast, its bridges, and its render call come from
// `LeaseLine.test-support.tsx`, which every suite in this split shares.
//
// The claim CALL is `LeaseLine.claim.test.tsx`, the disclosure is
// `LeaseLine.ledger.test.tsx`, and the two gates on the control — the viewer's
// identity and the caller's role — are `LeaseLine.viewer-identity.test.tsx` and
// `LeaseLine.role.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeaseLine, type TerminalParticipantMark } from "./LeaseLine.js";
import { TERMINAL_LEASE_HOLDINGS, UNREAD_TERMINAL_LEASE } from "./lease-model.js";
import {
  CALLER_ROLE_COLLABORATOR,
  HOLDER,
  SESSION_ID,
  VIEWER,
  VIEWER_IDENTITY_READ,
  leaseState,
  refusingBridge,
  renderLease,
} from "./LeaseLine.test-support.js";

describe("the holder line — every state 8.8 names", () => {
  it("says the lease has not been read, which is not the lease being free", () => {
    const { container } = renderLease(UNREAD_TERMINAL_LEASE);
    expect(container.textContent).toContain("Not checked");
    expect(container.textContent).toContain("The lease has not been read.");
    expect(container.textContent).not.toContain("Nobody holds the shell.");
  });

  it("renders a free lease as an explicit unheld state", () => {
    const { container } = renderLease(leaseState({ holding: "unheld", holderVouching: "vouched" }));
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Nobody holds the shell.");
  });

  it("names another holder by the wire id when the roster supplies no name", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-another",
        holderParticipantId: HOLDER,
        holderVouching: "vouched",
      }),
    );
    expect(container.textContent).toContain("Held by");
    expect(container.textContent).toContain(HOLDER);
    expect(container.querySelector(".meridian-lease-line__mark--dashed")).not.toBeNull();
  });

  it("uses the roster's name where there is one, rather than the id", () => {
    const named = (participantId: string): TerminalParticipantMark | undefined =>
      participantId === HOLDER
        ? { hueStep: 3, ringTreatment: "dashed", displayName: "Priya" }
        : undefined;
    const { container } = render(
      <LeaseLine
        bridge={refusingBridge()}
        sessionId={SESSION_ID}
        state={leaseState({
          holding: "held-by-another",
          holderParticipantId: HOLDER,
          holderVouching: "vouched",
        })}
        markFor={named}
        viewerIdentity={VIEWER_IDENTITY_READ}
        callerRole={CALLER_ROLE_COLLABORATOR}
      />,
    );
    expect(container.textContent).toContain("Priya holds the shell.");
    expect(container.textContent).not.toContain(HOLDER);
  });

  it("tells the holder they may type, and offers the handback rather than a claim", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-you",
        holderParticipantId: VIEWER,
        holderVouching: "vouched",
      }),
    );
    expect(container.textContent).toContain("You hold it");
    expect(container.textContent).toContain("You may type into the shared shell.");
    const claim = container.querySelector(".meridian-lease-line__claim");
    // The idempotent self-claim is not reachable from this surface, so there is no
    // transition for it to animate — 8.8's "never animates a claim by the current
    // holder", kept structurally rather than by suppressing an animation.
    expect(claim?.textContent).toBe("Release the shell");
  });

  it("reports an unread node roster rather than vouching for a holder it cannot check", () => {
    const { container } = renderLease(
      leaseState({ holding: "held-by-another", holderParticipantId: HOLDER }),
    );
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    expect(container.textContent).toContain("Node health not read");
    // The holder the health line is ABOUT. This case is also the control for the
    // two below: a gate that silenced the block for every state would satisfy both
    // of them and leave a real holder standing with no word about the node it sits
    // on, which is the one reading 8.8 spends this absence on.
    expect(container.textContent).toContain(HOLDER);
  });

  it("says nothing about a holding node's health when the line says the shell is free", () => {
    // What a `released`-terminated log with no roster read folds to: an explicit
    // free lease, and a vouching that records only that nothing was asked. The old
    // surface put "Node health not read" under "Nobody holds the shell." and so
    // discussed a holding node the same reading says does not exist.
    const { container } = renderLease(leaseState({ holding: "unheld" }));
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("Node health not read");
  });

  it("leaves an unread transition its own paragraph, without a second unread reading", () => {
    // The unread arm nulls the holder as well, so the same gate applies — and here
    // it is the difference between one sentence about what the console could not
    // read and two, the second about a roster nobody was waiting on.
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        unreadTransition: {
          sequence: 9,
          occurredAtIso: "2026-01-01T16:40:09.000Z",
          reason: "auto_released_quota_exhausted",
        },
      }),
    );
    expect(container.textContent).toContain("this build cannot read");
    expect(container.textContent).not.toContain("Node health not read");
  });

  it("degrades an offline holder to unheld and read-only, naming the node", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "unvouched",
        offlineNode: { nodeId: "node-lima", effect: "holder-collapsed" },
      }),
    );
    expect(container.textContent).toContain("node-lima");
    expect(container.textContent).toContain("reads as free and stays read-only");
    // The holder the control plane cannot vouch for is not shown as a holder.
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("Held by");
  });

  it("names an offline node without claiming a holder when the lease was already free", () => {
    // The finding. A `released` transition and then the sole node dropping put both
    // sentences on screen at once: "Nobody holds the shell." and "The holding node …
    // is offline", the second naming a holder the first says does not exist.
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "unvouched",
        offlineNode: { nodeId: "node-lima", effect: "no-holder-shown" },
      }),
    );
    expect(container.textContent).toContain("Nobody holds the shell.");
    // The host is still named, and why the shell is read-only is still said.
    expect(container.textContent).toContain("node-lima");
    expect(container.textContent).toContain("is offline, so the shell stays read-only here");
    expect(container.textContent).not.toContain("The holding node");
    expect(container.textContent).not.toContain("reads as free");
  });

  it("negative control: the two offline readings do not render the same sentence", () => {
    // Without it the case above would pass against a line that had dropped the
    // holder wording everywhere, including where an offline host really did take a
    // holder off the screen — which is the reading a person needs in order to know
    // somebody had the shell a moment ago.
    const collapsed = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "unvouched",
        offlineNode: { nodeId: "node-lima", effect: "holder-collapsed" },
      }),
    );
    const alreadyFree = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "unvouched",
        offlineNode: { nodeId: "node-lima", effect: "no-holder-shown" },
      }),
    );
    const degradedTextOf = (container: HTMLElement): string | null | undefined =>
      container.querySelector(".meridian-lease-line__degraded")?.textContent;
    expect(degradedTextOf(collapsed.container)).toBeDefined();
    expect(degradedTextOf(collapsed.container)).not.toBe(degradedTextOf(alreadyFree.container));
  });

  it("says the lease is unreadable when a transition arrived this build cannot read", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        holderVouching: "vouched",
        unreadTransition: {
          sequence: 9,
          occurredAtIso: "2026-01-01T16:40:09.000Z",
          reason: "auto_released_quota_exhausted",
        },
      }),
    );
    expect(container.textContent).toContain("Unread transition");
    expect(container.textContent).toContain("The console cannot read who holds the shell.");
    // The reason travels verbatim and in mono, because it is a wire string the
    // operator pastes into a search rather than prose this console wrote.
    expect(container.textContent).toContain("auto_released_quota_exhausted");
    // The two sentences that would be lies here: nobody said the lease is free, and
    // nobody said this participant may type.
    expect(container.textContent).not.toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("You may type into the shared shell.");
  });

  it("says it plainly when the unread transition named no reason at all", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        holderVouching: "vouched",
        unreadTransition: {
          sequence: 9,
          occurredAtIso: "2026-01-01T16:40:09.000Z",
          reason: undefined,
        },
      }),
    );
    expect(container.textContent).toContain("this build cannot read");
    // No dangling "The wire called it ." where there was nothing to name.
    expect(container.textContent).not.toContain("The wire called it");
  });

  it("negative control: every holding renders its own sentence", () => {
    // Counted off the closed set rather than written down, so a sixth holding added
    // without a sentence of its own fails here instead of quietly reading like one
    // of the five.
    const sentences = new Set(
      (
        [
          UNREAD_TERMINAL_LEASE,
          leaseState({ holding: "unheld", holderVouching: "vouched" }),
          leaseState({
            holding: "held-by-another",
            holderParticipantId: HOLDER,
            holderVouching: "vouched",
          }),
          leaseState({
            holding: "held-by-you",
            holderParticipantId: VIEWER,
            holderVouching: "vouched",
          }),
          leaseState({
            holding: "unrecognized-transition",
            holderVouching: "vouched",
            unreadTransition: {
              sequence: 9,
              occurredAtIso: "2026-01-01T16:40:09.000Z",
              reason: "auto_released_quota_exhausted",
            },
          }),
        ] as const
      ).map((state) => renderLease(state).container.textContent),
    );
    expect(sentences.size).toBe(TERMINAL_LEASE_HOLDINGS.length);
  });
});
