//! A helper mode's error output: the line the mode writes there, and the tail of it the daemon
//! keeps, which the child's failure carries in its message.

use std::io::{self, Write as _};

use tokio::io::{AsyncRead, AsyncReadExt};

// How many bytes one read of the error output takes.
const ERROR_OUTPUT_READ_BYTES: usize = 8 * 1024;

/// Writes `line` to the mode's standard error. A failed write is dropped: nothing is left to tell,
/// and the mode's exit status still says it failed.
pub(crate) fn write_error_line(line: &str) {
    if let Err(error) = writeln!(io::stderr().lock(), "{line}") {
        drop(error);
    }
}

/// The last `kept_bytes` of `stream`, read to its end, decoded lossily once, starting on a whole
/// character and trimmed of white space at either end. Fails with the read's error.
pub(crate) async fn read_error_output_tail(
    mut stream: impl AsyncRead + Unpin,
    kept_bytes: usize,
) -> io::Result<String> {
    let mut kept = Vec::new();
    let mut chunk = [0_u8; ERROR_OUTPUT_READ_BYTES];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..read]);
        // Trimmed only past twice the bound, so a long stream is not shifted on every read.
        if kept.len() > 2 * kept_bytes {
            kept.drain(..kept.len() - kept_bytes);
        }
    }
    let mut start = kept.len().saturating_sub(kept_bytes);
    // A cut inside a character moves on to the next character's first byte.
    while kept.get(start).is_some_and(|byte| byte & 0xC0 == 0x80) {
        start += 1;
    }
    Ok(String::from_utf8_lossy(&kept[start..]).trim().to_owned())
}
