// The named values growth-port replies are made of.
//
// One interface per shape a served operation answers with, plus the one closed
// vocabulary those shapes read from. They are the CONSOLE's, derived from what its
// surfaces render — not a claim about the eventual wire shape, which belongs to the
// document named on the operation's slate row.
//
// WHY THEY ARE NOT IN THE SIGNATURE TABLE. Most request and reply shapes ARE stated
// inline next door in `growth-signatures.ts`, and that is the default: a shape read
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

export type { GrowthNavigationState, GrowthPaneError, GrowthTerminalChunk } from "./panes.js";

export type { GrowthCallbackTool, GrowthToolCall } from "./tools.js";

export {
  GROWTH_ARTIFACT_REPLICATION_STATUSES,
  GROWTH_ARTIFACT_STATES,
  GROWTH_ARTIFACT_TYPES,
  GROWTH_ARTIFACT_VISIBILITIES,
  type GrowthArtifactDeleteReceipt,
  type GrowthArtifactPayloadDisposition,
  type GrowthArtifactPayloadEncoding,
  type GrowthArtifactRead,
  type GrowthArtifactReadDeferred,
  type GrowthArtifactReadInline,
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
  GrowthSessionSummary,
} from "./sessions.js";

export type { GrowthAttentionPreference } from "./attention.js";

export {
  GROWTH_PR_PREPARATION_STATES,
  type GrowthBranchContext,
  type GrowthPrPreparationState,
} from "./gitflow.js";

export type {
  GrowthBudgetState,
  GrowthCostReceipt,
  GrowthCostReceiptAccountRow,
  GrowthCostReceiptCausedByRow,
  GrowthCostReceiptRunRow,
  GrowthCostStatus,
  GrowthEffectivePrincipal,
  GrowthUnpricedFamilyCap,
} from "./cost-receipts.js";
