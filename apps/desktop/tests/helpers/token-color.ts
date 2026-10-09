import { tokenReference } from "#renderer/styles/tokens.js";

/** The color a token resolves to on the document now, as the browser reports a computed color. */
export function computedTokenColor(tokenName: string): string {
  const probe = document.createElement("span");
  probe.style.color = tokenReference(tokenName);
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
