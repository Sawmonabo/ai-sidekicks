// The seats family's door — and the one place view families reach each other.
//
// The family holds the session screen's shared vocabulary: the seats through
// which the view families hand each other panes, a composer, sidebar sections,
// timeline rows, and inline cards, and the surface registry through which a family
// hands the frame a whole route's body. It sits directly above `bridge/` and below
// `palette/` and `frame/` in the console's DAG.
//
// WHY THAT POSITION, AND NOT INSIDE A VIEW FAMILY. These contracts used to live at
// `workspace/seats/` and were published by `workspace/index.ts`. `workspace/` is a
// VIEW FAMILY — the ledger and the composer author bodies in it — and a view family
// sits at the TOP of the DAG, above the frame. But the frame composes the pane
// registry singleton, so the frame imported the family, and the family is documented
// to import the frame: an upward edge that either closes a cycle the moment the
// workspace body lands, or forces a view family to stop using its own lower layers.
// The layering gate stayed green on it because its ladders stopped at `frame/` and
// no rule named the view families at all. Both halves are fixed together — this
// family is the hoist, and `.dependency-cruiser.mjs` now forbids any layer family,
// the frame included, from importing a view family.
//
// The position is read off the imports rather than chosen: the seats import `core/`,
// `tokens/`, `routing/`, `store/`, `persistence/`, `bridge/`, and `src/shared/`, and
// nothing higher, so the lowest home above all of them is the slot immediately above
// `bridge/`. The surface registry was read the same way and answered the same slot,
// which is why it moved here from `frame/` and took the console's last named layering
// exemption with it. Lower is also the more permissive choice for the two families that sit
// between here and the view families — the palette may open a pane, and the frame may
// hold the board — while neither can be reached from a seat.
//
// ONE BARREL, on the module-shape rule in `apps/desktop/AGENTS.md`: "Every console
// family carries exactly one `index.ts`. Cross-family imports go through it;
// intra-family imports are deep. A barrel re-exports only its own family — no
// re-export chains." This file is that one barrel, and the seat modules beside it are
// the family.
//
// WHY EVERY OTHER CROSS-FAMILY EDGE STILL RUNS DOWNWARD. A view family imports
// `core/`, `tokens/`, `routing/`, `primitives/`, `store/`, `persistence/`,
// `bridge/`, `seats/`, `palette/`, and `frame/`, and none of those imports it back.
// The view families are SIBLINGS, and siblings have no edge at all — which is what
// keeps six concurrent branches from serializing behind each other.
//
// But siblings still hand each other things: the deck mounts panes six families
// build, the workspace mounts a composer the composer family fills, one sidebar
// carries sections four families own, and the ledger renders cards the repos
// family authors. Every one of those is a CONTRACT rather than an import — a type
// plus a registry, minted once here so no branch invents its own.
//
// So the rule is: a view family imports this door and nothing else of a sibling's.
// A family reaching past it into another family's subtree is reaching for a body,
// and a body is exactly what a seat exists to keep it from holding.
//
// ONE THING HERE RENDERS, AND IT IS THE FRAME RATHER THAN A BODY. `PaneFrame`
// is the chrome every pane wears — kind glyph, breadcrumb, control strip, focus
// treatments — and it is here for the same reason every other seat is: the deck that
// provides its host control is a VIEW family, six sibling families each draw a
// pane inside it, and a sibling may not import a sibling. Six frames drawn
// independently is six spacings and six answers to where the focus ring goes, which is
// the drift a seat exists to remove. The rule it does not break is the one that
// matters: a seat may not hold a BODY, and this holds none — every pane's content
// arrives as `children` from the family that owns it. Its stylesheet is imported below,
// where every console family imports its own.
//
// NOTHING ELSE HERE RENDERS. No store, no scenario, no second console component.
//
// THE `@consumedBy` TAGS BELOW are the dead-code gate's one exemption, on the terms
// `apps/desktop/AGENTS.md` sets: every seat is reached by a task that has not landed,
// so each specifier names the task or tasks that will import it. The tag rides the
// SPECIFIER because that is the export knip reports; the declaration in the seat's own
// module carries the same claim as a `// Consumed by` line. Both go in the PR that
// imports the symbol — a tag that outlives its consumer fails the run.

// The schema form seat's rules are deliberately NOT here. That directory carries a
// lazily-loaded chunk now, so it owns its own sheet and admits it at that chunk's root —
// `apps/desktop/AGENTS.md`'s rule read from the owner's side. It loads with the first
// schema form and never before.

// How a family reaches the screen: the registry it claims a slot in, the call that
// claims one, and everything a mounted surface is handed. Here rather than in
// `frame/` because this is the same kind of contract every other seat is — a family
// hands the frame a body through it — and because a view family cannot import the
// frame's door at all without closing a cycle back through `app/registrations.ts`. No
// `@consumedBy` claims: the frame and the composition root read these today.
//
// Four names are deliberately absent, each because no PRODUCTION module reaches it
// through this door and the barrel census fails a line like that. `ScreenName`
// is reached through the descriptor a family fills in. `SCREEN_NAMES`'s only
// reader is `families.test.ts`. `registerConsoleSurface` — the module-scope door a
// plan-owned subtree mounting into the console would call — has no caller outside this
// family yet; the family that lands the first one adds the line in its own diff. And
// `ScreenDescriptor` joined them when the last pre-console slot claim was
// retired: every surviving registrar hands `register` an object literal or a
// `ScreenRegistration` row and names the descriptor type nowhere, so the line
// had only a test harness left reading it, and that harness takes the declaring module.
export {
  ScreenRegistry,
  screenRegistry,
  findScreenNameForRoute,
  // What a family hands `register`, published for the same reason
  // `PaneRegistration` is: a family claiming more than one slot keeps its
  // claims in a table, and a table needs the type its rows are. The workflows family
  // is the first with two — the rail's destination and the phase deep link.
  type ScreenRegistration,
} from "@renderer/registries/screens/screen-registry.js";

// The two contexts come off their own modules rather than off the boards that hand them
// out. They were hoisted there to break a cycle — a board reaches the reserved frame it
// mounts while a loader-backed body is in flight, and that frame names the context — and
// re-exporting them from the boards here would put this door's readers back on a
// specifier the declaration no longer lives at.
export type { PaneContext } from "@renderer/registries/panes/pane-context.js";
export type { ScreenContext } from "@renderer/registries/screens/screen-context.js";

// `PANE_KINDS` and `EPHEMERAL_PANE_KINDS` are deliberately absent: every reader of
// either SET is inside this family or is a suite that drives the kinds directly, and
// both take `seats/pane-kinds.js` by its own specifier. A door line no production
// module reads is one the barrel census fails, so the sets leave rather than being
// tagged. Their two predicates stay, because the deck asks both of them.
export {
  isEphemeralPaneKind,
  isPaneKind,
  type PaneKind,
} from "@renderer/routing/panes/pane-kinds.js";

export {
  /** @consumedBy a view family that has not landed yet */
  paneEntityScopeFor,
  type PaneAddress,
  /** @consumedBy a view family that has not landed yet */
  type PaneLink,
  type PaneOpener,
  /** @consumedBy a view family that has not landed yet */
  type PaneEntityScopeDeclaration,
} from "@renderer/routing/panes/pane-address.js";

export { parsePaneAddress } from "@renderer/routing/panes/parse-pane-address.js";

export {
  PaneRegistry,
  paneRegistry,
  /** @consumedBy a view family that has not landed yet */
  registeredPaneKinds,
  type PaneDescriptor,
  type PaneRegistration,
} from "@renderer/registries/panes/pane-registry.js";

// The idle warm and its scheduler. Published because the composition that owns a
// window's first frame is the one that starts the walk, and that composition is
// `frame/`, a family above this one — the seam a view family never touches.
export {
  LazyBodyIdleWarm,
  idleWarmScheduler,
  type IdleWarmScheduler,
} from "@renderer/components/LazyBody/lazy-body-warm.js";

// THE LOADER MECHANISM, PUBLISHED FOR THE ONE BOARD THAT IS NOT IN THIS DIRECTORY.
//
// It was absent from this door while the deck's pane registry and the frame's surface
// registry were the only boards that normalised a loader into a descriptor, and both sit
// here. The settings family's page registry is a third: its rail mounts one page per
// section, a page's body is a chunk like any other, and a settings page reachable from a
// family door that another family imports EAGERLY is on every launch's initial graph
// whether or not settings is ever opened — which is the defect
// `settings/settings-page-registry.ts` records measuring. Building a second normaliser
// beside `LoaderBackedBody` would have been two settle semantics to keep in step, so the
// board that lives outside this directory reads the one that already exists.
//
// `PENDING_BODY_ATTRIBUTE` joins it, and the reason the marker had no door line
// expires with the same change: it had exactly one reader outside this directory and that
// reader was a test — the screenshot tier's capture helper, which refuses to photograph a
// half-loaded body — so a door line would have been a specifier no shipped module reads,
// which the module-shape rule in `apps/desktop/AGENTS.md` rejects rather than tolerates.
// A settings page waiting on its chunk is the same hazard the marker exists for, so the
// attribute now has a production reader and a door line is what it is owed.
// `listPendingBodyNames` and `findPendingBodies` still have none and still take the
// leaf directly, for the reason above: their only consumer outside this directory is
// that helper.
//
// `reservedBodyRegion` is on the same line for the same reason and one more: the bodies
// that take it are a view family's own overlay cards, so the attribute and the element
// that carries it leave this directory together rather than as a string a family then
// spells into an element of its own.
//
// `LazyBodyBoard` and `LazyBodyModule` stay absent — named only by the boards and the
// walk in this directory — and a family declaring a loader beside its registration writes
// `body: () => import("./x-body.js")` inline, which names no type at all.
export {
  PENDING_BODY_ATTRIBUTE,
  reservedBodyRegion,
} from "@renderer/components/LazyBody/pending-body-marker.js";
export { LoaderBackedBody, type LazyBodyLoader } from "@renderer/components/LazyBody/lazy-body.js";

export {
  findComposerRenderer,
  registerComposer,
  /** @consumedBy a view family that has not landed yet */
  unregisterComposer,
  type ComposerProps,
  /** @consumedBy a view family that has not landed yet */
  type ComposerRenderer,
} from "@renderer/registries/composer/composer-registry.js";
// The other direction: a surface that told a person to type something asking the
// mounted composer for the caret. Through the door because the asker and the answerer
// are two view families that name each other nowhere.
export {
  requestComposerFocus,
  subscribeToComposerFocus,
} from "@renderer/features/composer/composer-focus-requests.js";

export {
  /** @consumedBy a view family that has not landed yet */
  TRANSCRIPT_ROW_DENSITIES,
  registerTranscriptRowRenderer,
  findTranscriptRowRenderer,
  type TranscriptRowDensity,
  type TranscriptRowRenderer,
  type TranscriptRowProps,
} from "@renderer/features/transcript/transcript-row-renderer.js";

// `InlineCardBodyDescriptor` is deliberately absent: a registrar hands `register` an
// object literal and `inlineCardBody` answers already narrowed, so the reservation that
// held the line named a task that landed and imported it nowhere.
export {
  /** @consumedBy a view family that has not landed yet */
  INLINE_CARD_KINDS,
  InlineCardRegistry,
  inlineCardBody,
  inlineCardRegistry,
  type ArtifactInlineCardProps,
  type AttachmentInlineCardProps,
  type DiffInlineCardProps,
  /** @consumedBy a view family that has not landed yet */
  type InlineCardAttachmentRef,
  /** @consumedBy a view family that has not landed yet */
  type InlineCardKind,
  /** @consumedBy a view family that has not landed yet */
  type InlineCardPropsByKind,
  type InlineCardProps,
} from "@renderer/registries/inline-cards/inline-card-registry.js";

// The pane chrome and the seam its host control travels on. No marker on any of
// these lines, and every half of the reason has now happened: shipped pane bodies
// import the chrome and narrow through `paneBodyForKind`; the deck — the one host that
// provides the close control — ships and mounts every pane inside `PaneControlsContext`
// and names `PaneControls` on the value it builds, so the close control is drawn
// through the seam a deck provides it through rather than asserted by a test; and two
// shipped families name the owner slot's contract on the slots they declare — the
// ledger's message card and timeline pane, and the workflows family's own slot table.
// A surviving marker would fail the run under `--treat-tag-hints-as-errors`.
export { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
export {
  paneBodyForKind,
  type PaneContextOf,
} from "@renderer/registries/panes/pane-body-for-kind.js";

export {
  PaneControlsContext,
  type PaneControls,
} from "@renderer/components/PaneFrame/pane-controls.js";

// The session vocabulary, straight from the module that DECLARES it rather than
// through `store/index.js`, which would be a barrel chain. Without these four lines
// the door written for the view families is unreachable through the one import path
// they are allowed to use: a pane reaching `../../seats/session-subject.js` is a deep
// cross-family import the package standard forbids, so the only other answer would be
// not to bind at all. Both gates were green on that for reasons neither intends — the
// module's own test keeps it reachable, and it imports two families so it is no
// orphan — which is why the census below is the thing that says who owes the rebind.
// The hook's claim is retired: the ledger's pane holds its chapter disclosure and
// both of its row-retention tables through this line.
export { isCurrentSessionSubject } from "@renderer/store/subject-scoped/session-subject.js";
export { useSessionScopedState } from "@renderer/store/subject-scoped/useSessionScopedState.js";
// `SessionScopedKey` stays off the door with the hook's own claim: every caller passes a
// session id rather than declaring the key type, so the reservation that held the line
// named a task that landed and imported it nowhere.
export type { SessionSubject } from "@renderer/store/subject-scoped/session-subject.js";

// The node's session directory — the read, the offer a picker draws from it, and the
// one way a settled act says the node's list has moved.
//
// In this family because it has readers on both sides of the frame, and neither `frame/`
// nor its door is reachable from below.
//
// The invalidation door travels with the read for the same reason the read is here: it
// is addressed at the call, so the family that settles an act and the families that
// render the answer reach one generation rather than passing a refresh callback down
// through whichever surfaces happen to sit between them.
export { requestSessionDirectoryRead } from "@renderer/store/session-directory/session-directory.js";
export { useSessionDirectory } from "@renderer/store/session-directory/useSessionDirectory.js";
export type {
  SessionDirectoryReadCall,
  SessionDirectoryState,
} from "@renderer/store/session-directory/session-directory.js";

// The composed new-session draft's seat: the props the control takes.
//
// Two view families meet on it. The workspace family declares the control against these
// props and the sessions family mounts a component that satisfies them, and neither may
// import the other, so a second spelling in either would be a contract with two homes
// and one reader. The module beside this line carries no runtime value at all: what a
// settled start DOES is the sessions family's act, and this seat carries only the id.
export type {
  FirstTurnQueueCall,
  NewSessionControlProps,
} from "@renderer/features/sessions/new-session/new-session-control-contract.js";

// The read discipline every live wire read in this console follows — subscribe
// first, answer a push with a fresh read, one read per burst through the refresh
// chokepoint, never a flicker. It sits here rather than in the family that wrote it
// because four view families now hold one, and a second copy would be a second set
// of answers to when a surface re-reads.
// The failure-code vocabulary, the options shape, and the codes' derived union stay
// inside this family: their readers are `read/`'s own modules and the suites beside
// them, and a barrel specifier no cross-family import uses is a dead export rather
// than a convenience.
export {
  PushDrivenRead,
  type PushDrivenReadState,
} from "@renderer/store/reads/push-driven-read.js";
export { usePushDrivenRead } from "@renderer/store/reads/hooks/usePushDrivenRead.js";

// The reply unwrappers, from the module that DECLARES them. They answer a
// different question from the model above — a reply's own discriminant, with no
// subscription, scheduler, or teardown behind it — and a MUTATION needs the same
// translation with no read to route through, which is why they are free functions
// and why they left that module when it was split.
export { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
export { unwrapDaemonReply } from "@renderer/services/daemon/unwrap-daemon-reply.js";

// The console's single copy of the daemon-EVENT cast. The brand
// `PlatformBridge.daemon.subscribe` takes is `never`-shaped until the daemon method
// union narrows it, and every caller casts; one module casts, and the day it narrows one
// file changes. Its call-side twin is gone — `services/daemon/daemon-reply.ts` names the
// methods and parses both directions, so no seat casts a call any more.
export {
  /** @consumedBy a surface that listens for one daemon event */
  subscribeDaemonEvent,
} from "@renderer/services/daemon/subscribe-daemon-event.js";

// THE JSON-SCHEMA FORM SEAT — the mapper, the six Meridian field controls, the two
// composed surfaces and the schema-validated raw editor behind them. Here for the reason
// every other seat is here: an owning family needs a form, and a form is not that
// family's to author twice. The workflow builder previews what a phase will ask, the run
// pane answers a parked one, and the input-ask card's structured-options arm is the next
// reader — three surfaces, one drawing of what a schema means.
//
// WHAT LEAVES IS A COMPOSED SURFACE AND NEVER THE KIT. `useSchemaForm` and
// `planSchemaForm` stay inside, and their absence is the boundary rather than an omission:
// a caller assembling them itself would be a second answer to what a schema draws, and the
// one place a schema is drawn is `SchemaForm.tsx`. So the composers live WITH the parts and
// leave through this door. What checks an answer against a schema is not in the kit at all
// — a validator lives in `bridge/`, and the kit reaches the compiler through the loader
// that family's door publishes, so this seat holds no reading of a schema library either.
//
// AND THE SEAT DOES NOT DECIDE WHAT AN ANSWER MEANS. `SchemaFormAnswer` carries the
// prompt, the controls and the one act that sends what they compose; the mounting body
// owns where that act goes and what the daemon said back. The seat is the form; the body
// is the phase.
//
// THE READING BESIDE THEM IS THE STAGED ATTACHMENTS' — which of an answer's values are
// artifacts, answered against the schema's own declared members rather than against what
// the mapper drew, because one member outside the render set sends the whole form to the
// raw editor and the artifact members beside it are still declared. One answer, for the
// composers' reason: a caller walking the schema itself would be a second reading of it.
//
// AND ALL THREE LEAVE THROUGH A LOADER, which is the one thing about this seat that is
// not like the others. Every surface that draws a schema is itself a loader-backed body,
// so a static line here would assign the whole kit to the STATIC chunk on the
// module-shape rule in `apps/desktop/AGENTS.md` — every module of that directory, the
// JSON-Schema validator behind them and the zod entry point it reaches, and its
// stylesheet, on the document of every session that never opens a form. Count-free
// deliberately: a number written here is a claim about a directory that goes stale the
// next time the kit grows a field, and the one that stood here had. So what this door
// publishes is the mounts and the chunk's loader; `schema-form-body.ts` is the chunk
// root they reach.
export {
  schemaFormAnswerBody,
  schemaFormChunk,
  schemaFormPreviewBody,
} from "@renderer/features/workflows/schema-form/schema-form-mounts.js";
