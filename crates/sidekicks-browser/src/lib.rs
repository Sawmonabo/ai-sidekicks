//! The one browser runtime the agents' browser tools and the preview screen share: the
//! debug-protocol transport, the headless browser, snapshots, the screencast, saves, choosers,
//! site data and the browser tool set, with the preview's serving pieces, the page store, the
//! relay to main and dev-server discovery. It sits above queue and approval and below the
//! program, which keeps the `preview.*` handlers and hands it the gateway's outbound call, the
//! machine settings watch, the tool set's registration and the listening-ports read as ports or
//! values.

pub mod cdp;
pub mod choosers;
pub mod dev_servers;
pub mod headless;
pub mod host;
pub mod input_owner;
pub mod marks;
pub mod page_link;
pub mod pages;
pub mod relay;
pub mod saves;
pub mod screencast;
pub mod site_data;
pub mod snapshot;
pub mod tools;
