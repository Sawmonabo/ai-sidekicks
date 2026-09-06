// The honest-chrome plane's door.
//
// A sub-module door inside `frame/`, and it publishes exactly three symbols because
// exactly three leave: the strip the frame mounts, the binding that fills it, and the
// action its offline banner offers. The chip, the banners, the notices, and every
// sentence they say are this module's own and are reached from inside it.
//
// THE STATE IS NOT HERE. It lives on the frame store, because the palette and the
// settings pages read it too and they sit on the other side of this family in the
// console DAG — a view family may not import a sub-module door at all, and the
// frame's own door would close a cycle. The vocabulary and the two sentences both
// sides say therefore live in `store/shell-state.ts`, which is the lowest family that
// owns the inputs.
//
// The sheet enters here, so a consumer cannot mount a component whose CSS did not
// arrive with it, and the bundler sees one edge for the whole module.

import "./shell-state.css";

export { ShellChrome } from "./ShellChrome.js";
export { useDaemonStartAction, useShellStateBinding } from "./shell-status-binding.js";
