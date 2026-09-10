'use strict'

const http = require('http')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { fork } = require('child_process')
const { EventEmitter } = require('events')
const { WebSocketServer, WebSocket } = require('ws')

const SIGNAL_PORT = 34780
const DISCOVERY_PORT = 34781
const HELLO_EVERY_MS = 3000
const PEER_TTL_MS = 12000
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081'
]

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function networkId(name, key) {
  return sha(`jancord:v1:${norm(name)}:${norm(key)}`).slice(0, 24)
}

function authToken(name, key) {
  return sha(`jancord:auth:${norm(name)}:${norm(key)}`)
}

function encKey(name, key) {
  return crypto.createHash('sha256').update(`jancord:enc:${norm(name)}:${norm(key)}`).digest()
}

function norm(s) {
  return String(s || '').trim().toUpperCase().replace(/[-\s]/g, '')
}

function formatKey(key) {
  const k = norm(key)
  if (k.length <= 3) return k
  return `${k.slice(0, 3)}-${k.slice(3)}`
}

function randomKey() {
  const alph = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = crypto.randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += alph[buf[i] % alph.length]
  return out
}

function isV4(iface) {
  return iface.family === 'IPv4' || iface.family === 4
}

function localIPv4s() {
  const ips = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (!isV4(iface) || iface.internal) continue
      if (iface.address.startsWith('169.254.')) continue
      ips.push(iface.address)
    }
  }
  return ips
}

function cidrBroadcast(cidr) {
  if (!cidr || !cidr.includes('/')) return null
  const [ip, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null
  let addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const bcast = (addr | (~mask >>> 0)) >>> 0
  return [
    (bcast >>> 24) & 255,
    (bcast >>> 16) & 255,
    (bcast >>> 8) & 255,
    bcast & 255
  ].join('.')
}

function broadcastTargets() {
  const set = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (!isV4(iface) || iface.internal || !iface.cidr) continue
      const b = cidrBroadcast(iface.cidr)
      if (b) set.add(b)
    }
  }
  return [...set]
}

function encrypt(keyBuf, obj) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv)
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64url')
}

function decrypt(keyBuf, token) {
  const buf = Buffer.from(token, 'base64url')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv)
  decipher.setAuthTag(tag)
  const out = Buffer.concat([decipher.update(data), decipher.final()])
  return JSON.parse(out.toString('utf8'))
}

function fetchPublicIp(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get('http://api.ipify.org', { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        const ip = body.trim()
        resolve(/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null)
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

function encodeInvite(payload) {
  return `JANCORD/1/${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

function decodeInvite(raw) {
  const text = String(raw || '').trim()
  const m = text.match(/JANCORD\/1\/([A-Za-z0-9_-]+)/i)
  if (m) {
    const json = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'))
    return {
      name: json.n,
      key: json.k,
      hosts: Array.isArray(json.h) ? json.h : [],
      port: json.p || SIGNAL_PORT
    }
  }
  return null
}

class JancordNet extends EventEmitter {
  constructor({ peerId, nickname }) {
    super()
    this.peerId = peerId
    this.nickname = nickname || 'eu'
    this.state = 'idle'
    this.detail = ''
    this.name = ''
    this.key = ''
    this.netId = ''
    this.token = ''
    this.keyBuf = null
    this.peers = new Map()
    this.lanRooms = new Map()
    this.wsServer = null
    this.httpServer = null
    this.clients = new Map()
    this.outbound = new Map()
    this.udp = null
    this.lanChild = null
    this.lanReady = false
    this.mqtt = null
    this.helloTimer = null
    this.scanTimer = null
    this.gcTimer = null
    this.publicIp = null
    this.boundPort = SIGNAL_PORT
  }

  setNickname(name) {
    this.nickname = String(name || 'eu').slice(0, 24)
  }

  status(state, detail = '') {
    this.state = state
    this.detail = detail
    this.emit('status', { state, detail })
  }

  async create({ name, key }) {
    await this.leave()
    this.name = String(name || '').trim()
    this.key = norm(key)
    if (this.name.length < 2) throw new Error('Dá um nome pra rede (pelo menos 2 letras).')
    if (this.key.length < 6) throw new Error('A chave precisa ter 6 caracteres.')
    this._setupSecrets()
    this.status('connecting', 'Abrindo a rede…')
    await this._startLocal()
    this._startMqtt()
    this._startHello()
    this.status('waiting', 'Rede aberta. Manda o convite pro amigo.')
    return this.snapshot()
  }

  async join({ name, key, hosts = [], port = SIGNAL_PORT }) {
    await this.leave()
    this.name = String(name || '').trim()
    this.key = norm(key)
    if (this.name.length < 2) throw new Error('Falta o nome da rede.')
    if (this.key.length < 6) throw new Error('Falta a chave da rede.')
    this._setupSecrets()
    this.status('connecting', 'Procurando o amigo…')
    await this._startLocal()
    this._startMqtt()
    this._startHello()
    const uniqueHosts = [...new Set((hosts || []).filter(Boolean))]
    for (const host of uniqueHosts) {
      this._dial(host, port || SIGNAL_PORT)
    }
    this.status('waiting', uniqueHosts.length
      ? 'Chamando o IP do amigo e a rede…'
      : 'Esperando o amigo na mesma rede…')
    return this.snapshot()
  }

  async leave() {
    if (this.helloTimer) clearInterval(this.helloTimer)
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.helloTimer = this.scanTimer = this.gcTimer = null

    this._broadcast({ t: 'bye', peerId: this.peerId })

    for (const ws of this.outbound.values()) {
      try { ws.close() } catch {}
    }
    this.outbound.clear()
    for (const ws of this.clients.values()) {
      try { ws.close() } catch {}
    }
    this.clients.clear()

    if (this.wsServer) {
      try { this.wsServer.close() } catch {}
      this.wsServer = null
    }
    if (this.httpServer) {
      try { this.httpServer.closeAllConnections?.() } catch {}
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 400)
        this.httpServer.close(() => {
          clearTimeout(t)
          resolve()
        })
      })
      this.httpServer = null
    }
    this._stopLan()
    if (this.mqtt) {
      try { this.mqtt.end(true) } catch {}
      this.mqtt = null
    }

    this.peers.clear()
    this.name = ''
    this.key = ''
    this.netId = ''
    this.token = ''
    this.keyBuf = null
    this.status('idle', '')
  }

  send(to, data) {
    const msg = { t: 'signal', from: this.peerId, to, data }
    this._sendTo(to, msg)
    this._mqttPublish(`jancord/${this.netId}/s/${to}`, msg)
  }

  snapshot() {
    return {
      state: this.state,
      detail: this.detail,
      name: this.name,
      key: formatKey(this.key),
      peerId: this.peerId,
      nickname: this.nickname,
      invite: this.getInvite(),
      ips: localIPv4s(),
      publicIp: this.publicIp,
      port: this.boundPort,
      peers: [...this.peers.values()].map((p) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        via: p.via
      })),
      lanRooms: [...this.lanRooms.values()]
    }
  }

  getInvite() {
    if (!this.name || !this.key) return ''
    const hosts = [...localIPv4s()]
    if (this.publicIp && !hosts.includes(this.publicIp)) hosts.push(this.publicIp)
    return encodeInvite({
      n: this.name,
      k: this.key,
      h: hosts,
      p: this.boundPort
    })
  }

  startLanScan() {
    this._openUdp()
  }

  _setupSecrets() {
    this.netId = networkId(this.name, this.key)
    this.token = authToken(this.name, this.key)
    this.keyBuf = encKey(this.name, this.key)
  }

  async _startLocal() {
    this.publicIp = await fetchPublicIp()
    await this._listenWs()
    this.gcTimer = setInterval(() => this._gc(), 2000)
  }

  _listenWs() {
    return new Promise((resolve, reject) => {
      const server = http.createServer()
      const wss = new WebSocketServer({ server })
      wss.on('error', () => {})
      wss.on('connection', (ws) => this._onSocket(ws, 'lan'))
      let port = SIGNAL_PORT
      const onErr = (err) => {
        if (err.code === 'EADDRINUSE' && port < SIGNAL_PORT + 12) {
          port += 1
          server.listen(port, '0.0.0.0')
          return
        }
        server.off('error', onErr)
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onErr)
        server.off('listening', onListening)
        this.httpServer = server
        this.wsServer = wss
        this.boundPort = server.address().port
        resolve()
      }
      server.on('error', onErr)
      server.on('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
  }

  _openUdp() {
    if (this.lanChild) return
    try {
      this.lanChild = fork(path.join(__dirname, 'lan-beacon.js'), [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JANCORD_DISCOVERY_PORT: String(DISCOVERY_PORT) },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
    } catch (err) {
      this.emit('error', 'LAN indisponível: ' + err.message)
      return
    }
    this.lanChild.on('message', (m) => {
      if (!m || !m.t) return
      if (m.t === 'ready') {
        this.lanReady = true
        this.udp = true
        this._beacon()
      }
      if (m.t === 'msg') this._onUdp(Buffer.from(m.text), { address: m.address, port: m.port })
      if (m.t === 'error') this.emit('error', m.message)
    })
    this.lanChild.on('exit', () => {
      this.lanChild = null
      this.lanReady = false
      this.udp = null
    })
    this.lanChild.on('error', (err) => this.emit('error', err.message))
  }

  _stopLan() {
    this.lanReady = false
    this.udp = null
    if (!this.lanChild) return
    try { this.lanChild.send({ t: 'close' }) } catch {}
    try { this.lanChild.kill() } catch {}
    this.lanChild = null
  }

  _beacon() {
    if (!this.lanReady || !this.netId || !this.lanChild) return
    const payload = JSON.stringify({
      v: 1,
      app: 'jancord',
      netId: this.netId,
      name: this.name,
      peerId: this.peerId,
      nickname: this.nickname,
      port: this.boundPort
    })
    for (const dest of broadcastTargets()) {
      try { this.lanChild.send({ t: 'send', text: payload, to: dest }) } catch {}
    }
  }

  _onUdp(buf, rinfo) {
    let msg
    try { msg = JSON.parse(buf.toString('utf8')) } catch { return }
    if (msg.app !== 'jancord' || !msg.peerId) return
    if (msg.peerId === this.peerId) return

    if (msg.name && msg.netId) {
      this.lanRooms.set(msg.netId, {
        name: msg.name,
        host: rinfo.address,
        port: msg.port || SIGNAL_PORT,
        nickname: msg.nickname,
        at: Date.now()
      })
      this.emit('lan', [...this.lanRooms.values()])
    }

    if (this.netId && msg.netId === this.netId) {
      this._seePeer({
        peerId: msg.peerId,
        nickname: msg.nickname || 'amigo',
        via: 'lan'
      })
      this._dial(rinfo.address, msg.port || SIGNAL_PORT)
    }
  }

  _dial(host, port) {
    const id = `${host}:${port}`
    const existing = this.outbound.get(id)
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return
    }
    let ws
    try {
      ws = new WebSocket(`ws://${host}:${port}`)
    } catch {
      return
    }
    this.outbound.set(id, ws)
    ws.on('open', () => {
      ws.send(JSON.stringify(this._helloMsg()))
    })
    ws.on('message', (raw) => this._onMessage(ws, raw, 'ip'))
    ws.on('close', () => {
      if (this.outbound.get(id) === ws) this.outbound.delete(id)
    })
    ws.on('error', () => {
      try { ws.close() } catch {}
    })
  }

  _onSocket(ws, via) {
    ws._jancordVia = via
    ws.on('message', (raw) => this._onMessage(ws, raw, via))
    ws.on('close', () => {
      if (ws._peerId) this.clients.delete(ws._peerId)
    })
    ws.on('error', () => {})
  }

  _helloMsg() {
    return {
      t: 'hello',
      peerId: this.peerId,
      nickname: this.nickname,
      netId: this.netId,
      token: this.token
    }
  }

  _onMessage(ws, raw, via) {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (!msg || !msg.t) return

    if (msg.t === 'hello') {
      if (msg.netId !== this.netId || msg.token !== this.token) {
        try { ws.close() } catch {}
        return
      }
      if (msg.peerId === this.peerId) return
      ws._peerId = msg.peerId
      this.clients.set(msg.peerId, ws)
      this._seePeer({ peerId: msg.peerId, nickname: msg.nickname, via })
      try { ws.send(JSON.stringify({ t: 'hello-ok', peer: this._helloMsg() })) } catch {}
      return
    }

    if (msg.t === 'hello-ok' && msg.peer) {
      if (msg.peer.peerId === this.peerId) return
      ws._peerId = msg.peer.peerId
      this.clients.set(msg.peer.peerId, ws)
      this._seePeer({ peerId: msg.peer.peerId, nickname: msg.peer.nickname, via })
      return
    }

    if (msg.t === 'signal' && msg.from && msg.data) {
      if (msg.to && msg.to !== this.peerId) return
      this._seePeer({ peerId: msg.from, nickname: this.peers.get(msg.from)?.nickname || 'amigo', via })
      this.emit('signal', { from: msg.from, data: msg.data })
      return
    }

    if (msg.t === 'bye' && msg.peerId) {
      this._dropPeer(msg.peerId)
    }
  }

  _sendTo(to, msg) {
    const payload = JSON.stringify(msg)
    const ws = this.clients.get(to)
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload) } catch {}
    }
    for (const out of this.outbound.values()) {
      if (out.readyState === WebSocket.OPEN) {
        try { out.send(payload) } catch {}
      }
    }
  }

  _broadcast(msg) {
    const payload = JSON.stringify(msg)
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload) } catch {}
      }
    }
    for (const ws of this.outbound.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload) } catch {}
      }
    }
  }

  async _startMqtt() {
    let mqtt
    try {
      mqtt = await import('mqtt')
    } catch (err) {
      this.emit('error', 'Não deu pra carregar o sinal da internet.')
      return
    }
    const connect = mqtt.connect || mqtt.default?.connect
    if (!connect) return

    const tryBroker = (index) => {
      if (!this.netId || index >= MQTT_BROKERS.length) {
        if (!this.mqtt) this.emit('error', 'Sem sinal na internet. LAN e IP direto ainda funcionam.')
        return
      }
      const url = MQTT_BROKERS[index]
      const client = connect(url, {
        clientId: `jancord-${this.peerId}-${crypto.randomBytes(2).toString('hex')}`,
        clean: true,
        reconnectPeriod: 2500,
        connectTimeout: 6000,
        protocolVersion: 4
      })
      let settled = false
      const fail = () => {
        if (settled) return
        settled = true
        try { client.end(true) } catch {}
        tryBroker(index + 1)
      }
      client.once('connect', () => {
        if (!this.netId) {
          try { client.end(true) } catch {}
          return
        }
        settled = true
        this.mqtt = client
        const helloTopic = `jancord/${this.netId}/hello`
        const signalTopic = `jancord/${this.netId}/s/${this.peerId}`
        client.subscribe([helloTopic, signalTopic], { qos: 0 }, () => {
          this._mqttPublish(helloTopic, this._helloMsg())
        })
        client.on('message', (topic, buf) => this._onMqtt(topic, buf))
        this.status(this.peers.size ? 'connected' : 'waiting', this.peers.size
          ? 'Amigo na rede.'
          : 'Rede aberta na internet e na LAN.')
      })
      client.once('error', fail)
      setTimeout(() => {
        if (!settled && (!client.connected)) fail()
      }, 7000)
    }

    tryBroker(0)
  }

  _onMqtt(_topic, buf) {
    if (!this.keyBuf) return
    let msg
    try { msg = decrypt(this.keyBuf, String(buf)) } catch { return }
    if (!msg) return
    if (msg.peerId === this.peerId || msg.from === this.peerId) return
    if (msg.t === 'hello' && msg.peerId && msg.token === this.token) {
      this._seePeer({ peerId: msg.peerId, nickname: msg.nickname, via: 'net' })
      return
    }
    if (msg.t === 'signal' && msg.from && msg.data) {
      this.emit('signal', { from: msg.from, data: msg.data })
    }
    if (msg.t === 'bye' && msg.peerId) this._dropPeer(msg.peerId)
  }

  _mqttPublish(topic, obj) {
    if (!this.mqtt || !this.mqtt.connected || !this.keyBuf) return
    try {
      this.mqtt.publish(topic, encrypt(this.keyBuf, obj), { qos: 0, retain: false })
    } catch {}
  }

  _startHello() {
    if (this.helloTimer) clearInterval(this.helloTimer)
    this.helloTimer = setInterval(() => {
      this._mqttPublish(`jancord/${this.netId}/hello`, this._helloMsg())
      this._broadcast(this._helloMsg())
    }, HELLO_EVERY_MS)
  }

  _seePeer(peer) {
    const prev = this.peers.get(peer.peerId)
    const next = {
      peerId: peer.peerId,
      nickname: peer.nickname || prev?.nickname || 'amigo',
      via: peer.via || prev?.via || 'net',
      at: Date.now()
    }
    this.peers.set(peer.peerId, next)
    if (!prev) {
      this.emit('peer', next)
      this.status('connected', `${next.nickname} entrou na rede.`)
    }
  }

  _dropPeer(peerId) {
    if (!this.peers.has(peerId)) return
    this.peers.delete(peerId)
    this.emit('peer-left', { peerId })
    if (!this.peers.size) this.status('waiting', 'Amigo saiu. Rede ainda aberta.')
  }

  _gc() {
    const now = Date.now()
    for (const [id, peer] of this.peers) {
      if (now - peer.at > PEER_TTL_MS) this._dropPeer(id)
    }
    for (const [id, room] of this.lanRooms) {
      if (now - room.at > PEER_TTL_MS) this.lanRooms.delete(id)
    }
    this.emit('lan', [...this.lanRooms.values()])
  }
}

module.exports = {
  JancordNet,
  randomKey,
  formatKey,
  decodeInvite,
  encodeInvite,
  SIGNAL_PORT,
  localIPv4s,
  fetchPublicIp
}
