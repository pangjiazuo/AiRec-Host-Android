plugins { id("com.android.application") }
android {
    namespace = "com.airec.host"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.airec.host"
        minSdk = 28
        targetSdk = 28
        versionCode = 4
        versionName = "1.0.1"
        testInstrumentationRunner = "com.airec.host.HostTests"
        ndk { abiFilters += "arm64-v8a" }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    packaging { jniLibs.useLegacyPackaging = true }
    androidResources { noCompress += "rknn" }
}
dependencies { testImplementation("junit:junit:4.13.2") }
