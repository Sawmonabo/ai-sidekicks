//! The allocator macOS and Linux run, mimalloc: the value a program declares as its global
//! allocator, the call that hands freed memory back, and the allocator tree-sitter's C code takes.

use std::alloc::{Layout, handle_alloc_error};
use std::ffi::c_void;
use std::sync::Once;

use libmimalloc_sys::{mi_calloc, mi_collect, mi_free, mi_malloc, mi_realloc, mi_thread_init};
use mimalloc::MiMalloc;
use tree_sitter::Allocator;

/// The global allocator's type, mimalloc on macOS and Linux; a program declares it once, as
/// `#[global_allocator] static GLOBAL_ALLOCATOR: GlobalAllocator = GLOBAL_ALLOCATOR;`.
pub type GlobalAllocator = MiMalloc;

/// The global allocator a program's `#[global_allocator]` static holds.
pub const GLOBAL_ALLOCATOR: GlobalAllocator = MiMalloc;

// Set once, so a second install finds tree-sitter already pointed at mimalloc.
static TREE_SITTER_ALLOCATOR: Once = Once::new();

/// Hands the memory mimalloc holds freed back to the system: every arena's freed pages, from any
/// thread, and the calling thread's own heap.
pub fn collect_freed_memory() {
    // A thread that never allocated has no heap set up, and mimalloc's collect returns before its
    // arena purge there, so the heap is set up first.
    // SAFETY: both take no pointer; the init does nothing on a thread already set up.
    unsafe {
        mi_thread_init();
        mi_collect(true);
    }
}

/// Points tree-sitter's C allocations at mimalloc, once; called at start before any other
/// tree-sitter call, and a later call does nothing. The bash grammar's scanner keeps the system
/// `calloc`, which is safe because each allocator frees only what it allocated.
pub fn install_tree_sitter_allocator() {
    TREE_SITTER_ALLOCATOR.call_once(|| {
        let allocator = Allocator {
            malloc: allocate,
            calloc: allocate_zeroed,
            realloc: reallocate,
            free: release,
        };
        // SAFETY: the four calls are mimalloc's, one allocator family; each answers a block for
        // any non-zero request or ends the process; mimalloc aligns every block as `malloc` does;
        // and `Once` runs this one time, before the caller makes any other tree-sitter call.
        unsafe { tree_sitter::set_allocator(Some(allocator)) }
    });
}

// `malloc` for tree-sitter: a block of `size` bytes, never null when `size` is not zero.
extern "C" fn allocate(size: usize) -> *mut c_void {
    // SAFETY: `mi_malloc` takes any size and answers a block or null.
    let block = unsafe { mi_malloc(size) };
    if size > 0 && block.is_null() {
        fail_allocation(size);
    }
    block
}

// `calloc` for tree-sitter: `count` zeroed items of `size` bytes, never null when `count` is not
// zero.
extern "C" fn allocate_zeroed(count: usize, size: usize) -> *mut c_void {
    // SAFETY: `mi_calloc` takes any count and size and answers a zeroed block or null.
    let block = unsafe { mi_calloc(count, size) };
    if count > 0 && block.is_null() {
        fail_allocation(count.saturating_mul(size));
    }
    block
}

// `realloc` for tree-sitter: `block` moved to `size` bytes, never null when `size` is not zero.
unsafe extern "C" fn reallocate(block: *mut c_void, size: usize) -> *mut c_void {
    // SAFETY: tree-sitter passes null or a block one of these calls allocated.
    let moved = unsafe { mi_realloc(block, size) };
    if size > 0 && moved.is_null() {
        fail_allocation(size);
    }
    moved
}

// `free` for tree-sitter.
unsafe extern "C" fn release(block: *mut c_void) {
    // SAFETY: tree-sitter passes null or a block one of these calls allocated.
    unsafe { mi_free(block) }
}

// Ends the process the way Rust does when an allocation of `bytes` fails.
fn fail_allocation(bytes: usize) -> ! {
    let alignment = align_of::<libc::max_align_t>();
    handle_alloc_error(
        Layout::from_size_align(bytes, alignment)
            .unwrap_or_else(|_| Layout::new::<libc::max_align_t>()),
    )
}

#[cfg(test)]
mod tests {
    use std::ptr;
    use std::sync::mpsc;

    use libmimalloc_sys::{mi_free, mi_malloc};

    use super::collect_freed_memory;
    use crate::process_footprint;

    const BURST_BYTES: usize = 64 * 1024 * 1024;

    fn footprint_bytes() -> u64 {
        process_footprint()
            .expect("the system reports the footprint")
            .current_bytes
    }

    // A burst freed on a thread that stays alive, as a runtime worker does, is handed back by a
    // collect on another thread that never allocated through mimalloc, as the daemon's idle collect
    // runs on a fresh blocking thread. Killed by dropping the thread's init from the collect:
    // mimalloc's collect then returns before its arena purge and the footprint does not move.
    #[test]
    fn a_collect_on_a_fresh_thread_hands_back_a_burst_a_live_thread_freed() {
        let (freed, has_freed) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let burst = std::thread::spawn(move || {
            // SAFETY: the block is checked, written within its length, then freed once.
            unsafe {
                let block = mi_malloc(BURST_BYTES);
                assert!(!block.is_null(), "mimalloc answers the burst");
                ptr::write_bytes(block.cast::<u8>(), 1, BURST_BYTES);
                mi_free(block);
            }
            freed.send(()).expect("the test waits for the free");
            // The thread lives on, its heap set up, until the test has read the footprint.
            released.recv().expect("the test releases the thread");
        });
        has_freed.recv().expect("the burst is freed");
        let before = footprint_bytes();

        std::thread::spawn(collect_freed_memory)
            .join()
            .expect("the collect's thread ends");

        let after = footprint_bytes();
        release.send(()).expect("the burst's thread waits");
        burst.join().expect("the burst's thread ends");
        assert!(
            after + 48 * 1024 * 1024 <= before,
            "the footprint was {before} bytes before the collect and {after} after"
        );
    }
}
