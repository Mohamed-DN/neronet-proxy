plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.darknero.neronet"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.darknero.neronet"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.1.0"
    }

    // The release key is never in the repository: CI supplies it at build time (see clients/android/README.md).
    // All four values sign the release; none leaves it unsigned, as on a developer's machine. Some but not all
    // is a mistake and stops the build, so a half-configured job cannot publish an unsigned release.
    val signing = listOf("PATH", "PASSWORD", "KEY_ALIAS", "KEY_PASSWORD").associateWith { name ->
        System.getenv(if (name.startsWith("KEY_")) "NERONET_$name" else "NERONET_KEYSTORE_$name").orEmpty()
    }
    val signingSet = signing.values.count { it.isNotEmpty() }
    require(signingSet == 0 || signingSet == signing.size) {
        "Release signing is half configured: set all of " + signing.keys + " or none"
    }
    if (signingSet == signing.size) {
        signingConfigs {
            create("release") {
                storeFile = file(signing.getValue("PATH"))
                storePassword = signing.getValue("PASSWORD")
                keyAlias = signing.getValue("KEY_ALIAS")
                keyPassword = signing.getValue("KEY_PASSWORD")
            }
        }
    }

    // Debug stays unminified with every ABI so emulators work.
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ""
        }
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.maxHeapSize = "2g"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Official WireGuard tunnel library (GoBackend, Config.parse). Newest release, published 2026-01-02.
    implementation("com.wireguard.android:tunnel:1.0.20260102")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core-ktx:1.6.1")
    testImplementation("androidx.test.ext:junit-ktx:1.2.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
}
