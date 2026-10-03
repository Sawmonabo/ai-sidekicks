/**
 * Who owns every body the repos feature registers. The registries use an owner-scoped
 * duplicate policy: the same owner re-registering (a hot reload) replaces, another owner
 * claiming a taken key raises, so drifting literals would turn a reload into a conflict.
 */
export const REPOS_FEATURE_OWNER = "repos";
