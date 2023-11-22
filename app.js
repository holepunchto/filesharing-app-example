import { versions, config, messages, Window, teardown } from 'pear'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import ProtomuxRPC from 'protomux-rpc'
import Localdrive from 'localdrive'
import path from 'path'
import downloadsFolder from 'downloads-folder'

const { app } = await versions()
const name = pear.config.storage.split('/').pop() // Since we can't pass args to the app for now, this is a hack to do that
const store = new Corestore(pear.config.storage)
const drive = new Hyperdrive(store)
const localDrive = new Localdrive(downloadsFolder())
const $peers = document.querySelector('#peers')
const $files = document.querySelector('#files')
const $uploadFile = document.querySelector('#upload-file')
const $createFile = document.querySelector('#create-file')
const $name = document.querySelector('#name')
const swarm = new Hyperswarm({
  keyPair: await store.createKeyPair('first-app')
})
const knownPeers = new Hyperbee(store.get({
  name: 'peers'
}), {
  keyEncoding: 'utf-8',
  valueEncoding: 'json'
})
const knownPeersDrives = {}

teardown(async () => {
  await swarm.destroy()
  await store.close()
})

initFileInputs()
await initSwarm()
await initAllDrives()
await drive.ready()
startWatcher(drive)
await render()
console.log('Startup completed')

// get all known peers from hyperbee and connect to their hyperdrive
// const allPeers = await db.getAll()
// allPeers.forEach(peer => new Hyperdrive(store, peer.driveKey))

async function initAllDrives() {
  for await (const { key, value: { name, driveKey } } of knownPeers.createReadStream()) {
    console.log(`[initAllDrives] Start drive for ${name}(${key})`)
    const peerDrive = new Hyperdrive(store, driveKey)
    knownPeersDrives[key] = peerDrive
    startWatcher(peerDrive)
  }
}

function initFileInputs() {
  $createFile.addEventListener('click', async e => {
    const filename = Math.floor(1000000000 * Math.random())
    await drive.put(`/${filename}.txt`, Buffer.from('hello world'))
    console.log('Random file added')
  })

  $uploadFile.addEventListener('change', async e => {
    for (const file of e.target.files) {
      const data = await file.arrayBuffer()
      drive.put(`/${file.name}`, data)
    }
  })
}

async function initSwarm() {
  swarm.on('connection', async (conn, info) => {
    const key = conn.remotePublicKey.toString('hex')
    const rpc = new ProtomuxRPC(conn)
    console.log('[connection joined]', info)

    store.replicate(conn)
    // If someone asks who we are, then tell them
    rpc.respond('whoareyou', async req => {
      console.log('[whoareyou respond]')
      // should not send name, but name should be in a profile.json in the hyperdrive
      return Buffer.from(JSON.stringify({ name, driveKey: drive.key.toString('hex') }))
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
    const { name: peerName, driveKey: peerDriveKey } = JSON.parse(reply.toString())
    await knownPeers.put(key, { name: peerName, driveKey: peerDriveKey })

    console.log(`[whoareyou response] peerName=${peerName} peerDriveKey=${peerDriveKey}`)
    // conn.name = name
    // const drive = new Hyperdrive(store, driveKey)
    // await drive.ready()
    // const files = await ls({ drive, path: '/' })
    // conn.drive = drive
    // startWatcher(drive) // render, when a file is added/removed
    // render()
  })

  // If this is an example app, then this key preferably should not be in sourcecode
  // But the app.key may not exist before `pear stage/release` has been called, so
  // maybe there is another 32-byte key we can use?
  const topic = Buffer.from(app.key || 'W3z8fsASq1O1Zm8oPEvwBYbN2Djsw97R')
  const discovery = swarm.join(topic, { server: true, client: true })
  await discovery.flushed()
}

async function startWatcher(drive) {
  console.log('[startWatcher]')
  const watcher = drive.watch('/')
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
  const filesElems = await renderFolderDom({ drive, allowDeletion: true })
  const hasFiles = filesElems.length > 0
  const peersElems = []

  for await (const { key, value: { name } } of knownPeers.createReadStream()) {
    const $wrapper = document.createElement('div')

    const $name = document.createElement('div')
    $name.innerText = name

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

  $name.innerText = `(${name})`
  $peers.replaceChildren(...peersElems)
  $files.replaceChildren(...filesElems)
}

async function renderFolderDom({ drive, allowDeletion = false }) {
  if (!drive) return []

  const files = await ls({ drive, path: '/' })
  const filesElems = []
  for (const file of files) {
    const $wrapper = document.createElement('div')

    const $file = document.createElement('span')
    $file.className = 'file'
    $file.innerText = file.key
    $file.addEventListener('click', async () => {
      const rs = drive.createReadStream(file.key)
      const ws = localDrive.createWriteStream(file.key)
      rs.pipe(ws)
    })

    const $delete = document.createElement('span')
    $delete.className = 'delete'
    $delete.innerText = '❌'
    $delete.addEventListener('click', () => drive.del(file.key))

    $wrapper.appendChild($file)
    if (allowDeletion) $wrapper.appendChild($delete)

    filesElems.push($wrapper)
  }

  return filesElems
}
