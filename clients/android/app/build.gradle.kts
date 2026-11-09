plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.darknero.neronet"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.darknero.neronet"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    // Debug-signed until a release key exists (see clients/android/README.md).
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ""
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Official WireGuard tunnel library (GoBackend, Config.parse). Newest release, published 2026-01-02.
    implementation("com.wireguard.android:tunnel:1.0.20260102")

    testImplementation("junit:junit:4.13.2")
}
