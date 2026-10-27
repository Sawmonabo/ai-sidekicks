//! The daemon's one lock of a `std` mutex, for state no holder leaves half-changed when it panics.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks `mutex`, taking its value as a panicking holder left it rather than failing on the poison;
/// only for a value every change keeps whole, since a holder's panic is otherwise ignored.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
