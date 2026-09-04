// What a scope group is allowed to say about itself, given one read state.
//
// The rule is a pure function of the directory, so it is asserted as one: a case that
// drove it through a rendered surface would be checking the rule and the rendering at
// once, and the rendering has its own suite in `DefinitionsBrowser.scopes.test.tsx`.
//
// The claim under all of it: an empty scope is an ANSWER only when the enumeration is
// exhausted. A first page carrying a cursor and no row for a scope establishes nothing
// about that scope, because the cursor pages the whole resolved union at once.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../bridge/growth-port.js";
import { WORKFLOW_DEFINITION_SCOPES } from "./DefinitionsBrowser.js";
import {
  scopeResolutionOf,
  type WorkflowDefinitionContinuation,
  type WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";

const SECOND_PAGE_CURSOR = "definitions-page-2";

/** A served directory holding no rows at all, so only the continuation decides. */
function servedWith(
  continuation: WorkflowDefinitionContinuation,
): WorkflowDefinitionDirectoryState {
  return { status: "served", definitions: [], continuation };
}

describe("scopeResolutionOf — an empty scope is an answer only once the read is finished", () => {
  it("leaves every scope unresolved while the daemon still holds a cursor", () => {
    // The defect: this state rendered `No <scope> definitions` under all three groups,
    // which asserts a result about a daemon that had said there was more to come.
    expect(
      scopeResolutionOf(servedWith({ status: "available", cursor: SECOND_PAGE_CURSOR })),
    ).toStrictEqual({ pendingScopes: undefined, hasUnreadPages: true });
  });

  it("leaves every scope unresolved after a continuation was refused", () => {
    // The rows held were served and are still true; the pages beyond them are still
    // unread. The refusal itself is the whole surface's and is rendered once, under the
    // groups — never as three empty results about three scopes.
    expect(
      scopeResolutionOf(
        servedWith({
          status: "unavailable",
          cursor: SECOND_PAGE_CURSOR,
          refusal: growthUnavailable("workflowDefinitionList"),
        }),
      ),
    ).toStrictEqual({ pendingScopes: undefined, hasUnreadPages: true });
  });

  it("reads as a wait on every scope while a continuation is in flight", () => {
    // One read serves all three scopes, so a wait genuinely does belong to all three —
    // which is the axis on which a refusal differs, and why only one of them
    // distributes.
    expect(
      scopeResolutionOf(servedWith({ status: "reading", cursor: SECOND_PAGE_CURSOR })),
    ).toStrictEqual({ pendingScopes: WORKFLOW_DEFINITION_SCOPES, hasUnreadPages: true });
  });

  it("reads as a wait on every scope while the first page is in flight", () => {
    expect(scopeResolutionOf({ status: "reading" })).toStrictEqual({
      pendingScopes: WORKFLOW_DEFINITION_SCOPES,
      hasUnreadPages: true,
    });
  });

  it("negative control: an exhausted enumeration resolves every scope", () => {
    // Without this, every case above passes for a projection that never resolves
    // anything — and a console that has read the whole enumeration could then never
    // say a scope is empty, which is a real answer it is entitled to give.
    expect(scopeResolutionOf(servedWith({ status: "exhausted" }))).toStrictEqual({
      pendingScopes: undefined,
      hasUnreadPages: false,
    });
  });

  it("resolves every scope when the first page itself was refused", () => {
    // The groups are not rendered at all under a refused enumeration — the chrome draws
    // the daemon's sentence in their place — so what this answers reaches no surface.
    // It is asserted anyway because the projection is total, and a value nothing renders
    // today is exactly the one a later caller reads without checking.
    expect(
      scopeResolutionOf({
        status: "unavailable",
        refusal: growthUnavailable("workflowDefinitionList"),
      }),
    ).toStrictEqual({ pendingScopes: undefined, hasUnreadPages: false });
  });

  it("negative control: a read nobody could put resolves every scope", () => {
    // The bare rail address names no session, so nothing was asked and there are no
    // unread pages. The browser's three named groups there are the design's own empty
    // state rather than a claim about a read, and this keeps them that way.
    expect(scopeResolutionOf({ status: "unasked" })).toStrictEqual({
      pendingScopes: undefined,
      hasUnreadPages: false,
    });
  });
});
