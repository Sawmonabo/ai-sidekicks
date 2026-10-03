// The spoken names of a collection's entry, add control and remove control. Composed once
// here so the remove name is built from the entry name and the two cannot drift.

import type { SchemaListDescriptor } from "../plan/schema-fields.js";

/**
 * What one entry is called: the collection's name and its position, because a bare
 * position ("entry 2") names no collection to someone navigating by control.
 */
export function listEntryLabel(list: SchemaListDescriptor, index: number): string {
  return `${list.label}, entry ${String(index + 1)}`;
}

/**
 * The accessible name of the add control. A legend is not part of a button's name, so the
 * collection is named here; the visible text stays the short "Add an entry".
 */
export function listAppendLabel(list: SchemaListDescriptor): string {
  return `Add an entry to ${list.label}`;
}

/** The accessible name of the remove control, built from the entry's own name. */
export function listRemoveLabel(list: SchemaListDescriptor, index: number): string {
  return `Remove ${listEntryLabel(list, index)}`;
}
