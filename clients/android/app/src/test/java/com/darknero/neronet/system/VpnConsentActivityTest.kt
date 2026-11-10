package com.darknero.neronet.system

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.VpnService
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.TestNeroNetApplication
import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowVpnService
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class VpnConsentActivityTest {

    private val app: TestNeroNetApplication =
        NeroNetApplication.from(ApplicationProvider.getApplicationContext<Application>()) as TestNeroNetApplication

    private lateinit var profileId: String

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText(seed: Int): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(seed)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(seed + 100)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    @Before
    fun storeAProfile() {
        profileId = app.profiles.add(profileText(90))
        app.settings.lastProfileId = profileId
    }

    /** Polls the real background work until [condition] holds or the timeout passes. */
    private fun awaitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("condition not reached within $timeoutMs ms", condition())
    }

    @Test
    fun noConsentNeededConnectsAndFinishes() {
        ShadowVpnService.setPrepareResult(null)

        val controller = Robolectric.buildActivity(VpnConsentActivity::class.java).setup()

        awaitUntil { app.fakeEngine.ups.contains(profileId) }
        assertTrue(controller.get().isFinishing)
    }

    @Test
    fun deniedConsentReportsPermissionDenied() {
        ShadowVpnService.setPrepareResult(Intent("android.net.VpnService.CONSENT_TEST"))

        val activity = Robolectric.buildActivity(VpnConsentActivity::class.java).setup().get()
        val started = shadowOf(activity).nextStartedActivityForResult
        assertTrue("consent screen was not requested", started != null)

        shadowOf(activity).receiveResult(started.intent, Activity.RESULT_CANCELED, null)
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(
            TunnelPhase.Error(TunnelError.VPN_PERMISSION_DENIED, profileId),
            app.tunnels.state.value.phase,
        )
        assertTrue(activity.isFinishing)
    }
}
