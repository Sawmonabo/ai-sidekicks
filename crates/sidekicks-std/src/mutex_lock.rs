//! The program's one way through a `std` lock's poison, for state no holder leaves half-changed
//! when it panics: a mutex's lock and its sole owner's borrow, a read-write lock's two locks and a
//! condition variable's waits.

use std::sync::{
    Condvar, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard,
};
use std::time::Duration;

/// Locks `mutex`, taking its value as a panicking holder left it rather than failing on the poison;
/// only for a value every change keeps whole, since a holder's panic is otherwise ignored.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The value `mutex` holds, borrowed through its sole owner as a panicking holder left it; the
/// same contract as [`lock`].
pub fn get_mut<T>(mutex: &mut Mutex<T>) -> &mut T {
    mutex.get_mut().unwrap_or_else(PoisonError::into_inner)
}

/// Locks `shared` for reading, taking its value as a panicking writer left it; the same contract
/// as [`lock`].
pub fn read<T>(shared: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    shared.read().unwrap_or_else(PoisonError::into_inner)
}

/// Locks `shared` for writing, taking its value as a panicking writer left it; the same contract
/// as [`lock`].
pub fn write<T>(shared: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    shared.write().unwrap_or_else(PoisonError::into_inner)
}

/// Waits on `condition_variable` with `guard` let go, and answers the guard taken again, poison or
/// not; the same contract as [`lock`].
pub fn wait<'a, T>(condition_variable: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    condition_variable
        .wait(guard)
        .unwrap_or_else(PoisonError::into_inner)
}

/// Waits on `condition_variable` with `guard` let go for at most `bound`, and answers the guard
/// taken again, woken or timed out, poison or not; the same contract as [`lock`].
pub fn wait_timeout<'a, T>(
    condition_variable: &Condvar,
    guard: MutexGuard<'a, T>,
    bound: Duration,
) -> MutexGuard<'a, T> {
    condition_variable
        .wait_timeout(guard, bound)
        .unwrap_or_else(PoisonError::into_inner)
        .0
}
