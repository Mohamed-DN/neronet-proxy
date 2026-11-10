package com.darknero.neronet.system

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.TestNeroNetApplication
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.util.Base64
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class ConnectionNotifierTest {

    private val app: TestNeroNetApplication =
        NeroNetApplication.from(ApplicationProvider.getApplicationContext<Application>()) as TestNeroNetApplication

    private val notifications: List<Notification>
        get() = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications

    @Before
    fun grantNotificationPermission() {
        shadowOf(app).grantPermissions("android.permission.POST_NOTIFICATIONS")
    }

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText(seed: Int): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(seed)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(seed + 100)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    /** Polls the real background work until [condition] holds or the timeout passes. */
    private fun awaitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("condition not reached within ${timeoutMs} ms", condition())
    }

    private fun connectProfile(seed: Int): String {
        val id = app.profiles.add(profileText(seed))
        app.tunnels.connect(id)
        awaitUntil { notifications.size == 1 }
        return id
    }

    @Test
    fun connectedPostsOneOngoingNotificationWithDisconnect() {
        connectProfile(60)

        val notification = notifications.single()
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertTrue(notification.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
        assertEquals("Disconnect", notification.actions.single().title.toString())
        val connectedAt = app.tunnels.connectedWallSinceMs()!!
        assertTrue("when was ${notification.`when`}, connected at $connectedAt", abs(notification.`when` - connectedAt) < 2_000)
    }

    @Test
    fun errorRemovesTheNotification() {
        val id = connectProfile(70)

        app.fakeEngine.emit(id, false)

        awaitUntil { notifications.isEmpty() }
        assertTrue(notifications.isEmpty())
    }

    @Test
    fun disconnectActionDisconnects() {
        val id = connectProfile(80)

        val pending = notifications.single().actions.single().actionIntent
        DisconnectReceiver().onReceive(app, shadowOf(pending).savedIntent)

        awaitUntil { app.fakeEngine.downs.contains(id) }
        assertEquals(listOf(id), app.fakeEngine.downs)
    }
}
