// One string standing for a tuple of free-form segments, and never for two tuples.
//
// WHY A SEPARATOR IS NOT ENOUGH. A key built by joining segments on a space, a colon,
// or a slash is injective only while no segment can contain that character — and the
// segments the console keys on are wire strings it does not author: a repository path,
// an MCP server name an operator typed, a provider's own limit identifier. Under a
// space join `("/repo one", "server")` and `("/repo", "one server")` are the same key,
// which is two React rows sharing one identity and one row's settlement landing on the
// other's control. The defect is silent in both directions: nothing throws, and the
// two rows look right until the day a path has a space in it.
//
// SO THE ENCODING IS DELIMITED RATHER THAN JOINED. `JSON.stringify` over the segment
// array is injective over string tuples because JSON escapes the quote and the
// backslash it uses as its own delimiters, so no segment can spell the structure
// around it — and it is total for an array of strings, so there is no input this
// refuses. It also separates ARITY: a two-segment tuple and a three-segment one whose
// third segment is empty are different keys, which is what lets a caller encode a
// union arm that carries one member fewer without substituting a stand-in value for
// the member its arm does not have.
//
// IT IS NOT A HASH AND NOT AN IDENTIFIER. Nothing decodes it, nothing displays it, and
// it crosses no wire: it is a `Map` key and a React `key`, so what it owes is
// injectivity and stability within one window, and both are properties of the encoding
// rather than of a digest nobody could check.
//
// AT THE FLOOR because its readers sit at two different heights on the console's DAG —
// `bridge/quotas/`'s `(accountId, limitId)` reading key and `settings/`'s
// scope-qualified MCP binding key — and neither of those families may reach the other.

/**
 * The one string that identifies this tuple of segments.
 *
 * @param segments The tuple, in a fixed order the caller decides. Order is part of the
 * identity: a caller that reorders its segments mints different keys for the same
 * subject, so the order belongs beside the call rather than being sorted here.
 */
export function structuralKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}
