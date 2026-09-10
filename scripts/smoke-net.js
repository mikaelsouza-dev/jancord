'use strict'

const { JancordNet, randomKey } = require('../electron/network')

async function waitFor(emitter, event, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout)
    emitter.once(event, (payload) => {
      clearTimeout(t)
      resolve(payload)
    })
  })
}

async function main() {
  const key = randomKey()
  const name = 'smoke-sala'
  const a = new JancordNet({ peerId: 'aaaaaa', nickname: 'Ana' })
  const b = new JancordNet({ peerId: 'bbbbbb', nickname: 'Beto' })

  const seen = waitFor(a, 'peer')
  await a.create({ name, key })
  await b.join({ name, key, hosts: ['127.0.0.1'], port: a.boundPort })
  const peer = await seen
  if (peer.peerId !== 'bbbbbb') throw new Error('peer errado: ' + JSON.stringify(peer))
  console.log('ok', { via: peer.via, port: a.boundPort, key })
  await a.leave()
  await b.leave()
  process.exit(0)
}

main().catch(async (err) => {
  console.error('fail', err)
  process.exit(1)
})
