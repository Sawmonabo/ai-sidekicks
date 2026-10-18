//! The daemon's integration tests, one binary, each behavior a module.

#[global_allocator]
static GLOBAL_ALLOCATOR: sidekicks_platforms::GlobalAllocator =
    sidekicks_platforms::GLOBAL_ALLOCATOR;

mod recovery;
#[cfg(windows)]
mod spawn_cwd_translator;
