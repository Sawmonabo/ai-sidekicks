//! A copy from a reader to a writer that hashes the bytes with SHA-256 as they pass.

use std::io::{self, Read, Write};

use sha2::{Digest as _, Sha256};

// The bytes of a SHA-256 digest.
const SHA256_BYTES: usize = 32;

// The bytes read at a time.
const CHUNK_BYTES: usize = 64 * 1024;

/// Writes every byte of `reader` to `writer`, showing each chunk to `inspect` as it passes, and
/// answers the bytes' SHA-256 digest. A read the system interrupted is tried again. Fails with the
/// read's or the write's error.
pub fn copy_with_sha256(
    reader: &mut impl Read,
    writer: &mut impl Write,
    mut inspect: impl FnMut(&[u8]),
) -> io::Result<[u8; SHA256_BYTES]> {
    let mut hasher = Sha256::new();
    let mut chunk = vec![0; CHUNK_BYTES];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let chunk = &chunk[..read];
        hasher.update(chunk);
        inspect(chunk);
        writer.write_all(chunk)?;
    }
    Ok(hasher.finalize().into())
}
