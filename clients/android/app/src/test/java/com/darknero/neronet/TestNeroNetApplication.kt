package com.darknero.neronet

import com.darknero.neronet.tunnel.FakeTunnelEngine
import com.darknero.neronet.tunnel.TunnelEngine

/** Application used by every Robolectric test: the tunnel engine is a fake, so no native code loads. */
class TestNeroNetApplication : NeroNetApplication() {
    val fakeEngine = FakeTunnelEngine()

    override fun createEngine(): TunnelEngine = fakeEngine
}
