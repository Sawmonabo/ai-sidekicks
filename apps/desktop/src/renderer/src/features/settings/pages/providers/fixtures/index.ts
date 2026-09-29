// The provider-account shell's door, which carries the shell's stylesheet.
//
// A stylesheet enters through the barrel of the directory that owns it and through no
// component, so `AccountsShell.tsx` does not import its own rules; a composition that
// mounts the shell takes the component and its sheet from here.

import "./accounts-fixture-body.css";

export { AccountsShell } from "./AccountsFixtureBody.js";
