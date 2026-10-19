//! Windows' C runtime's text mode turned off for standard input and output.

use std::ffi::c_int;
use std::io;

// The C runtime's binary mode, `_O_BINARY`.
const BINARY_MODE: c_int = 0x8000;

// The descriptors of standard input and output in the C runtime.
const STANDARD_INPUT: c_int = 0;
const STANDARD_OUTPUT: c_int = 1;

unsafe extern "C" {
    // The C runtime's mode switch for an open descriptor; answers the old mode, or -1 with `errno`.
    fn _setmode(descriptor: c_int, mode: c_int) -> c_int;
}

/// Puts the C runtime's standard input and output in binary mode. Fails with `InvalidInput` when
/// the C runtime refuses, as for a stream that is not open.
pub(crate) fn set_binary_standard_streams() -> io::Result<()> {
    for descriptor in [STANDARD_INPUT, STANDARD_OUTPUT] {
        // SAFETY: the call takes two integers and changes only the descriptor's translation mode.
        if unsafe { _setmode(descriptor, BINARY_MODE) } == -1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("the C runtime kept descriptor {descriptor} in text mode"),
            ));
        }
    }
    Ok(())
}
