// Reading a renderer switch: a `--name=value` argument main passes a window through
// `webPreferences.additionalArguments`, its value URI-encoded, which the sandboxed preload reads
// off its own `process.argv`.

/** The decoded value of the switch `prefix` names, or `undefined` when the window has none. */
export function readSwitchValue(argv: readonly string[], prefix: string): string | undefined {
  const argument = argv.find((candidate) => candidate.startsWith(prefix));
  return argument === undefined ? undefined : decodeURIComponent(argument.slice(prefix.length));
}

/** The decoded value of the switch `prefix` names. Throws when the window was started without it. */
export function readRequiredSwitchValue(argv: readonly string[], prefix: string): string {
  const value = readSwitchValue(argv, prefix);
  if (value === undefined) {
    throw new RangeError(`The window was started without ${prefix.slice(0, -1)}.`);
  }
  return value;
}
