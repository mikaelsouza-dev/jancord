import { CallSession } from './rtc.js'

window.addEventListener('error', (e) => {
  console.error('window.error', e.message, e.filename, e.lineno)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandledrejection', e.reason)
})

const $ = (id) => document.getElementById(id)

const ui = {
  home: $('view-home'),
  room: $('view-room'),
  led: $('led'),
  status: $('statusLine'),
  nickname: $('nickname'),
  createName: $('create-name'),
  createKey: $('create-key'),
  joinInvite: $('join-invite'),
  joinKey: $('join-key'),
  joinHost: $('join-host'),
  lanList: $('lanList'),
  lanEmpty: $('lanEmpty'),
  remoteVideo: $('remoteVideo'),
  localVideo: $('localVideo'),
  remoteAudio: $('remoteAudio'),
  stage: document.querySelector('.stage'),
  stageTitle: $('stageTitle'),
  stageHint: $('stageHint'),
  pip: $('pip'),
  peerLabel: $('peerLabel'),
  rttLabel: $('rttLabel'),
  roomName: $('roomName'),
  roomKey: $('roomKey'),
  peerList: $('peerList'),
  friendHint: $('friendHint'),
  appVersion: $('appVersion'),
  updateBar: $('updateBar'),
  updateText: $('updateText'),
  picker: $('picker'),
  pickerGrid: $('pickerGrid'),
  shareAudio: $('share-audio'),
  pickerOk: $('pickerOk')
}

const state = {
  profile: null,
  room: null,
  peers: new Map(),
  call: null,
  inCall: false,
  sharing: false,
  micOn: true,
  deafen: false,
  micStream: null,
  screenStream: null,
  remoteAudioStream: new MediaStream(),
  remoteVideoStream: new MediaStream(),
  selectedSource: null
}

function setStatus(text, led) {
  ui.status.textContent = text
  if (led) ui.led.dataset.state = led
}

function show(view) {
  ui.home.hidden = view !== 'home'
  ui.room.hidden = view !== 'room'
}

function toastError(where, message) {
  where.querySelector('.error')?.remove()
  const p = document.createElement('p')
  p.className = 'error'
  p.textContent = message
  where.querySelector('h2')?.after(p)
}

async function boot() {
  const profile = await window.jancord.getProfile()
  state.profile = profile
  const info = await window.jancord.getAppInfo()
  if (ui.appVersion) ui.appVersion.textContent = `v${info.version}`
  ui.nickname.value = profile.nickname || ''
  ui.createName.value = `sala-do-${(profile.nickname || 'pc').toLowerCase().replace(/\s+/g, '').slice(0, 12)}`
  ui.createKey.value = await window.jancord.randomKey()
  show('home')
  setStatus('Só um nome. Sem conta.', 'idle')
  window.jancord.onUpdate((u) => {
    ui.updateBar.hidden = false
    if (u.state === 'available') ui.updateText.textContent = `Tem versão nova (${u.version}). Baixando…`
    if (u.state === 'downloading') ui.updateText.textContent = `Baixando atualização… ${u.percent || 0}%`
    if (u.state === 'ready') {
      ui.updateText.textContent = `Versão ${u.version} pronta. Reinicia pra atualizar.`
      $('btn-update').hidden = false
    }
  })
  $('btn-update').addEventListener('click', () => window.jancord.installUpdate())
  $('btn-update').hidden = true

  window.jancord.onStatus((s) => {
    setStatus(s.detail || s.state, s.state === 'connected' ? 'connected' : s.state === 'waiting' ? 'waiting' : 'idle')
  })
  window.jancord.onError((e) => setStatus(e.message, ui.led.dataset.state))
  window.jancord.onPeer((peer) => {
    state.peers.set(peer.peerId, peer)
    renderPeers()
    ui.friendHint.textContent = peer.nickname
    setStatus(`${peer.nickname} entrou.`, 'connected')
  })
  window.jancord.onPeerLeft(({ peerId }) => {
    state.peers.delete(peerId)
    renderPeers()
    if (state.call?.remoteId === peerId) hangup(false)
    if (!state.peers.size) {
      ui.friendHint.textContent = 'amigo'
      ui.peerLabel.textContent = 'esperando'
    }
  })
  window.jancord.onLan(renderLan)
  window.jancord.onSignal(async ({ from, data }) => {
    if (data?.type === 'hangup') {
      hangup(false)
      return
    }
    if (!state.call) {
      const peer = state.peers.get(from) || { peerId: from, nickname: 'amigo' }
      await ensureCall(peer, false)
    }
    if (state.call?.remoteId === from) await state.call.handleSignal(data)
  })
}

function renderLan(rooms) {
  ui.lanList.innerHTML = ''
  const mine = state.room?.netId
  const list = (rooms || []).filter((r) => r.name)
  ui.lanEmpty.hidden = list.length > 0
  for (const room of list) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'lan-item'
    b.textContent = `${room.name} · ${room.nickname || room.host}`
    b.addEventListener('click', () => {
      ui.joinInvite.value = room.name
      ui.joinHost.value = room.host
      ui.joinKey.focus()
    })
    ui.lanList.append(b)
  }
}

function renderPeers() {
  ui.peerList.innerHTML = ''
  if (!state.peers.size) {
    const li = document.createElement('li')
    li.innerHTML = '<span>Ninguém plugado ainda</span>'
    ui.peerList.append(li)
    return
  }
  for (const peer of state.peers.values()) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = peer.nickname
    const via = document.createElement('span')
    via.className = 'muted'
    via.textContent = peer.via === 'lan' ? 'LAN' : peer.via === 'ip' ? 'IP' : 'P2P'
    li.append(name, via)
    ui.peerList.append(li)
    ui.peerLabel.textContent = peer.nickname
  }
}

async function persistName() {
  const nickname = ui.nickname.value.trim() || 'eu'
  state.profile = await window.jancord.saveProfile(nickname)
}

$('form-create').addEventListener('submit', async (e) => {
  e.preventDefault()
  await persistName()
  try {
    const room = await window.jancord.createNetwork({
      name: ui.createName.value.trim(),
      key: ui.createKey.value
    })
    enterRoom(room)
  } catch (err) {
    toastError($('form-create'), err.message)
  }
})

$('form-join').addEventListener('submit', async (e) => {
  e.preventDefault()
  await persistName()
  try {
    const invite = ui.joinInvite.value.trim()
    const isInvite = /^JANCORD\/1\//i.test(invite)
    const room = await window.jancord.joinNetwork({
      invite: isInvite ? invite : undefined,
      name: isInvite ? undefined : invite,
      key: ui.joinKey.value,
      host: ui.joinHost.value.trim() || undefined
    })
    enterRoom(room)
  } catch (err) {
    toastError($('form-join'), err.message)
  }
})

$('btn-reroll').addEventListener('click', async () => {
  ui.createKey.value = await window.jancord.randomKey()
})

function enterRoom(room) {
  state.room = room
  state.peers = new Map((room.peers || []).map((p) => [p.peerId, p]))
  show('room')
  ui.roomName.textContent = room.name
  ui.roomKey.textContent = room.key
  renderPeers()
  setStatus(room.detail || 'Rede aberta.', room.peers?.length ? 'connected' : 'waiting')
  ui.stageTitle.textContent = 'Esperando o amigo plugar.'
  ui.stageHint.textContent = 'Copia o convite e manda pra ele. Sem login dos dois lados.'
}

$('btn-copy').addEventListener('click', async () => {
  const invite = await window.jancord.getInvite()
  try {
    await navigator.clipboard.writeText(invite)
    $('btn-copy').textContent = 'Convite copiado'
    setTimeout(() => { $('btn-copy').textContent = 'Copiar convite' }, 1600)
  } catch {
    prompt('Copia este convite:', invite)
  }
})

$('btn-leave').addEventListener('click', async () => {
  hangup(true)
  await window.jancord.leaveNetwork()
  state.room = null
  state.peers.clear()
  show('home')
  setStatus('Saiu da rede.', 'idle')
})

$('btn-mic').addEventListener('click', () => {
  state.micOn = !state.micOn
  $('btn-mic').ariaPressed = String(state.micOn)
  $('btn-mic').classList.toggle('is-off', !state.micOn)
  state.call?.setMicEnabled(state.micOn)
  if (state.micStream) state.micStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn })
})

$('btn-deafen').addEventListener('click', () => {
  state.deafen = !state.deafen
  $('btn-deafen').ariaPressed = String(!state.deafen)
  $('btn-deafen').classList.toggle('is-off', state.deafen)
  ui.remoteAudio.muted = state.deafen
  ui.remoteVideo.muted = true
})

$('btn-call').addEventListener('click', async () => {
  if (state.inCall) {
    hangup(true)
    return
  }
  const peer = firstPeer()
  if (!peer) {
    setStatus('Espera o amigo entrar na rede primeiro.', 'waiting')
    return
  }
  await ensureCall(peer, true)
  await startMic()
  state.inCall = true
  markCall(true)
  setStatus(`Ligando pra ${peer.nickname}…`, 'live')
})

$('btn-share').addEventListener('click', async () => {
  if (state.sharing) {
    stopShare()
    return
  }
  await openPicker()
})

function firstPeer() {
  return state.peers.values().next().value || null
}

async function ensureCall(peer, asOfferer) {
  if (state.call && state.call.remoteId === peer.peerId) return state.call
  if (state.call) state.call.close()
  const session = new CallSession({
    localId: state.profile.peerId,
    remoteId: peer.peerId,
    send: (data) => window.jancord.send(peer.peerId, data),
    onTrack: attachRemoteTrack,
    onState: (s) => {
      if (s === 'connected') setStatus(`Com ${peer.nickname}`, 'live')
      if (s === 'failed' || s === 'disconnected') {
        setStatus('Caiu a ligação. Tenta de novo, ou entra pelo IP / mesmo Wi‑Fi.', 'waiting')
      }
    },
    onStats: ({ rtt }) => {
      ui.rttLabel.textContent = rtt != null ? `${rtt} ms` : ''
    }
  })
  state.call = session
  if (asOfferer) session._ensurePc()
  ui.peerLabel.textContent = peer.nickname
  ui.remoteAudio.srcObject = state.remoteAudioStream
  ui.remoteVideo.srcObject = state.remoteVideoStream
  ui.remoteVideo.muted = true
  return session
}

async function startMic() {
  if (!state.micStream) {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
  }
  state.micStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn })
  await state.call.addStream(state.micStream, 'mic')
}

function attachRemoteTrack(track) {
  const stream = track.kind === 'video' ? state.remoteVideoStream : state.remoteAudioStream
  stream.getTracks().filter((t) => t.kind === track.kind).forEach((t) => stream.removeTrack(t))
  stream.addTrack(track)
  if (track.kind === 'video') {
    ui.stage.classList.add('has-video')
    ui.remoteVideo.srcObject = stream
    ui.remoteVideo.play().catch(() => {})
  } else {
    ui.remoteAudio.srcObject = stream
    ui.remoteAudio.muted = state.deafen
    ui.remoteAudio.play().catch(() => {})
  }
  track.onended = () => {
    stream.removeTrack(track)
    if (track.kind === 'video' && !stream.getVideoTracks().length) ui.stage.classList.remove('has-video')
  }
  state.inCall = true
  markCall(true)
}

function markCall(on) {
  $('btn-call').ariaPressed = String(on)
  $('btn-call').querySelector('span').textContent = on ? 'Desligar' : 'Ligar'
}

function hangup(notify) {
  if (state.call) {
    if (notify) state.call.hangup()
    else state.call.close()
  }
  state.call = null
  state.inCall = false
  stopShare()
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop())
    state.micStream = null
  }
  state.remoteAudioStream.getTracks().forEach((t) => state.remoteAudioStream.removeTrack(t))
  state.remoteVideoStream.getTracks().forEach((t) => state.remoteVideoStream.removeTrack(t))
  ui.stage.classList.remove('has-video')
  markCall(false)
  ui.rttLabel.textContent = ''
}

async function openPicker() {
  const sources = await window.jancord.getSources()
  ui.pickerGrid.innerHTML = ''
  state.selectedSource = null
  ui.pickerOk.disabled = true
  for (const src of sources) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'thumb'
    const img = document.createElement('img')
    img.src = src.thumbnail
    img.alt = ''
    const cap = document.createElement('span')
    cap.textContent = src.kind === 'screen' ? `Tela · ${src.name}` : src.name
    btn.append(img, cap)
    btn.addEventListener('click', () => {
      ui.pickerGrid.querySelectorAll('.thumb').forEach((el) => el.classList.remove('selected'))
      btn.classList.add('selected')
      state.selectedSource = src
      ui.pickerOk.disabled = false
    })
    ui.pickerGrid.append(btn)
  }
  ui.picker.showModal()
}

$('picker-form').addEventListener('submit', async (e) => {
  const value = e.submitter?.value
  if (value !== 'ok' || !state.selectedSource) return
  e.preventDefault()
  ui.picker.close()
  await startShare(state.selectedSource, ui.shareAudio.checked)
})

async function startShare(source, withAudio) {
  const peer = firstPeer()
  if (!peer) {
    setStatus('Espera o amigo entrar pra telar.', 'waiting')
    return
  }
  await window.jancord.prepareCapture({ sourceId: source.id, audio: withAudio })
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: withAudio
  })
  stream.getVideoTracks().forEach((t) => { t.contentHint = 'detail' })
  stream.getAudioTracks().forEach((t) => {
    t.contentHint = 'music'
    t.applyConstraints?.({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }).catch(() => {})
  })
  stream.getVideoTracks()[0]?.addEventListener('ended', () => stopShare())
  state.screenStream = stream
  await ensureCall(peer, true)
  if (!state.micStream) {
    try { await startMic() } catch {}
  }
  await state.call.addStream(stream, 'screen')
  ui.localVideo.srcObject = stream
  ui.pip.hidden = false
  state.sharing = true
  state.inCall = true
  markCall(true)
  $('btn-share').ariaPressed = 'true'
  setStatus(`Telando${withAudio ? ' com som do PC' : ''} pra ${peer.nickname}`, 'live')
}

function stopShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop())
    state.screenStream = null
  }
  state.call?.stopRole('screen')
  ui.pip.hidden = true
  ui.localVideo.srcObject = null
  state.sharing = false
  $('btn-share').ariaPressed = 'false'
  window.jancord.clearCapture()
}

ui.nickname.addEventListener('change', persistName)

boot().catch((err) => setStatus(err.message, 'idle'))
