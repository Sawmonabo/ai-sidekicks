// Who is offered the shell, and who is told why they are not.
//
// The defect this fold replaces is the quiet kind: the control rendered for anybody
// whose identity had been read, so a viewer pressed "Claim the shell" and got
// `pty.permission_denied` back — an offer the daemon exists to refuse. Every case
// below is one participant, one holding, and the single control the surface may draw.

import { describe, expect, it } from "vitest";
import type { MembershipRole } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { CallerMembershipRoleResult } from "../store/index.js";
import { resolveTerminalClaimAffordance } from "./lease-acquisition.js";
import type { TerminalLeaseHolding } from "./lease-model.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";

const VIEWER = "participant-viewer";

const IDENTITY_READ: TerminalViewerIdentity = { status: "read", participantId: VIEWER };
const READ_REFUSAL: ConsoleRefusal = refuse("terminal-viewer-identity", "wire-unregistered", "No.");

function roleRead(role: MembershipRole): CallerMembershipRoleResult {
  return { status: "read", participantId: VIEWER, role };
}

function resolve(
  holding: TerminalLeaseHolding,
  viewerIdentity: TerminalViewerIdentity,
  callerRole: CallerMembershipRoleResult,
) {
  return resolveTerminalClaimAffordance({ holding, viewerIdentity, callerRole });
}

describe("the acquisition control is offered by role", () => {
  it("offers it to an owner and to a collaborator", () => {
    for (const role of ["owner", "collaborator"] satisfies readonly MembershipRole[]) {
      expect(resolve("unheld", IDENTITY_READ, roleRead(role))).toStrictEqual({
        control: "acquire",
      });
    }
  });

  it("withholds it from a viewer and from a runtime contributor, with the reason", () => {
    // Both can only be answered `pty.permission_denied`, and a control whose only
    // answer is a refusal is neither an offer nor a refusal.
    for (const role of ["viewer", "runtime contributor"] satisfies readonly MembershipRole[]) {
      expect(resolve("unheld", IDENTITY_READ, roleRead(role))).toStrictEqual({
        control: "none",
        withheld: { reason: "role-cannot-acquire", role },
      });
    }
  });

  it("withholds it while the role read is still out", () => {
    expect(resolve("unheld", IDENTITY_READ, { status: "not-loaded" })).toStrictEqual({
      control: "none",
      withheld: { reason: "role-not-read" },
    });
  });

  it("withholds it when the role read was refused, carrying the wire's own refusal", () => {
    expect(
      resolve("unheld", IDENTITY_READ, { status: "refused", refusal: READ_REFUSAL }),
    ).toStrictEqual({
      control: "none",
      withheld: { reason: "role-refused", refusal: READ_REFUSAL },
    });
  });

  it("tells an unread role from a role that may not claim", () => {
    // Two different facts under rule 8: the roster naming no role for this
    // participant is nobody having asked, not a refusal to let them claim.
    expect(
      resolve("unheld", IDENTITY_READ, { status: "read", participantId: VIEWER, role: undefined }),
    ).toStrictEqual({ control: "none", withheld: { reason: "role-unread-in-roster" } });
  });

  it("asks for the identity first, because the role alone cannot attribute a take", () => {
    expect(resolve("unheld", { status: "not-loaded" }, roleRead("owner"))).toStrictEqual({
      control: "none",
      withheld: { reason: "identity-not-read" },
    });
    expect(
      resolve("unheld", { status: "refused", refusal: READ_REFUSAL }, roleRead("owner")),
    ).toStrictEqual({
      control: "none",
      withheld: { reason: "identity-refused", refusal: READ_REFUSAL },
    });
  });
});

describe("release is not gated with acquisition", () => {
  it("keeps the handback for a holder whose role has dropped", () => {
    // Authorization loss reaches this pane as an event, and the shell is held until a
    // transition says otherwise. Taking the release control away in that interval
    // strands the keyboard on a participant with no way to hand it back.
    expect(resolve("held-by-you", IDENTITY_READ, roleRead("viewer"))).toStrictEqual({
      control: "release",
    });
  });

  it("keeps it even while the role read is out or refused", () => {
    expect(resolve("held-by-you", IDENTITY_READ, { status: "not-loaded" })).toStrictEqual({
      control: "release",
    });
    expect(
      resolve("held-by-you", IDENTITY_READ, { status: "refused", refusal: READ_REFUSAL }),
    ).toStrictEqual({ control: "release" });
  });

  it("negative control: a holding that is not the viewer's is not a release", () => {
    // Without it every case above would pass against a fold that answered `release`
    // for everything, which offers a handback for a shell the person does not hold.
    expect(resolve("held-by-another", IDENTITY_READ, roleRead("collaborator"))).toStrictEqual({
      control: "acquire",
    });
  });
});
