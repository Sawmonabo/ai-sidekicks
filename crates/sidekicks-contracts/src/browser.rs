//! The machine-wide browser methods behind Settings › Browser. Site data is one set per machine,
//! shared by every Preview page, the agent's browser tools and a workflow's browser steps. Every
//! per-site act takes one origin and applies to its whole registrable domain, so a login cookie set
//! on the parent domain goes with it.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;

use crate::method::methods;
use crate::typescript::{Definition, TypeScriptModule};
use crate::web_address::web_address_fault;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::BoundedText;
use crate::wire::{NullableSchema, True, literal, nullable};

/// A site's origin, `scheme://host` with a port only where it is not the scheme's own: an `http:`
/// or `https:` origin with no credentials, no path, no query and no fragment, exactly as the
/// WHATWG parser serializes it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SiteOrigin(String);

impl SiteOrigin {
    /// `text` when it is a web origin written exactly as the parser serializes it, else `None`.
    pub fn new(text: String) -> Option<Self> {
        let address = Url::parse(&text).ok()?;
        let is_origin =
            web_address_fault(&address).is_none() && address.origin().ascii_serialization() == text;
        is_origin.then_some(Self(text))
    }

    /// The origin.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SiteOrigin {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom("origin must be an http(s) origin, scheme://host[:port]")
        })
    }
}

impl JsonSchema for SiteOrigin {
    fn schema_name() -> Cow<'static, str> {
        "SiteOrigin".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A site's origin: an http(s) origin, scheme://host[:port].",
            "type": "string",
            "format": "site-origin",
        })
    }
}

/// Settings › Browser's list read, its clear-all and the Chromium methods: machine-wide, so they
/// name nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserMachineRequest {}

/// One site holding saved data. `hasCookies` is true while it holds at least one unexpired cookie,
/// and the row then reads `Saved cookies`; otherwise it holds other saved data and reads `Saved
/// site data`. Nothing here says whether the person is signed in, because a cookie does not prove
/// a login.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct BrowserSiteData {
    /// The site.
    pub origin: SiteOrigin,
    /// How much it saved, in bytes.
    pub size_bytes: SafeInt<0>,
    /// When it was last used.
    #[garde(dive)]
    pub last_used_at: WireInstant,
    /// Whether it holds an unexpired cookie.
    pub has_cookies: bool,
}

/// Every site with saved data, one per registrable domain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSiteDataListResponse {
    /// The sites.
    #[garde(dive)]
    pub sites: Vec<BrowserSiteData>,
}

/// Names one site: sign in to it, clear its cookies, or forget it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSiteRequest {
    /// The site.
    pub origin: SiteOrigin,
}

/// The site opened in a page of its own that belongs to no session, over the machine's site data,
/// showing the address line and nothing else. What the site saves there is kept for every browser.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSiteSignInResponse {
    /// Always true.
    pub opened: True,
}

/// The site's cookies are gone across its registrable domain, and nothing else: its storage, cache
/// and service workers stay. It claims nothing about signing out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSiteCookiesClearResponse {
    /// The site.
    pub origin: SiteOrigin,
    /// Always true.
    pub cleared: True,
}

/// Every kind of data the site saved is gone; a site holding nothing answers the same.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSiteDataForgetResponse {
    /// The site.
    pub origin: SiteOrigin,
    /// Always true.
    pub forgotten: True,
}

/// Every site's saved data is gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSiteDataClearResponse {
    /// Always true.
    pub cleared: True,
}

/// An installed Chromium that runs pages: the desktop app's own, or an installed Chrome or Edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserInstalledChromiumSource {
    /// The desktop app's own.
    Desktop,
    /// An installed Chrome.
    Chrome,
    /// An installed Edge.
    Edge,
}

literal! {
    /// The Chromium the service fetched on first need, Chrome for Testing.
    pub enum BrowserFetchedChromiumSource = "chrome-for-testing";
}

/// Why the daemon's headless Chromium cannot start on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BrowserChromiumCannotStartReason {
    /// The system lacks libraries it needs.
    MissingSystemLibraries,
}

/// The headless Chromium cannot start. `installStep` is the command that installs what it needs
/// for the version the service carries, shown as text and never run, because it needs an
/// administrator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserChromiumCannotStart {
    /// Why.
    pub reason: BrowserChromiumCannotStartReason,
    /// The command that fixes it.
    pub install_step: BoundedText<1, { usize::MAX }>,
}

/// Declares one form of the Chromium reading: its source and when it was fetched, then the members
/// both forms share.
macro_rules! chromium_reading {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            $($own)*
            /// Its version.
            pub version: BoundedText<1, { usize::MAX }>,
            /// Why the headless Chromium cannot start here, or `null`.
            #[serde(deserialize_with = "nullable")]
            #[schemars(with = "NullableSchema<BrowserChromiumCannotStart>")]
            pub cannot_start: Option<BrowserChromiumCannotStart>,
        }
    };
}

chromium_reading! {
    /// The Chromium the service fetched, with when it was fetched.
    pub struct FetchedChromiumReading {
        /// The fetched Chromium.
        pub source: BrowserFetchedChromiumSource,
        /// When it was fetched.
        #[garde(dive)]
        pub fetched_at: WireInstant,
    }
}

chromium_reading! {
    /// An installed Chromium, never fetched.
    pub struct InstalledChromiumReading {
        /// Which one.
        pub source: BrowserInstalledChromiumSource,
        /// Only a fetched Chromium has a fetch time.
        pub fetched_at: (),
    }
}

/// The Chromium in use, its version, and when it was fetched; `fetchedAt` is set exactly when the
/// source is the fetched one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum BrowserChromiumReadResponse {
    /// The fetched Chromium.
    Fetched(#[garde(dive)] FetchedChromiumReading),
    /// An installed Chromium.
    Installed(#[garde(dive)] InstalledChromiumReading),
}

/// The fetch started; its progress is a flow row. A fetch asked for during one joins it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserChromiumFetchResponse {
    /// Always true.
    pub started: True,
}

methods! {
    /// The `browser.*` methods the daemon answers.
    pub const BROWSER_METHOD_DESCRIPTORS = [
        /// Every site with saved data.
        BrowserSiteDataList = query "browser.siteDataList" {
            mutating: false,
            params: BrowserMachineRequest,
            result: BrowserSiteDataListResponse,
            refusals: [],
        },
        /// Opens a site to sign in to it.
        BrowserSiteSignIn = mutation "browser.siteSignIn" {
            mutating: true,
            params: BrowserSiteRequest,
            result: BrowserSiteSignInResponse,
            refusals: [],
        },
        /// Clears a site's cookies.
        BrowserSiteCookiesClear = mutation "browser.siteCookiesClear" {
            mutating: true,
            params: BrowserSiteRequest,
            result: BrowserSiteCookiesClearResponse,
            refusals: [],
        },
        /// Forgets everything a site saved.
        BrowserSiteDataForget = mutation "browser.siteDataForget" {
            mutating: true,
            params: BrowserSiteRequest,
            result: BrowserSiteDataForgetResponse,
            refusals: [],
        },
        /// Clears every site's saved data.
        BrowserSiteDataClear = mutation "browser.siteDataClear" {
            mutating: true,
            params: BrowserMachineRequest,
            result: BrowserSiteDataClearResponse,
            refusals: [],
        },
        /// The Chromium in use.
        BrowserChromiumRead = query "browser.chromiumRead" {
            mutating: false,
            params: BrowserMachineRequest,
            result: BrowserChromiumReadResponse,
            refusals: [],
        },
        /// Fetches Chrome for Testing.
        BrowserChromiumFetch = mutation "browser.chromiumFetch" {
            mutating: true,
            params: BrowserMachineRequest,
            result: BrowserChromiumFetchResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the machine-wide browser methods.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "browser",
    doc: "The machine-wide browser methods behind Settings › Browser.",
    definitions: &[
        Definition::read::<SiteOrigin>().checked(),
        Definition::read::<BrowserMachineRequest>(),
        Definition::read::<BrowserSiteData>(),
        Definition::read::<BrowserSiteDataListResponse>(),
        Definition::read::<BrowserSiteRequest>(),
        Definition::read::<BrowserSiteSignInResponse>(),
        Definition::read::<BrowserSiteCookiesClearResponse>(),
        Definition::read::<BrowserSiteDataForgetResponse>(),
        Definition::read::<BrowserSiteDataClearResponse>(),
        Definition::read::<BrowserInstalledChromiumSource>(),
        Definition::read::<BrowserChromiumCannotStartReason>(),
        Definition::read::<BrowserChromiumCannotStart>(),
        Definition::read::<BrowserChromiumReadResponse>().checked(),
        Definition::read::<BrowserChromiumFetchResponse>(),
    ],
    constants: &[],
    method_tables: &[&BROWSER_METHOD_DESCRIPTORS],
};
