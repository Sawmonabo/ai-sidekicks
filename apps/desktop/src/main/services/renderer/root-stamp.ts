// What main writes onto the served console document's root element, so the first paint is right
// with no script and no read: the appearance record's root (`composeRootAppearance`), its
// attributes, the scheme resolved to light or dark among them, and an inline style, and the
// safe-start mark on a load after repeated renderer crashes. Every value comes from the
// schema-checked record, an enum or a positive number, so none needs escaping.

import { composeRootAppearance, type AppearanceRecord } from "#shared/appearance.js";
import { type ColorScheme } from "#shared/color-scheme.js";
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

/** A `style` attribute the built tag already carries, which the stamp's style is merged into. */
const BUILT_STYLE_ATTRIBUTE = /\sstyle\s*=\s*"([^"]*)"/i;

/**
 * Returns `documentText` with `stamp` added to its `<html>` tag. Throws when the document has no
 * `<html>` tag, which only a broken build produces.
 */
export function stampRootElement(documentText: string, stamp: RootStamp): string {
  if (!ROOT_ELEMENT_TAG.test(documentText)) {
    throw new Error("The renderer document has no <html> tag to stamp the appearance on.");
  }
  const { attributes, styleProperties } = composeRootAppearance(stamp.record, stamp.platformScheme);
  const stampedStyle = Object.entries(styleProperties).map(([name, value]) => `${name}:${value}`);
  return documentText.replace(ROOT_ELEMENT_TAG, (_tag, existing: string) => {
    // The stamp's properties come last, so they win over a built one of the same name.
    const builtStyle = BUILT_STYLE_ATTRIBUTE.exec(existing)?.[1]?.replace(/;\s*$/, "");
    const style = [
      ...(builtStyle === undefined || builtStyle === "" ? [] : [builtStyle]),
      ...stampedStyle,
    ];
    const rootAttributes = [
      ...Object.entries(attributes).flatMap(([name, value]) =>
        value === undefined ? [] : [`${name}="${value}"`],
      ),
      ...(stamp.isSafeStart ? [SAFE_START_ATTRIBUTE] : []),
      `style="${style.join(";")}"`,
    ];
    return `<html${existing.replace(BUILT_STYLE_ATTRIBUTE, "")} ${rootAttributes.join(" ")}>`;
  });
}
