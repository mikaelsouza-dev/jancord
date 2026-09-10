'use strict'

const dgram = require('dgram')

const PORT = Number(process.env.JANCORD_DISCOVERY_PORT || 34781)
let sock = null

function send(msg) {
  try { process.send(msg) } catch {}
}

function open() {
  sock = dgram.createSocket({ type: 'udp4' })
  sock.on('error', (err) => {
    send({ t: 'error', message: String(err.message || err) })
  })
  sock.on('message', (buf, rinfo) => {
    send({ t: 'msg', text: buf.toString('utf8'), address: rinfo.address, port: rinfo.port })
  })
  sock.bind({ port: PORT, exclusive: false }, () => {
    try { sock.setBroadcast(true) } catch {}
    send({ t: 'ready', port: PORT })
  })
}

process.on('message', (m) => {
  if (!m || !m.t) return
  if (m.t === 'send' && sock) {
    try { sock.send(Buffer.from(String(m.text)), PORT, m.to) } catch (err) {
      send({ t: 'error', message: String(err.message || err) })
    }
  }
  if (m.t === 'close') {
    try { sock.close() } catch {}
    process.exit(0)
  }
})

process.on('uncaughtException', (err) => {
  send({ t: 'error', message: String(err.message || err) })
  process.exit(1)
})

open()
