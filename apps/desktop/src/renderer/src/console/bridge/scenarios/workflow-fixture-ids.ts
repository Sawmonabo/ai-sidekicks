// The workflow fixture's identifiers, and the framing its four data modules share.
//
// SPLIT FROM THE SCENARIO ON PURPOSE. `workflows.ts` owns the SESSION — the beats a
// daemon could emit and the replies a call is answered with — and this fixture owns
// the workflow STATE those replies carry. The two are different kinds of thing: a
// beat is held to `packages/contracts`' strict layer by `scenarios/wire-truth.ts`,
// while these shapes are declared by `bridge/workflow-projection.ts` because the
// corpus registers no workflow types at all. Keeping them in one file put a wire the
// contract owns and a wire the growth slate owes side by side under one header.
//
// AND SPLIT AGAIN, BY RESPONSIBILITY. The state itself is four independently
// maintained tables — the definitions a browser groups, the four runs a list ranks,
// the outputs a finished phase left behind, and the agents a phase dispatches to —
// which shared one module until it passed the size a reader can hold. Each has its
// own file now; what they share is this one, because an identifier two of them name
// has to be one literal or the fixture proves nothing. The agents table is the one
// that is not `workflow-projection.ts`-typed: it feeds the session's `agent.attached`
// beats, so it sits beside neither the definitions nor the runs.
//
// WHICH NAMES CARRY THE SCENARIO PREFIX. One that leaves this directory does —
// `WORKFLOWS_SESSION_ID` is read by a pane test four families away, where `SESSION_ID`
// would say nothing about which session. One that is read only by a sibling here does
// not: `PHASE_DRAFT` at a `phaseId:` is exactly as clear as the import above it.
//
// EVERYTHING HERE IS BEHIND ONE SLATE ROW. `workflow-run-control` owes nine of the
// thirteen registered workflow method strings together with the run, phase,
// definition, and output shapes they carry. Until it lands these are the console's
// consumption shapes and nothing claims otherwise; when it lands they are replaced by
// the registered types and this data is re-typed against them.

/** The session every fact in this fixture belongs to. The scenario's own id, once. */
export const WORKFLOWS_SESSION_ID = "019b7a10-0280-75e5-8510-ada11a5a3333";

/** The person this window is, and the actor on every beat a person caused. */
export const WORKFLOWS_PARTICIPANT_YOU = "019b7a10-0280-79a4-8110-cca0117a0110";

// Version ids, shared by the definitions table and the runs table because the
// frozen-pin state is an INEQUALITY between two of them: a run pinned to `Ship
// pipeline` version 1 against a definition whose latest is version 3. Written as two
// hand-typed literals that comparison is one typo away from proving nothing, and
// written in two FILES it would be one rename away from the same.
export const VERSION_RELEASE_CHECKS_LATEST = "019b7a10-0280-7d22-8100-be5100150004";
export const VERSION_SHIP_PIPELINE_LATEST = "019b7a10-0280-7d22-8100-be5100150003";
export const VERSION_SHIP_PIPELINE_PINNED = "019b7a10-0280-7d22-8100-be5100150001";
export const VERSION_INCIDENT_TRIAGE_LATEST = "019b7a10-0280-7d22-8100-be5100150002";

// Phase ids are UUIDs like every other identifier on these shapes: `WorkflowPhaseId`
// is a branded id in `docs/architecture/contracts/api-payload-contracts.md` §Branded
// ID Types rather than an author-chosen label. The phase's readable NAME is on none
// of the reads this fixture can answer — see the note above the run table. The five
// are one closed set and are declared here whole rather than split between the runs
// that sequence them and the outputs that address one of them.
export const PHASE_DRAFT = "019b7a10-0280-7e44-8100-9ba5e1150001";
export const PHASE_BUILD = "019b7a10-0280-7e44-8100-9ba5e1150002";
export const PHASE_REVIEW = "019b7a10-0280-7e44-8100-9ba5e1150003";
export const PHASE_SIGN_OFF = "019b7a10-0280-7e44-8100-9ba5e1150004";
export const PHASE_PUBLISH = "019b7a10-0280-7e44-8100-9ba5e1150005";
