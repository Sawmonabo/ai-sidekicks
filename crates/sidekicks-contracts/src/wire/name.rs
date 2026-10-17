//! The wire grammar every method, event and refusal name follows, held at build time: a dotted
//! name is two to four lowerCamelCase segments joined by dots (`agent.queueItem.remove`), and a
//! protocol method is `$/` and lowerCamelCase segments joined by slashes (`$/subscription/cancel`).

/// The most segments a dotted wire name holds.
const WIRE_NAME_SEGMENTS_MAX: usize = 4;

/// Whether `name` is two to four lowerCamelCase segments joined by dots, each segment a lowercase
/// ASCII letter followed by ASCII letters and digits.
pub const fn is_wire_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let mut segments = 1;
    let mut index = 0;
    let mut at_segment_start = true;
    while index < bytes.len() {
        let byte = bytes[index];
        if at_segment_start {
            if !byte.is_ascii_lowercase() {
                return false;
            }
            at_segment_start = false;
        } else if byte == b'.' {
            segments += 1;
            at_segment_start = true;
        } else if !byte.is_ascii_alphanumeric() {
            return false;
        }
        index += 1;
    }
    !at_segment_start && segments >= 2 && segments <= WIRE_NAME_SEGMENTS_MAX
}

/// Whether `name` is `$/` followed by one or more lowerCamelCase segments joined by slashes.
pub const fn is_protocol_method_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'$' || bytes[1] != b'/' {
        return false;
    }
    let mut index = 2;
    let mut at_segment_start = true;
    while index < bytes.len() {
        let byte = bytes[index];
        if at_segment_start {
            if !byte.is_ascii_lowercase() {
                return false;
            }
            at_segment_start = false;
        } else if byte == b'/' {
            at_segment_start = true;
        } else if !byte.is_ascii_alphanumeric() {
            return false;
        }
        index += 1;
    }
    !at_segment_start
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{is_protocol_method_name, is_wire_name};

    #[rstest]
    #[case::two_segments("session.create", true)]
    #[case::camel_resource("agent.queueItem.remove", true)]
    #[case::four_segments("agent.childRun.paused.update", true)]
    #[case::one_segment("session", false)]
    #[case::five_segments("agent.childRun.paused.update.now", false)]
    #[case::snake_case("session.not_found", false)]
    #[case::capital_first("Session.create", false)]
    #[case::capital_segment("session.Create", false)]
    #[case::empty_segment("session..create", false)]
    #[case::trailing_dot("session.", false)]
    #[case::empty("", false)]
    fn a_wire_name_is_two_to_four_lower_camel_case_segments(
        #[case] name: &str,
        #[case] expected: bool,
    ) {
        assert_eq!(is_wire_name(name), expected, "{name}");
    }

    #[rstest]
    #[case::cancel_request("$/cancelRequest", true)]
    #[case::subscription_notify("$/subscription/notify", true)]
    #[case::bare_prefix("$/", false)]
    #[case::dotted("$/subscription.notify", false)]
    #[case::capital("$/Subscription/notify", false)]
    #[case::empty_segment("$/subscription//notify", false)]
    #[case::no_prefix("subscription/notify", false)]
    fn a_protocol_method_is_dollar_slash_and_slash_joined_segments(
        #[case] name: &str,
        #[case] expected: bool,
    ) {
        assert_eq!(is_protocol_method_name(name), expected, "{name}");
    }
}
