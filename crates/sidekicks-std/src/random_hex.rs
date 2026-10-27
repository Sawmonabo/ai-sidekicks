//! Random bytes from the system's secure source, written as lowercase hexadecimal: an id that
//! routes a secret, or a suffix that keeps a made name from meeting another.

/// `byte_count` random bytes from the system's secure source as lowercase hexadecimal, two digits
/// a byte. Fails with the source's error when the system gives no random bytes.
pub(crate) fn random_hex(byte_count: usize) -> Result<String, getrandom::Error> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes)?;
    Ok(base16ct::lower::encode_string(&bytes))
}
