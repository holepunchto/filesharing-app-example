import { versions, config, teardown } from 'pear'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import ProtomuxRPC from 'protomux-rpc'
import Localdrive from 'localdrive'
import downloadsFolder from 'downloads-folder'
import $ from 'jquery'

const { app } = await versions()
const userStore = new Corestore(config.storage)
const userDrive = new Hyperdrive(userStore)
const userLocalDrive = new Localdrive(downloadsFolder())
const userProfile = {}
const $peers = $('#peers')
const $userSharedFiles = $('#user-shared-files')
const $uploadFile = $('#upload-file')
const $createFile = $('#create-file')
const $userName = $('#user-name')
const swarm = new Hyperswarm({
  keyPair: await userStore.createKeyPair('first-app')
})
const knownPeersDrives = {}
const knownPeersProfiles = {}
const knownPeersOnlineStatus = {}
const knownPeers = new Hyperbee(userStore.get({
  name: 'peers'
}), {
  keyEncoding: 'utf-8',
  valueEncoding: 'json'
})

// Attach teardown handler before any async calls (after swam has been initiated)
teardown(async () => {
  await swarm.destroy()
  await userStore.close()
})

addDomEventHandlers()
await initSwarm()
await initProfile()
await initAllKnownPeersDrives()
await userDrive.ready()
startFilesWatcher(userDrive)
await render()
console.log('Startup completed')

async function initProfile() {
  const exists = await userDrive.exists('/meta/profile.json')
  if (!exists) await userDrive.put('/meta/profile.json', Buffer.from(JSON.stringify({ name: 'No name' })))
  const storedProfile = JSON.parse(await userDrive.get('/meta/profile.json'))
  Object.assign(userProfile, storedProfile)
}

async function saveProfile() {
  await userDrive.put('/meta/profile.json', Buffer.from(JSON.stringify(userProfile)))
}

async function initAllKnownPeersDrives() {
  for await (const { key, value: { driveKey } } of knownPeers.createReadStream()) {
    console.log(`[initAllKnownPeersDrives] Start init for key=${key} driveKey=${driveKey}`)
    const peerDrive = new Hyperdrive(userStore, driveKey)
    const peerProfile = JSON.parse(await peerDrive.get('/meta/profile.json')) // This await forever until able to get /meta/profile.json
    knownPeersDrives[key] = peerDrive
    knownPeersProfiles[key] = peerProfile
    startMetaWatcher(key)
    startFilesWatcher(peerDrive)
    console.log(`[initAllKnownPeersDrives] Done initiating for name=${peerProfile.name} key=${key} driveKey=${driveKey}`)
  }
}

function addDomEventHandlers() {
  $createFile.on('click', async e => {
    const filename = Math.floor(1000000000 * Math.random())
    await userDrive.put(`/files/${filename}.txt`, Buffer.from('hello world'))
    console.log('Random file added')
  })

  $uploadFile.on('change', async e => {
    for (const file of e.target.files) {
      const data = await file.arrayBuffer()
      userDrive.put(`/files/${file.name}`, data)
    }
  })

  $userName.on('click', async () => {
    const newName = await prompt('What is your new name?', userProfile.name)
    userProfile.name = newName
    await saveProfile()
    render()
  })
}

async function initSwarm() {
  swarm.on('connection', async (conn, info) => {
    const key = conn.remotePublicKey.toString('hex')
    const rpc = new ProtomuxRPC(conn)
    console.log('[connection joined]', info)
    knownPeersOnlineStatus[key] = true

    userStore.replicate(conn)

    // If someone asks who we are, then tell them our driveKey
    rpc.respond('whoareyou', async req => {
      console.log('[whoareyou respond]')
      // TODO: should not send name, but name should be in a profile.json in the hyperdrive
      return Buffer.from(JSON.stringify({
        driveKey: userDrive.key.toString('hex')
      }))
    })

    conn.on('close', () => {
      console.log(`[connection left] ${conn}`)
      delete knownPeersOnlineStatus[key]
      render()
    })

    // If we have never seen the peer before, then ask them who they are so
    // we can get their hyperdrive key.
    // On subsequent boots we already know them, so it doesn't matter if they
    // are online or not, before we can see and download their shared files
    // as long as someone in the network has accessed them.
    const peer = await knownPeers.get(key)
    const isAlreadyKnownPeer = !!peer
    if (isAlreadyKnownPeer) {
      render()
      return
    }

    console.log('[whoareyou request This peer is new, ask them who they are')
    const reply = await rpc.request('whoareyou')
    const { driveKey: peerDriveKey } = JSON.parse(reply.toString())
    await knownPeers.put(key, { driveKey: peerDriveKey })
    const peerDrive = new Hyperdrive(userStore, peerDriveKey)
    const peerProfile = JSON.parse(await peerDrive.get('/meta/profile.json'))
    knownPeersDrives[key] = peerDrive
    knownPeersProfiles[key] = peerProfile
    startMetaWatcher(key)
    startFilesWatcher(peerDrive)
    render()
  })

  // If this is an example app, then this key preferably should not be in sourcecode
  // But the app.key may not exist before `pear stage/release` has been called, so
  // maybe there is another 32-byte key we can use?
  const topic = Buffer.from(app.key || 'W3z8fsASq1O1Zm8oPEvwBYbN2Djsw97R')
  const discovery = swarm.join(topic, { server: true, client: true })
  await discovery.flushed()
}

async function startMetaWatcher(key) {
  const peerDrive = knownPeersDrives[key]
  const watcher = peerDrive.watch('/meta')
  for await (const _ of watcher) {
    console.log(`Peer profile updated key=${key}`)
    knownPeersProfiles[key] = JSON.parse(await peerDrive.get('/meta/profile.json'))
    render()
  }
}

async function startFilesWatcher(drive) {
  const watcher = drive.watch('/files')
  for await (const _ of watcher) {
    render()
  }
}

async function alert(message) {
  return new Promise((resolve) => {
    const $modal = $(`
      <div class="modal">
        <div class="modal__box modal__box--alert">
          <div class="modal__title">
            ${message}
          </div>
          <div class="modal__buttons">
            <button class="modal__confirm">Ok</button>
          </div>
        </div>
      </div>
    `)

    $('.modal__confirm', $modal).on('click', () => {
      $modal.remove()
      resolve()
    })
    $('body').append($modal)
  })
}

async function prompt(message, defaultValue = '') {
  return new Promise((resolve, reject) => {
    const $modal = $(`
      <div class="modal">
        <div class="modal__box modal__box--prompt">
          <div class="modal__title">
            ${message}
          </div>
          <div class="modal__body">
            <input class="modal__input" type="text" value="${defaultValue}" />
          </div>
          <div class="modal__buttons">
            <button class="modal__cancel">Cancel</button>
            <button class="modal__confirm">Done</button>
          </div>
        </div>
      </div>
    `)

    $('.modal__cancel', $modal).on('click', () => {
      $modal.remove()
      reject()
    })
    $('.modal__confirm', $modal).on('click', () => {
      $modal.remove()
      resolve($('.modal__input', $modal).val())
    })
    $('body').append($modal)
  })
}

async function render() {
  const $newPeers = []
  const $newSharedFiles = await renderFolder({ drive: userDrive, allowDeletion: true })
  const hasFiles = $newSharedFiles.length > 0

  for await (const { key } of knownPeers.createReadStream()) {
    $newPeers.push(await renderPeer({ key }))
  }

  $userName.text(`(${userProfile.name})`)
  $peers.empty().append($newPeers)
  $userSharedFiles.empty().append($newSharedFiles)
}

async function renderPeer({ key }) {
  const peerProfile = knownPeersProfiles[key]
  const isOnline = knownPeersOnlineStatus[key]
  const $wrapper = $(`
    <div class="peer">
      <div class="peer__name ${isOnline ? 'peer__name--online' : 'peer__name--offline'}">
        ${peerProfile?.name}
      </div>
      <div class="peer__files"></div>
    </div>
  `)

  const $peerFiles = await renderFolder({
    drive: knownPeersDrives[key],
    allowDeletion: false
  })

  $('.peer__files', $wrapper).append($peerFiles)
  return $wrapper
}

async function renderFolder({ drive, allowDeletion = false }) {
  const $wrapper = $('<div>No files shared</div>')

  if (!drive) return $wrapper

  const $files = []
  const files = drive.list('/files', { recursive: false })
  for await (const file of files) {
    console.log('file', file)
    const $wrapper = $('<div class="file"></div>')
    const filename = file.key.split('/').pop()
    const $file = $(`
      <span class="file__name">
        ${filename}
      </span>
    `)
    $file.on('click', async () => {
      const rs = drive.createReadStream(file.key)
      const ws = userLocalDrive.createWriteStream(filename)
      rs.pipe(ws)
      rs.on('end', () => alert(`${filename} downloaded`))
    })

    const $delete = $(`
      <span class="file__delete">
        ❌
      </span>
    `)
    $delete.on('click', () => drive.del(file.key))

    $wrapper.append($file)
    if (allowDeletion) $wrapper.append($delete)

    $files.push($wrapper)
  }

  const hasFiles = $files.length > 0
  if (hasFiles) $wrapper.empty().append($files)

  return $wrapper
}
