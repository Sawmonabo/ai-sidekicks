// The transcript's eager sheet, loaded with the composition root: `transcript.css` styles
// the `.meridian-ledger-surface` wrapper the eagerly registered workspace screen draws,
// so it cannot wait for the lazy pane chunk.

import "@renderer/features/transcript/transcript.css";

export { registerLedger } from "@renderer/features/transcript/contributions/screens.js";
