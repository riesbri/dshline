fn main() {
    println!("cargo:rerun-if-env-changed=NAPI_TYPE_DEF_TMP_FOLDER");
    napi_build::setup();
}
