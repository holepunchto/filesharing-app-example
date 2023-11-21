import { versions, config, messages, Window, teardown } from 'pear'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import ProtomuxRPC from 'protomux-rpc'
import Localdrive from 'localdrive'
import path from 'path'

const { app } = await versions()
const name = pear.config.storage.split('/').pop() // Since we can't pass args to the app for now, this is a hack to do that
const store = new Corestore(pear.config.storage)
const drive = new Hyperdrive(store)
const localDrive = new Localdrive('./files') // Would prefer to have a "save as.." filer
const peers = {}
const $peers = document.querySelector('#peers')
const $files = document.querySelector('#files')
const $uploadFile = document.querySelector('#upload-file')
const $createFile = document.querySelector('#create-file')
const $name = document.querySelector('#name')
const swarm = new Hyperswarm({
  keyPair: await store.createKeyPair('first-app')
})

teardown(async () => {
  await swarm.destroy()
  await store.close()
})

initFileInputs()
await initSwarm()
await drive.ready()
startWatcher(drive)
await render()
console.log('Startup completed')

async function startWatcher(drive) {
  const watcher = drive.watch('/')
  for await (const _ of watcher) {
    render()
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
  swarm.on('connection', (conn, info) => {
    console.log('[connection joined]', info)

    const key = info.publicKey.toString('hex')
    peers[key] = conn

    conn.setKeepAlive(5000)

    store.replicate(conn)

    const rpc = new ProtomuxRPC(conn)
    // Register for when the peer says hello to us
    rpc.respond('hello', async req => {
      const { name, driveKey } = JSON.parse(req.toString())
      console.log(`[hello] name=${name} driveKey=${driveKey}`)
      conn.name = name
      const drive = new Hyperdrive(store, driveKey)
      await drive.ready()
      const files = await ls({ drive, path: '/' })
      conn.drive = drive
      startWatcher(drive) // render, when a file is added/removed
      render()
    })

    // Say hello to the peer
    rpc.request('hello', Buffer.from(JSON.stringify({ name, driveKey: drive.key.toString('hex') })))

    conn.on('error', err => console.error(err)) // Needed because otherwise teardowns result in exceptions
    conn.on('close', async () => {
      delete peers[key]
      console.log(`[connection left] ${conn.name}`)
      render()
    })

    render()
  })

  const topic = Buffer.from(app.key || 'W3z8fsASq1O1Zm8oPEvwBYbN2Djsw97R')
  const discovery = swarm.join(topic, { server: true, client: true })
  await discovery.flushed()
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
  const peersConn = Object.values(peers)
  const hasPeers = peersConn.length > 0
  const filesElems = await generateFolderDom({ drive, allowDeletion: true })
  const hasFiles = filesElems.length > 0

  const peersElems = []
  for (const conn of peersConn) {
    const $wrapper = document.createElement('div')

    const $name = document.createElement('div')
    $name.innerText = conn.name

    const $files = document.createElement('div')
    $files.innerText = 'No files shared'
    const peerFilesElems = await generateFolderDom({
      drive: conn.drive,
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

async function generateFolderDom({ drive, allowDeletion = false }) {
  if (!drive) return []
  const files = await ls({ drive, path: '/' })
  const filesElems = []
  for (const file of files) {
    const $wrapper = document.createElement('div')

    const $file = document.createElement('span')
    $file.className = 'file'
    $file.innerText = file.key
    $file.addEventListener('click', async () => {
      const buffer = await drive.get(file.key)
      await localDrive.put(file.key, buffer)
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
