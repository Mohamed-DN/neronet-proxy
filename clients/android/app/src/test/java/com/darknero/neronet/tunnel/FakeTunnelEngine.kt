package com.darknero.neronet.tunnel

import com.wireguard.config.Config
import kotlinx.coroutines.delay

/** Stands in for GoBackend: records calls, and emits listener events the way the backend does. */
class FakeTunnelEngine : TunnelEngine {
    val ups = mutableListOf<String>()
    val upConfigs = mutableListOf<Config>()
    val blocks = mutableListOf<String>()
    val blockConfigs = mutableListOf<Config>()
    val downs = mutableListOf<String>()
    var upDelayMs = 0L
    var upFailure: Throwable? = null

    /** How many of the next [up] calls fail with a plain exception. */
    var upFailures = 0
    var blockFailure: Throwable? = null
    var statsResult: TunnelStats? = null

    private var listener: ((String, Boolean) -> Unit)? = null

    override fun setListener(listener: (profileId: String, up: Boolean) -> Unit) {
        this.listener = listener
    }

    override suspend fun up(profileId: String, config: Config) {
        delay(upDelayMs)
        upFailure?.let {
            upFailure = null
            throw it
        }
        if (upFailures > 0) {
            upFailures--
            throw IllegalStateException("start refused")
        }
        ups += profileId
        upConfigs += config
        emit(profileId, true)
    }

    override suspend fun block(profileId: String, config: Config) {
        blockFailure?.let {
            blockFailure = null
            throw it
        }
        blocks += profileId
        blockConfigs += config
        // The real backend reports the replaced interface going down and the blocking one coming up.
        emit(profileId, false)
        emit(profileId, true)
    }

    override suspend fun down(profileId: String) {
        downs += profileId
        emit(profileId, false)
    }

    override suspend fun stats(profileId: String): TunnelStats? = statsResult

    fun emit(profileId: String, up: Boolean) {
        listener?.invoke(profileId, up)
    }
}
