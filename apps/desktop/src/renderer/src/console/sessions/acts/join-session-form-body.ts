// The join form's chunk root: the one module an `import()` names.
//
// WHY IT EXISTS. Joining a session somebody else is in is the acts bar's SECOND act,
// and the bar draws it disclosed rather than open — `SessionActs.tsx` states why in its
// own words: two open forms is two primaries, and a two-field form permanently beside a
// button reads as the thing you are meant to fill in. So the form is not merely hidden
// while the disclosure is shut, it is absent from the tree, which is exactly the
// question `apps/desktop/AGENTS.md` §Module shape says a registration answers — painted
// before a person acts, or reached through a loader.
//
// It rode the initial import graph anyway, because `SessionActs.tsx` named the form by
// static import, and a symbol reachable both statically and dynamically is assigned to
// the STATIC chunk. The bar now reaches it through `act-body-mounts.ts`, and this module
// is the bundler's split point: everything only it reaches is emitted as its own chunk
// and fetched the first time somebody presses Join.
//
// WHAT DOES NOT TRAVEL WITH IT. `act-settlement.ts` is reached from here and from
// `provider-import-model.ts`, which the bar holds unconditionally, so it stays where it
// already was — in the entry chunk — and this root defers only what nothing eager reads.
// `session-acts.css` stays on the sessions family door for the reason that door owns it:
// it dresses the bar itself, which is painted with the destination, so landing it with
// this chunk would flash the bar undressed on every session that never joins one.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

export { JoinSessionForm as Body } from "./JoinSessionForm.js";
