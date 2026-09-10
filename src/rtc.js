const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
]

export class CallSession {
  constructor({ localId, remoteId, send, onTrack, onState, onStats }) {
    this.localId = localId
    this.remoteId = remoteId
    this.send = send
    this.onTrack = onTrack
    this.onState = onState
    this.onStats = onStats
    this.polite = localId < remoteId
    this.pc = null
    this.makingOffer = false
    this.ignoreOffer = false
    this.statsTimer = null
    this.senders = new Map()
  }

  _ensurePc() {
    if (this.pc) return this.pc
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.send({ type: 'ice', candidate: ev.candidate })
    }
    pc.ontrack = (ev) => {
      this.onTrack?.(ev.track, ev.streams[0])
    }
    pc.onconnectionstatechange = () => {
      this.onState?.(pc.connectionState)
    }
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        this.send({ type: 'sdp', description: pc.localDescription })
      } catch (err) {
        console.error(err)
      } finally {
        this.makingOffer = false
      }
    }

    this.statsTimer = setInterval(() => this._stats(), 2000)
    return pc
  }

  async addStream(stream, role) {
    const pc = this._ensurePc()
    for (const track of stream.getTracks()) {
      const key = `${role}:${track.kind}`
      const existing = this.senders.get(key)
      if (existing) {
        await existing.replaceTrack(track)
        this.senders.set(key, existing)
      } else {
        const sender = pc.addTrack(track, stream)
        this.senders.set(key, sender)
      }
      if (track.kind === 'video') {
        track.contentHint = 'detail'
        try {
          const params = senderParams(this.senders.get(key))
          if (params) await this.senders.get(key).setParameters(params)
        } catch {}
      } else if (role === 'system') {
        track.contentHint = 'music'
      }
    }
  }

  async replaceMic(stream) {
    await this.addStream(stream, 'mic')
  }

  stopRole(role) {
    for (const [key, sender] of this.senders) {
      if (!key.startsWith(`${role}:`)) continue
      try { sender.track?.stop() } catch {}
      try { this.pc?.removeTrack(sender) } catch {}
      this.senders.delete(key)
    }
  }

  setMicEnabled(on) {
    const sender = this.senders.get('mic:audio')
    if (sender?.track) sender.track.enabled = on
  }

  async handleSignal(msg) {
    const pc = this._ensurePc()
    if (msg.type === 'sdp' && msg.description) {
      const description = msg.description
      const offerCollision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable')
      this.ignoreOffer = !this.polite && offerCollision
      if (this.ignoreOffer) return
      await pc.setRemoteDescription(description)
      if (description.type === 'offer') {
        await pc.setLocalDescription()
        this.send({ type: 'sdp', description: pc.localDescription })
      }
    } else if (msg.type === 'ice' && msg.candidate) {
      try {
        await pc.addIceCandidate(msg.candidate)
      } catch (err) {
        if (!this.ignoreOffer) console.error(err)
      }
    } else if (msg.type === 'hangup') {
      this.close()
    }
  }

  hangup() {
    try { this.send({ type: 'hangup' }) } catch {}
    this.close()
  }

  close() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    for (const sender of this.senders.values()) {
      try { sender.track?.stop() } catch {}
    }
    this.senders.clear()
    if (this.pc) {
      try { this.pc.close() } catch {}
      this.pc = null
    }
    this.onState?.('closed')
  }

  async _stats() {
    if (!this.pc || !this.onStats) return
    try {
      const stats = await this.pc.getStats()
      let rtt = null
      let bitrate = 0
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          rtt = Math.round(r.currentRoundTripTime * 1000)
        }
        if (r.type === 'inbound-rtp' && r.kind === 'video' && r.bytesReceived) {
          bitrate = r.bytesReceived
        }
      })
      this.onStats({ rtt, state: this.pc.connectionState })
    } catch {}
  }
}

function senderParams(sender) {
  if (!sender) return null
  const params = sender.getParameters()
  if (!params.encodings || !params.encodings.length) params.encodings = [{}]
  params.encodings[0].maxBitrate = 6_000_000
  params.encodings[0].maxFramerate = 60
  params.degradationPreference = 'maintain-resolution'
  return params
}
