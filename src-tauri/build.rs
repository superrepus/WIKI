fn main() {
    println!("cargo:rerun-if-env-changed=FOXESS_DEFAULT_MODEL_FILE");
    let mut mask=Vec::<u8>::new();let mut encoded=Vec::<u8>::new();
    if let Ok(path)=std::env::var("FOXESS_DEFAULT_MODEL_FILE"){
        println!("cargo:rerun-if-changed={path}");
        let private:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(path).expect("read private model build input")).expect("valid private model build input");
        mask=serde_json::from_value(private["mask"].clone()).expect("valid mask");
        encoded=serde_json::from_value(private["encoded"].clone()).expect("valid credential");
    }
    let out=std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("foxess_credential.rs");
    std::fs::write(out,format!("const FOXESS_MASK: &[u8] = &{mask:?};\nconst FOXESS_ENCODED: &[u8] = &{encoded:?};\n")).expect("write private native module");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
