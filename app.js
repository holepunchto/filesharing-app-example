import { versions, config, messages, Window, teardown } from 'pear'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import ProtomuxRPC from 'protomux-rpc'

const { app } = await versions()
const name = pear.config.storage.split('/').pop() // Since we can't pass args to the app for now, this is a hack to do that
const store = new Corestore(pear.config.storage)
const drive = new Hyperdrive(store)
const peers = {}
const $peers = document.querySelector('#peers')
const $files = document.querySelector('#files')
const $file = document.querySelector('#file')
const $name = document.querySelector('#name')
const swarm = new Hyperswarm({
  keyPair: await store.createKeyPair('first-app')
})
let sharedFilename

initFileInput()
await initSwarm()
await drive.ready()
drive.findingPeers()
startWatcher()
await render()
// await drive.put('/hello_world.txt', Buffer.from('hello world'))
console.log('Startup completed')


async function startWatcher() {
  const watcher = drive.watch('/')
  for await (const [current, previous] of watcher) {
    console.log(current.version)
    console.log(previous.version)
  }
}

function initFileInput() {
  $file.addEventListener('change', e => {
    console.log(e.target.files)
    const hasFiles = e.target.files.length > 0
    if (!hasFiles) return
    sharedFilename = e.target.files[0].name
    Object.values(peers).forEach(conn => conn.write(JSON.stringify({ type: 'file', filename: sharedFilename })))
  })
}

async function initSwarm() {
  teardown(() => swarm.destroy())

  swarm.on('connection', (conn, info) => {
    console.log('[connection joined]', info)

    const key = info.publicKey.join(',')
    peers[key] = conn

    conn.setKeepAlive(5000)
    // conn.write(JSON.stringify({ type: 'init', name, driveDiscoveryKey: drive.discoveryKey }))

    // store.replicate(conn)
    drive.replicate(conn)

    if (sharedFilename) {
      conn.write(JSOIN.stringify({ type: 'file', filename: sharedFilename }))
    }

    const rpc = new ProtomuxRPC(conn)
    // Register for when the peer says hello to us
    rpc.respond('hello', req => {
      const { name, driveDiscoveryKey } = JSON.parse(req.toString())
      conn.name = name
      conn.drive = new Hyperdrive(store, driveDiscoveryKey)
      console.log('received hello')
      console.log(name, driveDiscoveryKey)
      render()
    })
    // Say hello to the peer
    rpc.request('hello', Buffer.from(JSON.stringify({ name, driveDiscoveryKey: drive.discoveryKey })))

    // conn.on('data', data => {
    //   console.log('[on(data)]', data.toString())

    //   // try-catch needed because we sometimes got empty data. Not sure why we got this or where we got it from
    //   let msg
    //   try {
    //     msg = JSON.parse(data)
    //   } catch (err) {
    //     console.error(err)
    //     console.log(`[error] Incorrect data received from key=${key} data=${data}`)
    //     return
    //   }

    //   const { type } = msg
    //     if (type === 'init') {
    //       const { name, driveDiscoveryKey } = msg
    //       conn.name = name
    //       // conn.driveDiscoveryKey = driveDiscoveryKey
    //       conn.driveClone = new Hyperdrive(store, conn.driveDiscoveryKey)
    //       console.log(`[init] name=${name} driveDiscoveryKey=${driveDiscoveryKey}`)
    //       render()
    //     }

    //     if (type === 'file') {
    //       const { filename } = msg
    //       conn.filename = filename
    //       console.log(`[file] name=${conn.name} filename=${conn.filename}`)
    //       render()
    //     }
    // })
    conn.on('error', err => console.error(err)) // Needed because otherwise teardowns result in exceptions
    conn.on('close', () => {
      delete peers[key]
      console.log(`[connection left] ${conn.name || 'No name'}`) // (${key})`)
      render()
    })

    render()
  })
  const topic = Buffer.from(app.key || 'W3z8fsASq1O1Zm8oPEvwBYbN2Djsw97R')
  const discovery = swarm.join(topic, { server: true, client: true })
  await discovery.flushed()
}

async function ls(path) {
  const stream = await drive.list(path, {
    recursive: false
  })
  const files = []
  for await (const f of stream) {
    files.push(f)
  }
  return files
}

async function render() {
  const files = await ls('/')
  const peersSockets = Object.entries(peers)
  const hasPeers = peersSockets.length > 0
  const hasFiles = files.length > 0
  const peersElems = peersSockets.map(([id, conn]) => `
    <div>
      ${conn.name || 'No name'}
      ${conn.filename
      ? `(<a href="#">${conn.filename}</a>)`
      : ''
    }
    </div>
  `)
  const filesElems = files.map(({ key }) => `
    <div>
      ${key}
    </div>
  `)

  $name.innerText = `(${name})`
  $peers.innerHTML = `
    <div>
      ${hasPeers ? peersElems.join('\n') : 'No peers connected'}
    </div>
  `
  $files.innerHTML = `
    <div>
      ${hasFiles ? filesElems.join('\n') : 'No files in this folder'}
    </div>
  `
}
