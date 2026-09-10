'use strict'

const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const { autoUpdater } = require('electron-updater')
const { JancordNet, randomKey, formatKey, decodeInvite, localIPv4s, fetchPublicIp } = require('./network')

const bootLog = path.join(__dirname, '..', '.boot.log')
function boot(msg, err) {
  try {
    fs.appendFileSync(bootLog, `${new Date().toISOString()} ${msg}${err ? ' ' + (err.stack || err) : ''}\n`)
  } catch {}
  console.log(msg, err || '')
}
boot('main loaded')
process.on('uncaughtException', (err) => boot('uncaughtException', err))
process.on('unhandledRejection', (err) => boot('unhandledRejection', err))
process.on('exit', (code) => boot('process exit ' + code))
app.setAppUserModelId('dev.mikaelsouza.jancord')
if (!app.isPackaged) {
  const dataEq = process.argv.find((a) => a.startsWith('--user-data-dir='))
  const dataIdx = process.argv.indexOf('--user-data-dir')
  const dataDir = dataEq
    ? dataEq.slice('--user-data-dir='.length)
    : (dataIdx >= 0 ? process.argv[dataIdx + 1] : path.join(os.tmpdir(), process.argv.includes('--second') ? 'jancord-second' : 'jancord-main'))
  app.setPath('userData', path.resolve(dataDir))
}
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-features', 'WebGPU,CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride,PulseaudioLoopbackForScreenShare')
boot('userData ' + app.getPath('userData'))

const isDev = process.argv.includes('--dev')
let mainWindow = null
let net = null
let pendingCapture = null

function safeUser() {
  try { return os.userInfo().username } catch { return process.env.USERNAME || 'eu' }
}

function profilePath() {
  return path.join(app.getPath('userData'), 'profile.json')
}

function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(profilePath(), 'utf8'))
  } catch {
    return null
  }
}

function saveProfile(data) {
  const prev = loadProfile() || {}
  const next = {
    peerId: prev.peerId || crypto.randomBytes(6).toString('hex'),
    nickname: String(data.nickname || prev.nickname || safeUser() || 'eu').slice(0, 24)
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(profilePath(), JSON.stringify(next, null, 2))
  return next
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function attachNet(instance) {
  net = instance
  net.on('status', (s) => send('net:status', s))
  net.on('peer', (p) => send('net:peer', p))
  net.on('peer-left', (p) => send('net:peer-left', p))
  net.on('signal', (p) => send('net:signal', p))
  net.on('lan', (rooms) => send('net:lan', rooms))
  net.on('error', (msg) => send('net:error', { message: String(msg) }))
}

function createWindow() {
  boot('creating window')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#14120d',
    title: 'Jancord',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.on('did-finish-load', () => boot('did-finish-load'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => boot(`fail-load ${code} ${desc} ${url}`))
  mainWindow.webContents.on('render-process-gone', (_e, details) => boot('renderer gone ' + JSON.stringify(details)))
  mainWindow.webContents.on('console-message', (_e, level, message) => boot(`console[${level}] ${message}`))
  const showWin = (why) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
    mainWindow.focus()
    boot(why)
  }
  mainWindow.once('ready-to-show', () => showWin('shown'))
  setTimeout(() => showWin('shown-fallback'), 1600)
  mainWindow.on('close', () => boot('window close event'))
  mainWindow.on('closed', () => {
    boot('window closed')
    mainWindow = null
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  boot('app ready')
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (!pendingCapture || !pendingCapture.source) {
      callback({ video: false })
      return
    }
    callback({
      video: pendingCapture.source,
      audio: pendingCapture.audio ? 'loopback' : undefined
    })
  })

  const profile = saveProfile(loadProfile() || {})
  attachNet(new JancordNet({ peerId: profile.peerId, nickname: profile.nickname }))
  fetchPublicIp().then((ip) => { if (net) net.publicIp = ip }).catch(() => {})

  ipcMain.handle('profile:get', async () => {
    const p = saveProfile(loadProfile() || {})
    return {
      ...p,
      ips: localIPv4s(),
      publicIp: net?.publicIp || null
    }
  })

  ipcMain.handle('profile:save', async (_e, { nickname }) => {
    const p = saveProfile({ nickname })
    if (net) net.setNickname(p.nickname)
    return p
  })

  ipcMain.handle('net:create', async (_e, { name, key }) => {
    const k = key || randomKey()
    return net.create({ name, key: k })
  })

  ipcMain.handle('net:join', async (_e, opts) => {
    if (opts.invite) {
      const parsed = decodeInvite(opts.invite)
      if (!parsed) throw new Error('Convite inválido. Copia de novo o texto que começa com JANCORD/1/.')
      return net.join(parsed)
    }
    return net.join({
      name: opts.name,
      key: opts.key,
      hosts: opts.host ? [opts.host] : (opts.hosts || []),
      port: opts.port
    })
  })

  ipcMain.handle('net:leave', async () => {
    await net.leave()
    return net.snapshot()
  })

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    packaged: app.isPackaged
  }))
  ipcMain.handle('update:install', async () => {
    autoUpdater.quitAndInstall(false, true)
    return true
  })

  ipcMain.handle('net:send', async (_e, { to, data }) => {
    net.send(to, data)
    return true
  })

  ipcMain.handle('net:invite', async () => net.getInvite())
  ipcMain.handle('net:snapshot', async () => net.snapshot())
  ipcMain.handle('net:random-key', async () => formatKey(randomKey()))
  ipcMain.handle('net:parse-invite', async (_e, raw) => decodeInvite(raw))

  ipcMain.handle('capture:sources', async () => {
    if (process.platform === 'darwin') {
      try { await systemPreferences.askForMediaAccess('camera') } catch {}
      try { await systemPreferences.askForMediaAccess('microphone') } catch {}
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 420, height: 236 },
      fetchWindowIcons: true
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon ? s.appIcon.toDataURL() : null
    }))
  })

  ipcMain.handle('capture:prepare', async (_e, { sourceId, audio }) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1, height: 1 }
    })
    const source = sources.find((s) => s.id === sourceId) || sources[0]
    if (!source) throw new Error('Não achei essa tela.')
    pendingCapture = { source, audio: !!audio }
    return { ok: true, id: source.id, name: source.name }
  })

  ipcMain.handle('capture:clear', async () => {
    pendingCapture = null
    return true
  })

  createWindow()
  boot('window created')
  setupUpdates()
  if (!app.isPackaged) {
    setInterval(() => {
      boot('alive windows=' + BrowserWindow.getAllWindows().length)
    }, 4000)
  }
}).catch((err) => boot('whenReady failed', err))

function setupUpdates() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => boot('update checking'))
  autoUpdater.on('update-available', (info) => {
    boot('update available ' + info.version)
    send('update:status', { state: 'available', version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    send('update:status', { state: 'downloading', percent: Math.round(p.percent || 0) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    boot('update downloaded ' + info.version)
    send('update:status', { state: 'ready', version: info.version })
  })
  autoUpdater.on('update-not-available', () => boot('update none'))
  autoUpdater.on('error', (err) => boot('update error', err))
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => boot('update check failed', err))
  }, 5000)
}

app.on('child-process-gone', (_e, details) => boot('child gone ' + JSON.stringify(details)))
app.on('render-process-gone', (_e, _wc, details) => boot('app renderer gone ' + JSON.stringify(details)))
app.on('window-all-closed', () => {
  boot('window-all-closed')
  if (net) {
    net.leave().catch(() => {}).finally(() => app.quit())
    return
  }
  app.quit()
})

app.on('before-quit', () => {
  pendingCapture = null
})
