fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let root = std::path::PathBuf::from(
            std::env::var_os("NODE_MOBILE_ROOT")
                .expect("NODE_MOBILE_ROOT must point to the extracted nodejs-mobile Android release"),
        );
        let abi = std::env::var("ANDROID_ABI").unwrap_or_else(|_| "arm64-v8a".into());
        cc::Build::new()
            .cpp(true)
            .file("src/node_host.cc")
            .include(root.join("include/node"))
            .flag_if_supported("-std=c++17")
            .compile("nasty_node_host");
        println!("cargo:rustc-link-search=native={}", root.join("bin").join(&abi).display());
        println!("cargo:rustc-link-lib=dylib=node");
        println!("cargo:rerun-if-changed=src/node_host.cc");
        println!("cargo:rerun-if-env-changed=NODE_MOBILE_ROOT");
        println!("cargo:rerun-if-env-changed=ANDROID_ABI");
    }
}
