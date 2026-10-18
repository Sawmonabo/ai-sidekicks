//! The allocator Windows runs, the system's own, with the calls macOS and Linux make on mimalloc
//! doing nothing.

use std::alloc::System;

/// The global allocator's type, the system allocator on Windows; a program declares it once, as
/// `#[global_allocator] static GLOBAL_ALLOCATOR: GlobalAllocator = GLOBAL_ALLOCATOR;`.
pub type GlobalAllocator = System;

/// The global allocator a program's `#[global_allocator]` static holds.
pub const GLOBAL_ALLOCATOR: GlobalAllocator = System;

/// Does nothing: Windows runs the system allocator, not the mimalloc this call collects. Never
/// fails.
pub fn collect_freed_memory() {}

/// Does nothing: tree-sitter's default `malloc` is already the system allocator on Windows. Never
/// fails.
pub fn install_tree_sitter_allocator() {}
