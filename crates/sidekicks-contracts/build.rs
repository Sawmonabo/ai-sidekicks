//! Gives the workflow checks' WebAssembly module a 64 KiB stack in place of the linker's 1 MiB
//! default: the checks keep their graphs and findings on the heap, so the stack holds only call
//! frames, and an instance's memory starts at seven 64 KiB pages instead of twenty-two.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").is_ok_and(|arch| arch == "wasm32") {
        println!("cargo::rustc-link-arg-cdylib=-zstack-size=65536");
    }
}
