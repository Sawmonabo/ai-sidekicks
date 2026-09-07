// The three acts a definition's detail offers, as CALLS: what each puts where, what may
// be attempted at all, and what the answer settles to. The act set itself, its refusal
// vocabulary, and the shape a control reads are `definition-authoring.ts` beside this.
//
// WHAT REACHES THE PORT AND WHAT DOES NOT. Import and promote both call
// `workflowDefinitionCreate`, which is the one write all five authoring acts ride: the
// daemon's operator-scope authorization keys on the target SCOPE the body names and
// not on which gesture composed it. Export calls no growth operation at all and reaches
// the host's clipboard instead, on `runs/pane/controls/enumerated-path-action.ts`'s
// precedent — the console holds no wire that writes a file, and a control that looked
// like it had saved one would be worse than the honest copy.
//
// SINGLE FLIGHT IS THE LATCH'S AND NOT A FLAG'S, for `run-control-dispatch.ts`'s
// reason: a boolean read inside a press handler is the one from the render that
// produced that handler, so two presses in one frame both find the act idle and both
// dispatch. WHICH way each act takes its key is decided by what a duplicate press would
// cost. The two creates take `claim`: the first is already outstanding against the
// daemon and cannot be recalled, so the honest answer to the second is no, said out
// loud on the control. The export takes `supersedeAndClaim`, because a second copy of
// the same bytes writes nothing durable and there is nothing to refuse — what it must
// not do is let the older host answer install on top of the newer one.
//
// NOTHING HERE MUTATES THE READ. A served create does not splice a new version into
// the definition on screen: what the pane shows stays the answer the daemon gave, and
// the settlement says what was written and where. Re-reading the definition after a
// create would be right the day this console can also address the version it just
// wrote; it addresses the definition it was opened at, and that definition's latest
// version is a different subject from the one an import just created.

import {
  parseWorkflowDefinitionFile,
  serializeWorkflowDefinitionFile,
  settleGrowthRead,
  type ConsoleBridge,
  type GrowthPort,
  type WorkflowDefinitionCreateBody,
  type WorkflowVersionBody,
} from "../../../bridge/index.js";
import { normalizeWireRejection } from "../../../core/index.js";
import {
  useGenerationLatch,
  useSubjectScopedState,
  type GenerationClaim,
  type GenerationLatch,
  type SubjectScopedPublish,
} from "../../../store/index.js";
import {
  bodyUnavailable,
  detailRefusal,
  WORKFLOW_DETAIL_ORIGIN,
  type WorkflowDefinitionAuthoring,
  type WorkflowDetailAct,
  type WorkflowDetailActOutcome,
} from "./definition-authoring.js";

/** Everything an act needs beyond the call it is about to put. */
interface AuthoringRuntime {
  readonly latch: GenerationLatch;
  readonly growth: GrowthPort;
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
  readonly body: WorkflowVersionBody | undefined;
  /** The definition this render is addressed at, in the latch's key. Never a name. */
  readonly workflowDefinitionId: string | undefined;
  readonly publish: SubjectScopedPublish<AuthoringState>;
}

/** All three outcomes and the exported bytes, held together so one never erases another's. */
interface AuthoringState {
  readonly outcomes: Readonly<Record<WorkflowDetailAct, WorkflowDetailActOutcome>>;
  readonly exportedFile: string | undefined;
}

const IDLE_OUTCOME: WorkflowDetailActOutcome = { kind: "idle" };

/** Nothing attempted — what a newly opened definition starts at. */
const IDLE_STATE: AuthoringState = {
  outcomes: { export: IDLE_OUTCOME, import: IDLE_OUTCOME, promote: IDLE_OUTCOME },
  exportedFile: undefined,
};

/**
 * Offer the three acts for one definition.
 *
 * ALL THREE ARE OFFERED WHENEVER THEIR SUBJECT EXISTS, and eligibility is never
 * computed here: whether this caller may write at a scope is the daemon's adjudication
 * and arrives as a typed refusal on the press. What this does check is whether there is
 * anything to act ON — a version body for export and promote — because that is a fact
 * about the reads this pane already holds and not a permission.
 *
 * Held against `(port, definition)` exactly as the pane's own read is, so a bridge
 * swapped underneath and a pane re-addressed at another definition each re-seed during
 * the render that brings them: no frame shows one definition's settlement under
 * another's name.
 */
export function useWorkflowDefinitionAuthoring(
  bridge: ConsoleBridge,
  workflowDefinitionId: string | undefined,
  sessionId: string | undefined,
  body: WorkflowVersionBody | undefined,
): WorkflowDefinitionAuthoring {
  const latch = useGenerationLatch();
  const { value, publish } = useSubjectScopedState<AuthoringState>(
    bridge.growth,
    workflowDefinitionId,
    () => IDLE_STATE,
  );
  const runtime: AuthoringRuntime = {
    latch,
    growth: bridge.growth,
    bridge,
    sessionId,
    body,
    workflowDefinitionId,
    publish,
  };
  return {
    outcomes: value.outcomes,
    exportedFile: value.exportedFile,
    exportDefinition: () => {
      void exportDefinitionFile(runtime);
    },
    importDefinition: (text) => {
      void importDefinitionFile(runtime, text);
    },
    promoteDefinition: () => {
      void promoteDefinition(runtime);
    },
  };
}

/**
 * Serialize the body on screen, show the bytes, and hand them to the host's clipboard.
 *
 * THE SETTLEMENT IS THE HOST'S ANSWER AND NEVER THE SERIALIZATION'S. The bytes exist
 * the moment they are composed and the copy does not: a host that hangs never took it,
 * and one that rejects took nothing. Publishing "is on the clipboard" beside the
 * serialization asserted an operation that had not happened — for as long as a hung
 * call took, and forever for one that never answers — so the act stands at
 * `dispatching` while the write is outstanding and only the FULFILLED promise says the
 * version was copied.
 *
 * The file is published on every arm, and that is the whole design: the surface renders
 * it in a read-only box, so a host that hung or refused leaves the bytes selectable
 * rather than leaving the person with nothing.
 *
 * THE SERIALIZATION IS AWAITED because the file form's writer arrives in its own chunk
 * — the parser is charged to the launches that use it and to no others — and the only
 * way it fails is a chunk that did not load. That is a fact about the install rather
 * than about the definition, so it lands on the same rejection seam the clipboard's own
 * refusal does rather than inventing a second refusal for this surface.
 *
 * THE LATCH IS `supersedeAndClaim` AND NOT `claim`, which is the one place this act
 * differs from the two that submit. A second press means the same bytes again — there
 * is no durable record to duplicate, so there is nothing to refuse — but two rounds
 * settle in whatever order the chunk fetch and the host return them, and an older
 * answer must not overwrite a newer one: a first press rejecting after a second press
 * succeeded would otherwise report a copy that did happen as one that did not. THE KEY
 * IS TAKEN BEFORE THE FETCH IS AWAITED, so that ordering covers the codec's answer too
 * — a chunk that failed for a press already superseded may not erase what the newer
 * press put on screen.
 */
async function exportDefinitionFile(runtime: AuthoringRuntime): Promise<void> {
  const { body } = runtime;
  if (body === undefined) {
    publishOutcome(runtime, "export", { kind: "refused", refusal: bodyUnavailable("Exporting") });
    return;
  }
  // Read off the body once and carried, rather than composed at each of the three
  // publishes: the sentence a person reads while the host is asked and the one they
  // read afterwards name the same version because they are the same string.
  const versionLabel = `Version ${String(body.versionNumber)} of ${body.name}`;
  const claim = runtime.latch.supersedeAndClaim(
    runtime.growth,
    actKey("export", runtime.workflowDefinitionId),
  );
  try {
    const file = await serializeFile(runtime, claim, body);
    if (file === undefined) {
      return;
    }
    publishExportedBytes(runtime, claim, file, versionLabel);
    await handToClipboard(runtime, claim, file, versionLabel);
    // The key goes back whichever arm ran, a `publish` that threw included. Nothing is
    // refused by holding it — `supersedeAndClaim` never refuses — but
    // `generation-latch.ts` bounds its register within a live subject BY release, and a
    // key never given back is an entry kept for the life of the bridge.
  } finally {
    claim.release();
  }
}

/**
 * The file the body serializes to, or `undefined` once the refusal has been published.
 *
 * Its own function so the act above reads as the steps it is — serialize, publish, copy
 * — rather than opening with a `try` whose block is most of the body.
 *
 * THE REFUSAL IS SETTLED UNDER THE ROUND'S OWN CLAIM. A chunk fetch that failed for a
 * press somebody has already superseded says nothing about the press they are waiting
 * on, and installing it would replace a newer round's bytes with an older round's
 * excuse.
 */
async function serializeFile(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  body: WorkflowVersionBody,
): Promise<string | undefined> {
  try {
    return await serializeWorkflowDefinitionFile(body);
  } catch (writerRejection: unknown) {
    claim.settle(() => {
      publishCodecAbsence(runtime, "export", writerRejection);
    });
    return undefined;
  }
}

/**
 * Put the bytes on screen and stand the act at `dispatching` while the host is asked.
 *
 * THE BYTES GO IN BESIDE THE OUTCOME AND NOT INSIDE IT, so the two arms below replace
 * where the act STANDS and leave what it produced on screen. And the write is the
 * round's, for `serializeFile`'s reason: a superseded press that published here would
 * put `dispatching` over a newer press's own settlement or refusal.
 */
function publishExportedBytes(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  file: string,
  versionLabel: string,
): void {
  claim.settle(() => {
    runtime.publish((previous) => ({
      exportedFile: file,
      outcomes: {
        ...previous.outcomes,
        export: {
          kind: "dispatching",
          detail: `${versionLabel} is below. Waiting for the host to take the copy.`,
        },
      },
    }));
  });
}

/**
 * Ask the host to take the copy, and settle on whichever answer it gives.
 *
 * WHAT THE HOST SAID, NEVER A PARAPHRASE OF IT — rule 9, and the seam
 * `enumerated-path-action.ts` established for exactly this call. The fallback is
 * reached only where the rejection carried nothing machine-readable, and it says what
 * did not happen and what is still on screen rather than repeating the bytes.
 *
 * The rejection handler is `then`'s SECOND ARGUMENT rather than a `catch` link, so a
 * publish that threw on the fulfilled arm cannot arrive here and be reported as the
 * host having refused a write it had already taken.
 */
function handToClipboard(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  file: string,
  versionLabel: string,
): Promise<void> {
  return runtime.bridge.sidekicks.native.copyToClipboard(file).then(
    () => {
      claim.settle(() => {
        publishOutcome(runtime, "export", {
          kind: "settled",
          detail: `${versionLabel} is on the clipboard, and below.`,
        });
      });
    },
    (rejection: unknown) => {
      claim.settle(() => {
        publishOutcome(runtime, "export", {
          kind: "refused",
          refusal: normalizeWireRejection(WORKFLOW_DETAIL_ORIGIN, rejection, {
            code: "call-rejected",
            detail:
              "native.copyToClipboard was rejected, so the file was not copied. It is shown below and can be selected by hand.",
          }),
        });
      });
    },
  );
}

/**
 * Publish the refusal for a file-form codec that did not arrive.
 *
 * ONE SENTENCE FOR BOTH ACTS, because it is one fact: the reader and the writer are the
 * same module and it is fetched on first use, so an export and an import fail together
 * or not at all. Two spellings of it would drift the first time either was reworded.
 */
function publishCodecAbsence(
  runtime: AuthoringRuntime,
  act: WorkflowDetailAct,
  rejection: unknown,
): void {
  publishOutcome(runtime, act, {
    kind: "refused",
    refusal: normalizeWireRejection(WORKFLOW_DETAIL_ORIGIN, rejection, {
      code: "call-rejected",
      detail:
        "The part of this app that reads and writes definition files did not load, so nothing happened. Pressing again asks for it once more.",
    }),
  });
}

/**
 * Read the pasted text and submit what it describes into this session's own scope.
 *
 * THE TARGET IS THE NARROWEST SCOPE AND IS NOT A CHOICE, which is a decision rather
 * than an omission. A file carries no scope — it is bytes that travelled between
 * machines — so somebody has to say where it lands, and the answer that needs no
 * picker and no authorization argument is the session a person is importing into.
 * Widening it afterwards is the promote act, which is the next control along.
 */
async function importDefinitionFile(runtime: AuthoringRuntime, text: string): Promise<void> {
  const { sessionId } = runtime;
  if (sessionId === undefined) {
    publishOutcome(runtime, "import", {
      kind: "refused",
      refusal: detailRefusal(
        "session-unbound",
        "This pane is not bound to a session, so there is no scope for an imported definition to land in.",
      ),
    });
    return;
  }
  const definition = await readDefinitionFile(runtime, sessionId, text);
  if (definition === undefined) {
    return;
  }
  await submitDefinition(runtime, "import", definition, (versionNumber) => {
    return `${definition.name} was created in this session at version ${versionNumber}.`;
  });
}

/**
 * The body the pasted text describes, or `undefined` once the refusal is published.
 *
 * The reader's own refusal travels as the sentence it composed — which member is wrong
 * is the whole of what a person needs beside a paste box — and the codec's absence
 * takes the seam beside it, because a chunk that did not arrive says nothing about the
 * text. Only the reading is guarded: a daemon refusal on the submit below belongs to
 * the call that raised it.
 */
async function readDefinitionFile(
  runtime: AuthoringRuntime,
  sessionId: string,
  text: string,
): Promise<WorkflowDefinitionCreateBody | undefined> {
  try {
    const reading = await parseWorkflowDefinitionFile(text, {
      sessionId,
      scope: "session",
      scopeRef: sessionId,
    });
    if (reading.status === "parsed") {
      return reading.body;
    }
    publishOutcome(runtime, "import", {
      kind: "refused",
      refusal: detailRefusal("file-unreadable", reading.reason),
    });
  } catch (readerRejection: unknown) {
    publishCodecAbsence(runtime, "import", readerRejection);
  }
  return undefined;
}

/**
 * Submit the body on screen at `shared` scope, byte for byte.
 *
 * NO `parentContentHash`, AND ITS ABSENCE IS THIS ACT'S OWN CLAIM RATHER THAN AN
 * OMISSION. That member is copy-on-write provenance for the OPPOSITE direction:
 * `Spec-017 §Definition scope in the builder (SA-36)` reserves it for an author editing
 * a `shared` definition, which produces a NARROWER one recording the shared original's
 * hash. A promotion runs the other way and creates the shared definition "from the
 * promoted version's exact bytes" — there is no shared original to have branched from,
 * so setting it would record every promoted version as a downward fork off a definition
 * that never existed and corrupt the version chain for each one.
 *
 * WHAT TRAVELS IS THE BODY AND THE TARGET SCOPE, AND NO FLAG. The daemon's
 * operator-scope authorization keys on the scope the body names and never on the
 * gesture that composed it, so this is the same write an author typing a shared
 * definition by hand puts.
 */
async function promoteDefinition(runtime: AuthoringRuntime): Promise<void> {
  const { body, sessionId } = runtime;
  if (body === undefined || sessionId === undefined) {
    publishOutcome(runtime, "promote", {
      kind: "refused",
      refusal: bodyUnavailable("Promoting"),
    });
    return;
  }
  const request: WorkflowDefinitionCreateBody = {
    sessionId,
    name: body.name,
    // `shared` is daemon-wide and refers to nothing narrower, so the member that names
    // a scope's identity is deliberately absent rather than empty.
    scope: "shared",
    entry: body.entry,
    phaseDefinitions: body.phaseDefinitions,
  };
  await submitDefinition(runtime, "promote", request, (versionNumber) => {
    return `${body.name} was copied to the shared scope at version ${versionNumber}.`;
  });
}

/**
 * Claim the act's key, put the create, and settle whatever comes back.
 *
 * `settleGrowthRead` and not a bare `await`, because a growth call can also REJECT: a
 * scenario that scripts a daemon refusal throws it verbatim, and the live seam will
 * throw the same shape once the wire lands. A fulfilment handler alone would leave the
 * control reading `dispatching` for the life of the pane over an answer that had
 * already arrived.
 */
async function submitDefinition(
  runtime: AuthoringRuntime,
  act: WorkflowDetailAct,
  request: WorkflowDefinitionCreateBody,
  describe: (versionNumber: string) => string,
): Promise<void> {
  const claim = runtime.latch.claim(runtime.growth, actKey(act, runtime.workflowDefinitionId));
  if (claim === undefined) {
    publishOutcome(runtime, act, {
      kind: "refused",
      refusal: detailRefusal(
        "act-in-flight",
        "A definition is already being submitted here. The first one is outstanding against the daemon and cannot be recalled.",
      ),
    });
    return;
  }
  // Composed from the request that is about to go rather than passed in beside it: both
  // acts here submit, and a sentence read off the very body being sent cannot describe
  // a different scope from the one the daemon will adjudicate.
  publishOutcome(runtime, act, {
    kind: "dispatching",
    detail: `Submitting ${request.name} at the ${request.scope} scope.`,
  });
  try {
    const settlement = await settleGrowthRead(runtime.growth.workflowDefinitionCreate(request));
    claim.settle(() => {
      publishOutcome(
        runtime,
        act,
        settlement.status === "served"
          ? { kind: "settled", detail: describe(String(settlement.value.versionNumber)) }
          : { kind: "refused", refusal: settlement },
      );
    });
    // The key goes back whatever happened, a `publish` that threw included: a key held
    // for the life of the subject would refuse every later press on this definition.
  } finally {
    claim.release();
  }
}

/**
 * One key per `(act, definition)`.
 *
 * The definition is in the key because this pane is RE-ADDRESSED IN PLACE: the latch
 * outlives one definition's visit, so definition A's outstanding create must not refuse
 * definition B's first press. The three acts take separate keys for the mirror reason —
 * an outstanding import must not refuse a promote, and an export superseding its own
 * clipboard write must abandon no create.
 */
function actKey(act: WorkflowDetailAct, workflowDefinitionId: string | undefined): string {
  return `${act}:${workflowDefinitionId ?? ""}`;
}

/**
 * Write one act's outcome into the state this render is addressed at.
 *
 * The FUNCTION form of publish rather than a value, because the three acts share one
 * held record and a settlement composed from a closure's copy of it would drop the
 * other two — a promote settling while an import refusal was on screen would erase the
 * refusal.
 */
function publishOutcome(
  runtime: AuthoringRuntime,
  act: WorkflowDetailAct,
  outcome: WorkflowDetailActOutcome,
): void {
  runtime.publish((previous) => ({
    ...previous,
    outcomes: { ...previous.outcomes, [act]: outcome },
  }));
}
