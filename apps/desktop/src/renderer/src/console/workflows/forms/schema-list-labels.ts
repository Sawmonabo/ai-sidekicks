// What a collection's three surfaces are CALLED: one entry, the control that adds one,
// and the control that drops one.
//
// SPLIT FROM THE VOCABULARY BECAUSE THIS IS PROSE AND THAT IS A TYPE SYSTEM.
// `schema-fields.ts` says what a drawn form is made of — the six kinds, the three
// descriptors, and the one rule about what an unanswered member is worth; nothing here
// answers any of that. These three compose the sentences a person hears, and holding both
// jobs in one module was what took it to the length at which a reader stops seeing two.
//
// COMPOSED ONCE AND NEVER AT THE SURFACE THAT SPEAKS THEM. The remove control's name is
// built out of the entry's own, so the control that drops an entry names exactly what the
// entry is called and the two cannot drift; and a reading of either name — a test, a
// second surface — asks this module rather than re-spelling the template.

import type { SchemaListDescriptor } from "./schema-fields.js";

/**
 * What one entry of a list is called: the collection's name and where the entry sits.
 *
 * A NAME AND NOT A NUMBER. An array member has no key of its own, so the only thing that
 * distinguishes one repeated control from the next is its position — and a position on
 * its own ("entry 2") tells a person navigating by control nothing about which collection
 * they are in, which is exactly the reading a form with two lists would give them.
 */
export function listEntryLabel(list: SchemaListDescriptor, index: number): string {
  return `${list.label}, entry ${String(index + 1)}`;
}

/**
 * What the control that adds one entry is CALLED, which is not what it reads.
 *
 * A FIELDSET LEGEND IS NOT PART OF A BUTTON'S ACCESSIBLE NAME. The legend names the
 * collection to somebody reading the form top to bottom, and says nothing at all to
 * somebody moving between buttons — so a form with two lists offered two controls called
 * "Add an entry", and pressing either of them added an entry to a collection the person
 * had not chosen. The visible text stays the short one, because the surrounding fieldset
 * IS the answer for a reader who can see it; the spoken name carries the collection.
 */
export function listAppendLabel(list: SchemaListDescriptor): string {
  return `Add an entry to ${list.label}`;
}

/**
 * What the control that drops one entry is called, composed from the entry's own name.
 *
 * The same defect one control over: "Remove entry 1" is the same sentence in every
 * collection on the form. It reuses `listEntryLabel` rather than composing a second
 * phrasing, so the control that removes an entry names exactly what the entry itself is
 * called and the two cannot drift.
 */
export function listRemoveLabel(list: SchemaListDescriptor, index: number): string {
  return `Remove ${listEntryLabel(list, index)}`;
}
