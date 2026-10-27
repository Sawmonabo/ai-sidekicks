//! Text read from a byte stream that arrives in chunks: a character a chunk cuts in two waits for
//! the next chunk, and bytes that are not UTF-8 read as U+FFFD once per invalid sequence.

use std::mem;

/// Decodes a stream of bytes, fed chunk by chunk, into text: a UTF-8 sequence a chunk cuts off is
/// held until the next chunk completes it, and each invalid sequence reads as one U+FFFD, as
/// `String::from_utf8_lossy` reads it over the whole stream.
#[derive(Debug, Default)]
pub(crate) struct Utf8StreamDecoder {
    // The start of a sequence the last chunk cut off, at most three bytes.
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    /// Decodes `chunk` after any bytes held from the chunk before, handing `text` each decoded
    /// piece in order; a sequence the chunk cuts off is held for the next one.
    pub(crate) fn push(&mut self, chunk: &[u8], mut text: impl FnMut(&str)) {
        let mut bytes = mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(whole) => {
                    text(whole);
                    return;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text(std::str::from_utf8(valid).expect("the bytes before the error are UTF-8"));
                    let Some(invalid_len) = error.error_len() else {
                        // A sequence the chunk cut off waits for the next chunk.
                        self.pending = after.to_vec();
                        return;
                    };
                    text("\u{FFFD}");
                    rest = &after[invalid_len..];
                }
            }
        }
    }

    /// Ends the stream: a sequence still held, which no chunk completed, reads as one U+FFFD.
    pub(crate) fn finish(self, mut text: impl FnMut(&str)) {
        if !self.pending.is_empty() {
            text("\u{FFFD}");
        }
    }
}
