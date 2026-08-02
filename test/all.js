const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const b4a = require('b4a')
const { UIHost, IPC, Link, room } = require('@subsystemio/runtime')
const { roomKey } = room
const { MCP } = require('../lib/mcp.js')
const { Client } = require('../lib/client.js')
const { Roster } = require('../lib/roster.js')

// Real peers on a local DHT — no mocks, and no waiting on the public network.
async function fleet(t, { privateRoom = false } = {}) {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = testnet.bootstrap
  const root = path.join(os.tmpdir(), 'mcp-test-' + Math.floor(Date.now() + Math.random() * 1e6))

  // lockPort 0: several MCPs share this process, which the real singleton lock forbids
  const mcp = new MCP({
    dir: path.join(root, 'mcp'),
    bootstrap,
    privateRoom,
    lockPort: 0,
    onLog: () => {}
  })
  fs.mkdirSync(path.join(root, 'mcp'), { recursive: true })
  await mcp.start()

  const made = []
  const addSubsystem = async (app, opts = {}) => {
    const dir = path.join(root, 'sub' + made.length)
    fs.mkdirSync(dir, { recursive: true })
    const ui = new UIHost({ port: 0, log: () => {} })
    const ipc = new IPC(ui, { log: () => {} })
    await app(ipc, () => {})
    const link = new Link(ipc, {
      mcpKey: mcp.pubkey,
      roomKey: 'roomKey' in opts ? opts.roomKey : mcp.roomKey,
      storeDir: path.join(dir, '.identity'),
      bootstrap,
      log: () => {}
    })
    link.open()
    made.push(link)
    return { ipc, link }
  }

  const addOperator = async () => {
    const dir = path.join(root, 'op' + made.length)
    fs.mkdirSync(dir, { recursive: true })
    const c = new Client({ dir, mcpKey: mcp.pubkey, bootstrap, onLog: () => {} })
    await c.start()
    made.push(c)
    return c
  }

  t.teardown(async () => {
    for (const m of made) await m.close()
    await mcp.close()
    try {
      fs.rmSync(root, { recursive: true })
    } catch {}
  })

  return { mcp, addSubsystem, addOperator }
}

const until = async (fn, ms = 20000) => {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

// the smallest possible subsystem
const counter = (ipc, ready) => {
  let n = 0
  ipc.describe({
    id: 'counter',
    version: '1.0.0',
    commands: [{ name: 'bump' }],
    events: [{ name: 'bumped' }],
    state: [{ name: 'done', type: 'bool', display: 'tick', role: 'terminal' }]
  })
  ipc.onCommand((name) => {
    if (name !== 'bump') throw new Error('unknown command: ' + name)
    n++
    ipc.emit('bumped', { n })
    ipc.reportState({ done: n >= 2, n })
    return n
  })
  ipc.reportState({ done: false, n: 0 })
  if (ready) ready()
  return async () => {}
}

test('an mcp discovers a subsystem and reads its manifest', async function (t) {
  const { mcp, addSubsystem } = await fleet(t)
  await addSubsystem(counter)

  const rec = await until(() => [...mcp.subsystems.values()].find((r) => r.caps && r.caps.id))
  t.ok(rec, 'the subsystem was found')
  t.is(rec.appId, 'counter')
  t.is(rec.caps.commands[0].name, 'bump')
  t.absent(rec.adopted, 'unknown subsystems arrive un-adopted')
})

test('an un-adopted subsystem cannot be commanded, an adopted one can', async function (t) {
  const { mcp, addSubsystem, addOperator } = await fleet(t)
  await addSubsystem(counter)
  const op = await addOperator()

  await until(() => op.admin, 20000)
  t.ok(op.admin, 'the first operator on an empty roster becomes admin')

  const key = await until(() => [...op.subsystems.keys()][0])
  t.ok(key, 'the operator sees the fleet through the mcp')

  op.command(key, 'bump', {})
  await new Promise((r) => setTimeout(r, 500))
  t.absent(
    await until(() => (op.subsystems.get(key).state || {}).n, 1500),
    'refused while un-adopted'
  )

  op.adopt(key, true)
  await until(() => op.subsystems.get(key).adopted)
  op.command(key, 'bump', {})

  const n = await until(() => (op.subsystems.get(key).state || {}).n)
  t.is(n, 1, 'the command lands once adopted')
  t.ok(mcp.roster.has(key, 'subsystem'), 'adoption is persisted to the roster')
})

test('a second operator watches but cannot command until adopted', async function (t) {
  const { addSubsystem, addOperator } = await fleet(t)
  await addSubsystem(counter)

  const admin = await addOperator()
  await until(() => admin.admin)
  const key = await until(() => [...admin.subsystems.keys()][0])
  admin.adopt(key, true)
  await until(() => admin.subsystems.get(key).adopted)

  const guest = await addOperator()
  await until(() => guest.role !== 'connecting')
  t.is(guest.role, 'pending', 'a second, unlisted operator is not an admin')
  t.absent(guest.admin)

  t.ok(await until(() => guest.subsystems.get(key)), 'but it still sees the whole fleet')

  guest.command(key, 'bump', {})
  await new Promise((r) => setTimeout(r, 800))
  t.absent((guest.subsystems.get(key).state || {}).n, 'its command is refused')
})

test('a private room changes the topic without changing authority', async function (t) {
  const open = await fleet(t)
  const closed = await fleet(t, { privateRoom: true })

  t.ok(closed.mcp.roomKey, 'a private room mints a secret')
  t.absent(open.mcp.roomKey, 'an open one does not')
  t.unlike(closed.mcp.topic, open.mcp.topic, 'the topics differ')
})

test('in a private room the capability gate admits only the right secret', async function (t) {
  const { mcp, addSubsystem } = await fleet(t, { privateRoom: true })

  await addSubsystem(counter) // gets the real room key from the fixture
  await addSubsystem(counter, { roomKey: roomKey('some other room') })

  const seen = await until(() => {
    const named = [...mcp.subsystems.values()].filter((r) => r.caps && r.caps.id)
    return named.length ? named : null
  })

  t.is(seen.length, 1, 'exactly one subsystem got through')
  t.is(mcp.subsystems.size, 1, 'the wrong secret never became a subsystem at all')
})

test('the roster round-trips through disk', async function (t) {
  const file = path.join(os.tmpdir(), 'roster-' + Date.now() + '.txt')
  t.teardown(() => {
    try {
      fs.rmSync(file)
    } catch {}
  })

  const key = b4a.toString(b4a.alloc(32, 7), 'hex')
  new Roster(file).adopt(key, 'subsystem', 'front desk')

  const reloaded = new Roster(file)
  t.ok(reloaded.has(key, 'subsystem'))
  t.is(reloaded.get(key).name, 'front desk')
  t.absent(reloaded.has(key, 'operator'), 'kind is part of the check')

  reloaded.revoke(key)
  t.absent(new Roster(file).has(key), 'revoking survives a reload')
})
