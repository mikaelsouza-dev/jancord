'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function listen(channel, cb) {
  const fn = (_event, data) => cb(data)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

contextBridge.exposeInMainWorld('jancord', {
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveProfile: (nickname) => ipcRenderer.invoke('profile:save', { nickname }),
  createNetwork: (opts) => ipcRenderer.invoke('net:create', opts),
  joinNetwork: (opts) => ipcRenderer.invoke('net:join', opts),
  leaveNetwork: () => ipcRenderer.invoke('net:leave'),
  send: (to, data) => ipcRenderer.invoke('net:send', { to, data }),
  getInvite: () => ipcRenderer.invoke('net:invite'),
  snapshot: () => ipcRenderer.invoke('net:snapshot'),
  randomKey: () => ipcRenderer.invoke('net:random-key'),
  parseInvite: (raw) => ipcRenderer.invoke('net:parse-invite', raw),
  getSources: () => ipcRenderer.invoke('capture:sources'),
  prepareCapture: (opts) => ipcRenderer.invoke('capture:prepare', opts),
  clearCapture: () => ipcRenderer.invoke('capture:clear'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => listen('update:status', cb),
  onStatus: (cb) => listen('net:status', cb),
  onPeer: (cb) => listen('net:peer', cb),
  onPeerLeft: (cb) => listen('net:peer-left', cb),
  onSignal: (cb) => listen('net:signal', cb),
  onLan: (cb) => listen('net:lan', cb),
  onError: (cb) => listen('net:error', cb)
})
