// The named values growth-port replies are made of.
//
// One interface per shape a served operation answers with, plus the one closed
// vocabulary those shapes read from. They are the CONSOLE's, derived from what its
// surfaces render — not a claim about the eventual wire shape, which belongs to the
// document named on the operation's slate row.
//
// WHY THEY ARE NOT IN THE SIGNATURE TABLE. Most request and reply shapes ARE stated
// inline next door in `growth-signatures/`, and that is the default: a shape read
// once at one call site earns no name. A shape lands here when it has a second
// reader — `GrowthSessionSummary` is one the fixture port constructs and the family
// barrel publishes — or when naming it is what lets two operations answer with the
// same thing rather than two spellings of it. The table then reads as a table.
//
// WHAT IS NOT HERE. Shapes that carry their own vocabulary AND several members,
// which take a module each on the `attention-projection.ts` precedent and state a
// deletion obligation there. The line is drawn where it stops being a value and
// starts being a domain.
//
// AND NOT HERE EITHER: A VOCABULARY `@ai-sidekicks/contracts` ALREADY SHIPS. The
// console's own vocabularies below exist because the corpus registers them in a
// document and no code package carries them. Where a package DOES carry one, the
// member names the package's type and this module declares nothing. `billingMode` is
// that case, and the comment on it says what the second union cost.
//
// ONE MODULE PER WIRE DOMAIN, AND THIS FILE IS THE DOOR. The values used to sit in
// one module, where roughly 260 lines of artifact contracts were followed by the
// session, attention, gitflow, and cost-receipt planes — five independent wire
// surfaces behind one maintenance boundary, and one file every consumer of any of
// them had to read. Each plane now has its own module beside this one, and this
// barrel publishes exactly what the single module published: the export surface is
// the same set of names, which `index.test.ts` asserts against a pinned census
// rather than leaving to review.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR. `growth-values/` is a sub-module of
// `bridge/`, not a family of its own: it sits inside the bridge's directory, it is
// below no family in the DAG, and it publishes to the bridge's own modules. So the
// one-`index.ts`-per-family rule is not violated by its existence — `bridge/index.ts`
// remains the single door the rest of the console comes through, and this file is
// reached only by deep, intra-family specifiers.
//
// WHY IT SURVIVES AT ALL. Nine modules inside this family reach it: the seven plane
// modules of `growth-signatures/` that name a value at all — `panes.ts` names shapes
// from two of these planes and the other six one each — plus
// `fixture/fixture-session-directory.ts` and the gitflow port test. What the door buys them
// is a binding to the growth values as a SET rather than to the file layout
// underneath: a plane module that reached `growth-values/tools.js` directly would
// have to move the day a value did, for no gain over the one name that never moves.
// What it may NOT do is leave the
// family: `bridge/index.ts` re-exports every growth value from the module that
// declares it, and `console-no-barrel-chain` in `.dependency-cruiser.mjs` fails the
// build if that ever regresses to a forward through this file.

export type { GrowthNavigationState, GrowthPaneError, GrowthTerminalChunk } from "./panes.js";

export type { GrowthCallbackTool, GrowthToolCall } from "./tools.js";

export {
  GROWTH_ARTIFACT_TYPES,
  type GrowthArtifactDeleteReceipt,
  type GrowthArtifactPayloadDisposition,
  type GrowthArtifactPayloadEncoding,
  type GrowthArtifactRead,
  type GrowthArtifactReplicationStatus,
  type GrowthArtifactState,
  type GrowthArtifactSummary,
  type GrowthArtifactType,
  type GrowthArtifactVisibility,
  type GrowthAttachmentIngestCompletion,
} from "./artifacts.js";

export type {
  GrowthHealthReading,
  GrowthImportProgress,
  GrowthInviteSummary,
  GrowthNotificationPermission,
  GrowthSessionSummary,
} from "./sessions.js";

export type { GrowthAttentionPreference } from "./attention.js";

export {
  GROWTH_PR_PREPARATION_STATES,
  type GrowthBranchContext,
  type GrowthBranchContextReadRequest,
  type GrowthPrPreparationState,
} from "./gitflow.js";

// The receipt's row shapes, its status vocabulary, its principal and its cap are
// deliberately NOT forwarded here. Each carried a line naming the cost page as the
// reader that would import it, and that page has landed: it derives every one of them
// off `GrowthCostReceipt` — which is the closed set's one home, reached through the
// reply type the port already publishes — so the claim could never be retired by the
// task it named. A door line with no reader is deleted rather than re-dated.
export type { GrowthBudgetState, GrowthCostReceipt } from "./cost-receipts.js";
