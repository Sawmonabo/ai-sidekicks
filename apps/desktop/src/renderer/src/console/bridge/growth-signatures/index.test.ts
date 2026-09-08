// The composition itself: that twelve plane modules still add up to one closed table.
//
// The single file this directory replaced defended its length by arguing that
// splitting it would split one closed set across two files, so a member landing in
// neither half would become silently absent. Composition by interface EXTENSION is
// what makes that false — one interface, whose `keyof` is the whole id set — and this
// file is where that claim is checked rather than asserted in a header comment.
//
// WHAT THESE CASES CAN AND CANNOT PROVE. Every assertion here is a compile-time one:
// `expectTypeOf` erases at runtime, so a green run means the file TYPECHECKED, which
// is exactly the property at stake. The negative control is therefore the load-bearing
// case — it plants one plane's key set against the whole id union and proves the
// equality assertion above it can fail, so the census is a check rather than a
// tautology.

import { describe, expectTypeOf, it } from "vitest";

import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import type { GrowthOperationSignatures } from "./index.js";
import type { PaneGrowthSignatures } from "./panes.js";

describe("the growth signature table — composed from planes, closed as one set", () => {
  it("names exactly the operation ids, no plane's rows lost in the composition", () => {
    // The property `growth-port.ts` depends on: it maps over `GrowthOperationId` and
    // indexes this type per id, so an id with no member is a compile error there. This
    // states the same set equality here, where the composition is.
    expectTypeOf<keyof GrowthOperationSignatures>().toEqualTypeOf<GrowthOperationId>();
  });

  it("negative control: one plane's keys are not the set", () => {
    // Without this, the case above would pass for a `keyof` of anything the compiler
    // happened to widen — this proves the comparison discriminates.
    expectTypeOf<keyof PaneGrowthSignatures>().not.toEqualTypeOf<GrowthOperationId>();
  });

  it("carries each plane's rows through with their own request and value shapes", () => {
    // One row per plane module, in the order `index.ts` extends them. A plane dropped
    // from that list stops compiling here, and says which one.
    expectTypeOf<GrowthOperationSignatures["browserReload"]["request"]>().toEqualTypeOf<{
      readonly paneId: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["sessionArchive"]["request"]>().toEqualTypeOf<{
      readonly sessionId: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["gitActionExecute"]["value"]>().toEqualTypeOf<{
      readonly success: boolean;
      readonly output?: string;
      readonly error?: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["artifactIngestAbort"]["value"]>().toEqualTypeOf<void>();
    expectTypeOf<GrowthOperationSignatures["attentionPreferenceUpdate"]["value"]>().toEqualTypeOf<{
      readonly updatedAt: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["workflowRunRead"]["request"]>().toEqualTypeOf<{
      readonly workflowRunId: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["callerParticipantRead"]["value"]>().toEqualTypeOf<{
      readonly participantId: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["agentList"]["request"]>().toEqualTypeOf<{
      readonly sessionId: string;
    }>();
    expectTypeOf<GrowthOperationSignatures["approvalRuleList"]["request"]>().toEqualTypeOf<{
      readonly sessionId: string;
      readonly includeRevoked: boolean;
    }>();
    expectTypeOf<GrowthOperationSignatures["sidekickDefinitionDelete"]["value"]>().toEqualTypeOf<{
      readonly deleted: true;
    }>();
    expectTypeOf<GrowthOperationSignatures["agentDetach"]["value"]>().toEqualTypeOf<void>();
    expectTypeOf<GrowthOperationSignatures["orchestrationBudgetRead"]["request"]>().toEqualTypeOf<{
      readonly sessionId: string;
    }>();
  });
});
