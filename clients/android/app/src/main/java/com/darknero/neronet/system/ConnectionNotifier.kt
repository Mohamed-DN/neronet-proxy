package com.darknero.neronet.system

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.darknero.neronet.MainActivity
import com.darknero.neronet.ProfileRepository
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.R
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** What the connection notification says: the profile's title and when the connection began (epoch ms). */
data class NotificationModel(val profileTitle: String, val connectedWallMs: Long)

/**
 * The notification exists only while the tunnel is connected. Pure: the caller supplies the phase,
 * the profiles and the connection time. Returns null for every other phase, or when the profile is gone.
 */
fun notificationModel(phase: TunnelPhase, profiles: List<ProfileSummary>, connectedWallMs: Long?): NotificationModel? {
    val connected = phase as? TunnelPhase.Connected ?: return null
    val title = profiles.firstOrNull { it.id == connected.profileId }?.title ?: return null
    val since = connectedWallMs ?: return null
    return NotificationModel(title, since)
}

/**
 * Keeps one quiet, ongoing notification while connected. It is posted when the model changes, never
 * re-posted each second: the chronometer does the ticking.
 */
class ConnectionNotifier(
    private val context: Context,
    private val tunnels: TunnelRepository,
    private val profiles: ProfileRepository,
    private val scope: CoroutineScope,
) {
    fun start() {
        createChannel()
        scope.launch {
            combine(tunnels.state, profiles.profiles) { machine, all ->
                notificationModel(machine.phase, all, tunnels.connectedWallSinceMs())
            }
                .distinctUntilChanged()
                .collect { model ->
                    if (model == null) cancel() else post(model)
                }
        }
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = context.getString(R.string.notif_channel_desc) }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun post(model: NotificationModel) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val disconnect = PendingIntent.getBroadcast(
            context,
            1,
            Intent(context, DisconnectReceiver::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_neronet)
            .setContentTitle(context.getString(R.string.status_protected_line, model.profileTitle))
            .setContentIntent(openApp)
            .setWhen(model.connectedWallMs)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, context.getString(R.string.action_disconnect), disconnect)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun cancel() {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    companion object {
        const val CHANNEL_ID = "connection"
        const val NOTIFICATION_ID = 1
        const val ACTION_DISCONNECT = "com.darknero.neronet.DISCONNECT"
    }
}
