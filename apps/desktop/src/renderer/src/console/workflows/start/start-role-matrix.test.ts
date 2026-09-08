// The denial's role matrix, held against the contract that declares the roles.
//
// THE CLAIM IS THAT THERE IS NO SECOND VOCABULARY. `MembershipRole` in the contracts
// package is where the session roles are declared, and the matrix is now a mapping that
// is TOTAL over that union — so a role the contract gains, renames, or drops fails to
// compile in `start-role-matrix.ts` rather than leaving a denial surface explaining a
// rule with a row missing from it.
//
// WHICH IS WHY THE FIRST CASE IS AN ASSIGNMENT. Completeness against the contract is
// carried by the COMPILER here, and the assignment is that guarantee made visible in a
// suite: it typechecks only while a row's `role` is `MembershipRole`, so a matrix that
// went back to `role: string` fails the typecheck rather than passing every case.
//
// THE ENUM'S RUNTIME OPTIONS ARE DELIBERATELY NOT READ. `MembershipRoleSchema` would
// give this file the contract's list at runtime, and the console's contracts-schema
// chokepoint refuses a `*Schema` binding outside `bridge/**` — a surface never holds a
// parser. The total record is the stronger half of that comparison anyway: a list read
// at runtime reports a drift after the build, and the record refuses to build.

import type { MembershipRole } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { WORKFLOW_START_DENIED_CODE, WORKFLOW_START_ROLE_MATRIX } from "./start-role-matrix.js";

describe("the workflow-start role matrix", () => {
  it("carries the contract's union on every row rather than a bare string", () => {
    // The assignment IS the assertion, and it is the half no runtime check can make:
    // it holds only while `WorkflowStartRoleRow["role"]` is `MembershipRole`, which is
    // what stops a spelling drifting out of the contract while every case still passes.
    const roles: readonly MembershipRole[] = WORKFLOW_START_ROLE_MATRIX.map((row) => row.role);

    expect(roles.length).toBeGreaterThan(0);
  });

  it("states each role once, so no row answers for another", () => {
    const roles = WORKFLOW_START_ROLE_MATRIX.map((row) => row.role);

    expect(new Set(roles).size).toBe(roles.length);
  });

  it("names owner and collaborator as the two that may start", () => {
    expect(
      WORKFLOW_START_ROLE_MATRIX.filter((row) => row.mayStart).map((row) => row.role),
    ).toStrictEqual(["owner", "collaborator"]);
  });

  it("orders the rows so the boundary between them is one line", () => {
    // The order is the reading: the two who may start come first, so a person meeting a
    // denial reads the boundary rather than scanning for it.
    expect(WORKFLOW_START_ROLE_MATRIX.map((row) => row.mayStart)).toStrictEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("negative control: a role the contract does not declare is in no row", () => {
    // Without this the cases above would be satisfied by a matrix that had grown a row
    // for somebody nobody can be — a vocabulary of its own, which is what deriving the
    // mapping from the contract exists to rule out.
    expect(WORKFLOW_START_ROLE_MATRIX.map((row) => String(row.role))).not.toContain("moderator");
  });

  it("refuses on the daemon's own code, which two surfaces compare against", () => {
    expect(WORKFLOW_START_DENIED_CODE).toBe("workflow.start_denied");
  });
});
