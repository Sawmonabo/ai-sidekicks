// What main writes onto the served console document's root element, so the first paint is right
// with no script and no read: the appearance record's root (`composeRootAppearance`), its
// attributes, the scheme resolved to light or dark among them, and an inline style, and the
// safe-start mark on a load after repeated renderer crashes. Every value comes from the schema-checked record, an enum or a positive number, so
// none needs escaping.

import {
  composeRootAppearance,
  type AppearanceRecord,
  type ColorScheme,
} from "#shared/appearance.js";
import { SAFE_START_ATTRIBUTE } from "#shared/window/safe-start.js";

/** What one served console document's root carries. */
export interface RootStamp {
  readonly record: AppearanceRecord;
  /** The scheme the platform draws in now, which the record's `system` resolves to. */
  readonly platformScheme: ColorScheme;
  /** Whether this load is a safe start, which opens without the kept window layout. */
  readonly isSafeStart: boolean;
}

const ROOT_ELEMENT_TAG = /<html\b([^>]*)>/i;

/**
 * Returns `documentText` with `stamp` added to its `<html>` tag. Throws when the document has no
 * `<html>` tag, which only a broken build produces.
 */
export function stampRootElement(documentText: string, stamp: RootStamp): string {
  if (!ROOT_ELEMENT_TAG.test(documentText)) {
    throw new Error("The renderer document has no <html> tag to stamp the appearance on.");
  }
  const { attributes, styleProperties } = composeRootAppearance(stamp.record, stamp.platformScheme);
  const style = Object.entries(styleProperties)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  const rootAttributes = [
    ...Object.entries(attributes).flatMap(([name, value]) =>
      value === undefined ? [] : [`${name}="${value}"`],
    ),
    ...(stamp.isSafeStart ? [SAFE_START_ATTRIBUTE] : []),
    `style="${style}"`,
  ];
  return documentText.replace(
    ROOT_ELEMENT_TAG,
    (_tag, existing: string) => `<html${existing} ${rootAttributes.join(" ")}>`,
  );
}
