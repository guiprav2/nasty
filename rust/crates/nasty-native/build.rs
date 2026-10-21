fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        link_ffmpeg();
    }
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

fn link_ffmpeg() {
    println!("cargo:rerun-if-changed=src/ffmpeg/ffmpeg_media.c");
    println!("cargo:rerun-if-changed=src/ffmpeg/ffmpeg_media.h");
    println!("cargo:rerun-if-changed=src/ffmpeg/include");
    cc::Build::new()
        .file("src/ffmpeg/ffmpeg_media.c")
        .include("src/ffmpeg/include")
        .flag_if_supported("-std=c11")
        .warnings(true)
        .extra_warnings(true)
        .compile("nasty_ffmpeg_media");

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    for (name, soname) in [
        ("avcodec", "libavcodec.so.58"),
        ("avformat", "libavformat.so.58"),
        ("swscale", "libswscale.so.5"),
        ("swresample", "libswresample.so.3"),
        ("avutil", "libavutil.so.56"),
    ] {
        let source = find_soname(soname);
        let link = out.join(format!("lib{name}.so"));
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&source, &link)
            .unwrap_or_else(|error| panic!("linking {soname}: {error}"));
        println!("cargo:rustc-link-lib=dylib={name}");
        println!("cargo:rerun-if-changed={}", source.display());
    }
    println!("cargo:rustc-link-search=native={}", out.display());
}

fn find_soname(soname: &str) -> std::path::PathBuf {
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let multiarch = match arch.as_str() {
        "x86_64" => Some("x86_64-linux-gnu"),
        "aarch64" => Some("aarch64-linux-gnu"),
        "x86" => Some("i386-linux-gnu"),
        _ => None,
    };
    let mut dirs = Vec::new();
    if let Some(multiarch) = multiarch {
        dirs.push(format!("/lib/{multiarch}"));
        dirs.push(format!("/usr/lib/{multiarch}"));
    }
    dirs.extend(["/lib".to_string(), "/usr/lib".to_string()]);
    for dir in dirs {
        let path = std::path::PathBuf::from(dir).join(soname);
        if path.is_file() { return path; }
    }
    panic!("Cannot find {soname}, required for Nasty's in-process FFmpeg video decoder");
}
