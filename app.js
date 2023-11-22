import { versions, config, teardown } from 'pear'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import ProtomuxRPC from 'protomux-rpc'
import Localdrive from 'localdrive'
import downloadsFolder from 'downloads-folder'

const { app } = await versions()
const userStore = new Corestore(config.storage)
const userDrive = new Hyperdrive(userStore)
const userLocalDrive = new Localdrive(downloadsFolder())
const userProfile = {}
const $peers = document.querySelector('#peers')
const $files = document.querySelector('#files')
const $uploadFile = document.querySelector('#upload-file')
const $createFile = document.querySelector('#create-file')
const $name = document.querySelector('#name')
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
  $createFile.addEventListener('click', async e => {
    const filename = Math.floor(1000000000 * Math.random())
    await userDrive.put(`/files/${filename}.txt`, Buffer.from('hello world'))
    console.log('Random file added')
  })

  $uploadFile.addEventListener('change', async e => {
    for (const file of e.target.files) {
      const data = await file.arrayBuffer()
      userDrive.put(`/files/${file.name}`, data)
    }
  })

  $name.addEventListener('click', async () => {
    const newName = `i_am_${Math.floor(1000 * Math.random())}`
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
      render()
    })

    // If we have never seen the peer before, then ask them who they are so
    // we can get their hyperdrive key.
    // On subsequent boots we already know them, so it doesn't matter if they
    // are online or not, before we can see and download their shared files
    const peer = await knownPeers.get(key)
    const knowsPeer = !!peer
    if (knowsPeer) return

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
    console.log(`[whoareyou response] peerDriveKey=${peerDriveKey}`)
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

async function ls({ drive, path }) {
  const stream = drive.list(path, {
    recursive: false
  })
  const files = []
  for await (const file of stream) {
    files.push(file)
  }

  return files
}

async function render() {
  // const peersConn = swarm.connections
  // const hasPeers = peersConn.size > 0
  const filesElems = await renderFolderDom({ userDrive, allowDeletion: true })
  const hasFiles = filesElems.length > 0
  const peersElems = []

  for await (const { key } of knownPeers.createReadStream()) {
    const peerProfile = knownPeersProfiles[key]
    const $wrapper = document.createElement('div')

    const $name = document.createElement('div')
    $name.innerText = peerProfile.name

    const $files = document.createElement('div')
    $files.innerText = 'No files shared'
    const peerFilesElems = await renderFolderDom({
      drive: knownPeersDrives[key],
      allowDeletion: false
    })
    const hasFiles = peerFilesElems.length > 0
    if (hasFiles) $files.replaceChildren(...peerFilesElems)

    $wrapper.appendChild($name)
    $wrapper.appendChild($files)
    peersElems.push($wrapper)
  }

  $name.innerText = `(${userProfile.name})`
  $peers.replaceChildren(...peersElems)
  $files.replaceChildren(...filesElems)
}

async function renderFolderDom({ drive, allowDeletion = false }) {
  if (!drive) return []

  const files = await ls({ drive, path: '/files' })
  const filesElems = []
  for (const file of files) {
    const $wrapper = document.createElement('div')

    const $file = document.createElement('span')
    $file.classList.add('file')
    $file.innerText = file.key
    $file.addEventListener('click', async () => {
      const rs = drive.createReadStream(file.key)
      const ws = userLocalDrive.createWriteStream(file.key)
      rs.pipe(ws)
    })

    const $delete = document.createElement('span')
    $delete.classList.add('delete')
    $delete.innerText = '❌'
    $delete.addEventListener('click', () => drive.del(file.key))

    $wrapper.appendChild($file)
    if (allowDeletion) $wrapper.appendChild($delete)

    filesElems.push($wrapper)
  }

  return filesElems
}
