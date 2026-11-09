//! What the keychain tool prints of an item, read back into bytes: the password line
//! `find-generic-password -g` writes to its standard error, and the attributes `dump-keychain`
//! lists. The tool prints every value one way: a value with a byte outside 0x20 to 0x7E, or a `\`,
//! as `0x` and its bytes in uppercase hex, then a copy for the eye after a space; any other value
//! between double quotes, as it is. `<NULL>` is an attribute that holds nothing.

use secrecy::zeroize::Zeroizing;

// What leads the password line on the tool's standard error.
const PASSWORD_LEAD: &[u8] = b"password: ";

/// One generic password a dump lists, by its service and account, with whether its creator code
/// is `creator`.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct ListedItem {
    /// The service the item is filed under.
    pub(super) service: String,
    /// The account the item is filed under.
    pub(super) account: String,
    /// Whether the item carries the creator code asked about.
    pub(super) has_creator: bool,
}

/// The item's bytes from the password line on `errors`, the tool's standard error, the last such
/// line where several are; `None` where no line reads as a printed value.
pub(super) fn password_from_errors(errors: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let line = errors
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(PASSWORD_LEAD))
        .next_back()?;
    printed_value(line)
}

/// Every generic password `dump` lists, the tool's `dump-keychain` output, whose service and
/// account are text, each with whether its creator code is `creator`.
pub(super) fn listed_items(dump: &[u8], creator: &[u8]) -> Vec<ListedItem> {
    let mut items = Vec::new();
    let mut item = PrintedItem::default();
    for line in dump.split(|byte| *byte == b'\n') {
        if line.starts_with(b"keychain: ") {
            items.extend(item.listed(creator));
            item = PrintedItem::default();
        } else if let Some(class) = line.strip_prefix(b"class: ") {
            item.is_generic_password = class == b"\"genp\"";
        } else if let Some(value) = attribute(line, b"\"svce\"<blob>=") {
            item.service = printed_value(value);
        } else if let Some(value) = attribute(line, b"\"acct\"<blob>=") {
            item.account = printed_value(value);
        } else if let Some(value) = attribute(line, b"\"crtr\"<uint32>=") {
            item.creator = printed_value(value);
        }
    }
    items.extend(item.listed(creator));
    items
}

// One item's lines in a dump, as far as they are read.
#[derive(Default)]
struct PrintedItem {
    is_generic_password: bool,
    service: Option<Zeroizing<Vec<u8>>>,
    account: Option<Zeroizing<Vec<u8>>>,
    creator: Option<Zeroizing<Vec<u8>>>,
}

impl PrintedItem {
    // The item as listed, `None` unless it is a generic password whose service and account are
    // text.
    fn listed(self, creator: &[u8]) -> Option<ListedItem> {
        if !self.is_generic_password {
            return None;
        }
        let text = |name: Option<Zeroizing<Vec<u8>>>| {
            name.and_then(|name| String::from_utf8(name.to_vec()).ok())
        };
        Some(ListedItem {
            has_creator: self.creator.is_some_and(|code| code.as_slice() == creator),
            service: text(self.service)?,
            account: text(self.account)?,
        })
    }
}

// The value of the attribute `lead` names on `line`, which the dump indents.
fn attribute<'line>(line: &'line [u8], lead: &[u8]) -> Option<&'line [u8]> {
    line.trim_ascii_start().strip_prefix(lead)
}

// The bytes `printed` stands for: hex after `0x` up to the first space, else the text between the
// two double quotes; `None` for `<NULL>` and for anything else.
fn printed_value(printed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    if let Some(hex) = printed.strip_prefix(b"0x") {
        let hex = hex.split(|byte| *byte == b' ').next().unwrap_or_default();
        let mut bytes = Zeroizing::new(vec![0; hex.len() / 2]);
        let decoded = base16ct::upper::decode(hex, &mut bytes).ok()?.len();
        bytes.truncate(decoded);
        return Some(bytes);
    }
    if printed.is_empty() {
        return Some(Zeroizing::new(Vec::new()));
    }
    let text = printed.strip_prefix(b"\"")?.strip_suffix(b"\"")?;
    Some(Zeroizing::new(text.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::{ListedItem, listed_items, password_from_errors};

    /// A dump in the tool's form lists each generic password by its service and account, a
    /// name printed as hex decoded, its creator code read, and a key or an internet password left
    /// out. Mutations: drop the class check; read a hex name as its text copy.
    #[test]
    fn a_dump_lists_each_generic_password_with_its_creator() {
        let dump = concat!(
            "keychain: \"/Users/person/Library/Keychains/login.keychain-db\"\n",
            "version: 512\n",
            "class: \"genp\"\n",
            "attributes:\n",
            "    0x00000007 <blob>=\"service\"\n",
            "    \"acct\"<blob>=\"plain\"\n",
            "    \"crtr\"<uint32>=\"aisk\"\n",
            "    \"svce\"<blob>=\"service\"\n",
            "keychain: \"/Users/person/Library/Keychains/login.keychain-db\"\n",
            "class: \"genp\"\n",
            "attributes:\n",
            "    \"acct\"<blob>=0x615C62  \"a\\134b\"\n",
            "    \"crtr\"<uint32>=<NULL>\n",
            "    \"svce\"<blob>=\"service\"\n",
            "keychain: \"/Users/person/Library/Keychains/login.keychain-db\"\n",
            "class: \"inet\"\n",
            "attributes:\n",
            "    \"acct\"<blob>=\"web\"\n",
            "    \"svce\"<blob>=\"service\"\n",
            "keychain: \"/Users/person/Library/Keychains/login.keychain-db\"\n",
            "class: 0x00000010 \n",
            "attributes:\n",
        );
        assert_eq!(
            listed_items(dump.as_bytes(), b"aisk"),
            [
                ListedItem {
                    service: "service".to_owned(),
                    account: "plain".to_owned(),
                    has_creator: true,
                },
                ListedItem {
                    service: "service".to_owned(),
                    account: "a\\b".to_owned(),
                    has_creator: false,
                },
            ]
        );
    }

    /// The password line reads back the item's bytes in either printed form, an empty item
    /// included, and a value that is itself hex text stays text. Mutations: decode the quoted
    /// form as hex; read the text copy after the hex.
    #[test]
    fn the_password_line_reads_back_the_items_bytes() {
        let read =
            |errors: &str| password_from_errors(errors.as_bytes()).map(|bytes| bytes.to_vec());
        assert_eq!(read("password: \"00ff\"\n"), Some(b"00ff".to_vec()));
        assert_eq!(
            read("password: 0x00FF63  \"\\000\\377c\"\n"),
            Some(vec![0x00, 0xFF, b'c'])
        );
        assert_eq!(read("password: 0x0A0B \n"), Some(vec![0x0A, 0x0B]));
        assert_eq!(read("password: \n"), Some(Vec::new()));
        assert_eq!(read("security: no such item\n"), None);
    }
}
