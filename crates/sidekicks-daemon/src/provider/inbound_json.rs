//! JSON text a provider sends, repaired where `serde_json` refuses what Node reads: bytes that are
//! not UTF-8 become U+FFFD, and a lone UTF-16 surrogate escape becomes `\uFFFD`.

use std::borrow::Cow;

use memchr::memchr;

// The length of a `\uXXXX` escape, in bytes.
const UNICODE_ESCAPE_LEN: usize = 6;

/// Provider-sent JSON `bytes` as text, with invalid UTF-8 and lone surrogate escapes repaired to
/// U+FFFD and nothing else changed. Borrows `bytes` when nothing needs repair.
pub(crate) fn decode_inbound_json(bytes: &[u8]) -> Cow<'_, str> {
    let text = String::from_utf8_lossy(bytes);
    // In valid JSON a reverse solidus only starts an escape, so text without one has none.
    if memchr(b'\\', text.as_bytes()).is_none() {
        return text;
    }
    let lone_surrogates = find_lone_surrogate_escapes(text.as_bytes());
    if lone_surrogates.is_empty() {
        return text;
    }
    let mut text = text.into_owned();
    for start in lone_surrogates {
        // Six ASCII bytes over six ASCII bytes, so every other offset stays put.
        text.replace_range(start..start + UNICODE_ESCAPE_LEN, "\\uFFFD");
    }
    Cow::Owned(text)
}

// The byte offset of each `\uD800`–`\uDFFF` escape that is not half of a pair: a high surrogate
// kept only when a low surrogate escape follows at once. Each escape is walked as one unit, so the
// `\\u` of an escaped reverse solidus is never read as an escape of its own.
fn find_lone_surrogate_escapes(bytes: &[u8]) -> Vec<usize> {
    let mut lone_surrogates = Vec::new();
    let mut pending_high: Option<usize> = None;
    let mut position = 0;
    while let Some(offset) = bytes.get(position..).and_then(|rest| memchr(b'\\', rest)) {
        let start = position + offset;
        let unit = read_unicode_escape(bytes, start);
        if let Some(high) = pending_high.take() {
            if start == high + UNICODE_ESCAPE_LEN && unit.is_some_and(is_low_surrogate) {
                position = start + UNICODE_ESCAPE_LEN;
                continue;
            }
            lone_surrogates.push(high);
        }
        match unit {
            Some(unit) if is_high_surrogate(unit) => {
                pending_high = Some(start);
                position = start + UNICODE_ESCAPE_LEN;
            }
            Some(unit) if is_low_surrogate(unit) => {
                lone_surrogates.push(start);
                position = start + UNICODE_ESCAPE_LEN;
            }
            Some(_) => position = start + UNICODE_ESCAPE_LEN,
            // `\\`, `\"`, `\/`, `\b`, `\f`, `\n`, `\r` and `\t` are two bytes each.
            None => position = start + 2,
        }
    }
    lone_surrogates.extend(pending_high);
    lone_surrogates
}

// The UTF-16 unit of the `\uXXXX` escape at `start`, or `None` when no such escape starts there.
fn read_unicode_escape(bytes: &[u8], start: usize) -> Option<u16> {
    let escape = bytes.get(start..start + UNICODE_ESCAPE_LEN)?;
    if escape[1] != b'u' {
        return None;
    }
    escape[2..].iter().try_fold(0_u16, |unit, &digit| {
        let value = char::from(digit).to_digit(16)?;
        Some((unit << 4) | u16::try_from(value).expect("a hex digit is at most 15"))
    })
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}
