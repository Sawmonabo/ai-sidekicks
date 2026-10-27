//! JSON text a provider sends, repaired so that every line a provider writes parses: bytes that
//! are not UTF-8 become U+FFFD, and a lone UTF-16 surrogate escape, which a provider written in
//! JavaScript writes and `serde_json` refuses, becomes `\uFFFD`.

use std::borrow::Cow;

use memchr::memchr;

// The length of a `\uXXXX` escape, in bytes.
const UNICODE_ESCAPE_LEN: usize = 6;

/// Provider-sent JSON `bytes` as text, with invalid UTF-8 and lone surrogate escapes repaired to
/// U+FFFD and nothing else changed. Borrows `bytes` when nothing needs repair.
pub fn decode_inbound_json(bytes: &[u8]) -> Cow<'_, str> {
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

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::fmt::Write;

    use proptest::prelude::*;
    use rstest::rstest;

    use super::decode_inbound_json;

    #[rstest]
    #[case::pair(br"\uD83D\uDE00", r"\uD83D\uDE00")]
    #[case::lone_high(br"\uD800", r"\uFFFD")]
    #[case::lone_low(br"\uDC00", r"\uFFFD")]
    #[case::high_before_short_escape(br"\uD800\n", r"\uFFFD\n")]
    #[case::high_before_pair(br"\uD800\uD800\uDC00", r"\uFFFD\uD800\uDC00")]
    #[case::low_before_high(br"\uDC00\uD800", r"\uFFFD\uFFFD")]
    #[case::escaped_solidus_before_u(br"\\uD800", r"\\uD800")]
    #[case::escaped_solidus_before_lone(br"\\\uD800", r"\\\uFFFD")]
    #[case::high_before_escaped_solidus(br"\uD800\\uDC00", r"\uFFFD\\uDC00")]
    #[case::lower_case_pair(br"\ud800\udc00", r"\ud800\udc00")]
    #[case::lower_case_lone(br"\ud800", r"\uFFFD")]
    #[case::invalid_utf8(b"\xF0\x80\x80\x41\xE2\x82", "\u{FFFD}\u{FFFD}\u{FFFD}A\u{FFFD}")]
    fn a_json_string_reads_with_each_lone_surrogate_repaired(
        #[case] inside: &[u8],
        #[case] expected: &str,
    ) {
        let line = [b"\"", inside, b"\""].concat();

        let decoded = decode_inbound_json(&line);

        assert_eq!(*decoded, format!("\"{expected}\""));
        // Text that needs no repair is the provider's own bytes, never a copy.
        assert_eq!(
            matches!(decoded, Cow::Borrowed(_)),
            inside == expected.as_bytes()
        );
        serde_json::from_str::<String>(&decoded).expect("the repaired line parses");
    }

    // One UTF-16 unit as a JSON string holds it: a printable ASCII unit raw when `is_escaped` is
    // false, else a `\uXXXX` escape in the hex case `is_upper_case` picks.
    fn write_unit(json: &mut String, unit: u16, is_escaped: bool, is_upper_case: bool) {
        match char::from_u32(u32::from(unit)) {
            Some('\\') if !is_escaped => json.push_str(r"\\"),
            Some('"') if !is_escaped => json.push_str(r#"\""#),
            Some(character @ ' '..='~') if !is_escaped => json.push(character),
            _ if is_upper_case => write!(json, "\\u{unit:04X}").expect("a String takes any text"),
            _ => write!(json, "\\u{unit:04x}").expect("a String takes any text"),
        }
    }

    proptest! {
        #[test]
        fn any_utf16_sequence_reads_with_each_lone_surrogate_repaired(
            units in proptest::collection::vec(
                (
                    prop_oneof![any::<u16>(), 0xD800_u16..=0xDFFF, 0x20_u16..=0x7E],
                    any::<bool>(),
                    any::<bool>(),
                ),
                0..32,
            ),
        ) {
            let mut json = String::from("\"");
            for &(unit, is_escaped, is_upper_case) in &units {
                write_unit(&mut json, unit, is_escaped, is_upper_case);
            }
            json.push('"');

            let decoded = decode_inbound_json(json.as_bytes());

            let units: Vec<u16> = units.iter().map(|&(unit, _, _)| unit).collect();
            prop_assert_eq!(
                serde_json::from_str::<String>(&decoded).ok(),
                Some(String::from_utf16_lossy(&units)),
                "{}",
                json
            );
        }
    }
}
