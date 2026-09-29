/**
 * Who owns every body the repos feature registers.
 *
 * One binding rather than several literals, and it is load-bearing: the registries carry
 * a `duplicatePolicy` of `"owner-scoped"`, so the owner string decides whether a second
 * registration replaces the first (a hot reload re-running a module) or raises (another
 * feature claiming a taken key). Literals that drifted apart would turn a hot reload into
 * a conflict.
 */
export const REPOS_FAMILY_OWNER = "repos";
