//! The daemon's integration tests, one binary, each behavior a module.

#[global_allocator]
static GLOBAL_ALLOCATOR: sidekicks_platforms::GlobalAllocator =
    sidekicks_platforms::GLOBAL_ALLOCATOR;

mod helpers;
mod recovery;
mod shell_mode;
mod spawn_cwd_translator;
