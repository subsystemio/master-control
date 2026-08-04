#!/usr/bin/env bare
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const env = require('bare-env')
const b4a = require('b4a')
const { command, flag, arg, summary, description, header, footer, bail } = require('paparam')
const attest = require('@subsystemio/runtime').attest

// Master Control Program. One daemon per installation, any number of consoles. Operators talk to
// the daemon, never to a subsystem — that is what keeps a card's trust list to a single entry it
// never has to change.

// State must NOT live beside the code. Installed globally, __dirname is inside node_modules, so an
// upgrade or reinstall would delete this MCP's identity — and every card in the field carries the
// matching public key, so losing it orphans the whole fleet at once.
function resolveDir(explicit) {
  if (explicit) return path.resolve(explicit)
  if (env.MCP_DIR) return path.resolve(env.MCP_DIR)
  return path.join(os.homedir(), '.master-control')
}

function readKey(dir, name) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) return null
  return b4a.toString(fs.readFileSync(file), 'utf8').trim()
}

async function runTUI(controller) {
  const { Program } = require('bare-tui')
  const { ConsoleModel } = require('./lib/tui.js')
  await new Program(new ConsoleModel(controller)).run()
}

async function attach(dir, host) {
  if (!host) {
    console.log('no mcp to attach to, and this machine has no identity yet.')
    console.log('  host one here:   mcp')
    console.log('  or point at one: mcp --host=<64-hex>')
    return Bare.exit(1)
  }
  const { Client } = require('./lib/client.js')
  const client = new Client({ dir: path.join(dir, '.operator'), mcpKey: host, onLog: () => {} })
  await client.start()
  try {
    await runTUI(client)
  } finally {
    await client.close()
  }
}

// `mcp` with no subcommand: host the fleet if nothing else here is, otherwise attach as a console.
//
// The singleton lock decides, not a flag — whoever holds loopback 9599 is the daemon. That makes
// the common case one command: run `mcp`, subsystems connect to you, and other operators can join
// over the swarm. Quitting takes the daemon with it, which is what you want for a session at a
// venue, and is exactly what `mcp install` is for when it is not.
async function consoleOrHost(flags) {
  const dir = resolveDir(flags.dir)
  if (flags.host) return attach(dir, flags.host)

  fs.mkdirSync(dir, { recursive: true })
  const { MCP } = require('./lib/mcp.js')
  const mcp = new MCP({ dir, privateRoom: !!flags.privateRoom, onLog: () => {} })

  try {
    await mcp.start()
  } catch (err) {
    if (err.code !== 'ELOCKED') throw err
    return attach(dir, readKey(dir, '.mcp-key'))
  }

  const { LocalController } = require('./lib/local.js')
  mcp.log('hosting — others can attach with  mcp --host=' + mcp.pubkey)
  try {
    await runTUI(new LocalController(mcp))
  } finally {
    await mcp.close()
  }
}

const serve = command(
  'serve',
  summary('run the daemon headless, in the foreground'),
  description('What a systemd unit runs. Plain `mcp` gives you a daemon and a console together.'),
  flag('--dir [path]', 'where the identity, roster and room secret live'),
  flag('--private-room', 'mint a room secret, so the fleet cannot even be found'),
  async (cmd) => {
    const dir = resolveDir(cmd.flags.dir)
    fs.mkdirSync(dir, { recursive: true })
    const { MCP } = require('./lib/mcp.js')
    const mcp = new MCP({
      dir,
      privateRoom: !!cmd.flags.privateRoom,
      onLog: (l) => console.log('[mcp]', l)
    })
    await mcp.start()
    console.log('[mcp] state ' + dir)
    console.log('[mcp] device ' + mcp.pubkey)
    if (mcp.identityKey) {
      console.log('[mcp] identity ' + b4a.toString(mcp.identityKey, 'hex'))
      console.log('[mcp] put the identity on a card as `mcp = …` in its config.txt')
    }
  }
)

// What goes on a card: the ROOT identity, not this box's key. That indirection is the point — the
// box can be replaced and the cards never change.
const key = command(
  'key',
  summary('print the fleet identity key — what goes on every card'),
  flag('--dir [path]', 'where the state lives'),
  (cmd) => {
    const dir = resolveDir(cmd.flags.dir)
    // Derived from the proof, not read from a mirror: one source of truth, and it is correct the
    // moment a proof is imported rather than after the next start.
    const file = path.join(dir, '.proof')
    if (fs.existsSync(file)) {
      const id = attest.identityOf(fs.readFileSync(file))
      if (id) return console.log(b4a.toString(id, 'hex'))
    }
    console.log('not attested yet — no identity key (state: ' + dir + ')')
    console.log('  mcp identity          # once, on an offline machine: mint the fleet identity')
    console.log("  mcp device            # this box's key, which you attest")
    console.log('  mcp attest <key>      # offline, with the words')
    console.log('  mcp proof <hex>       # import the result here')
  }
)

const device = command(
  'device',
  summary("print this box's own key — the one you attest"),
  flag('--dir [path]', 'where the state lives'),
  (cmd) => {
    const dir = resolveDir(cmd.flags.dir)
    console.log(readKey(dir, '.mcp-key') || 'no key yet — run `mcp` once (state: ' + dir + ')')
  }
)

// The root secret never touches this machine. These two run on an offline box; only the resulting
// proof — which grants nothing on its own — comes back.
const identityCmd = command(
  'identity',
  summary('mint a new fleet identity (offline machine only)'),
  description(
    'Prints 24 words ONCE. They are the fleet: whoever has them can attest any box, forever, and\n' +
      'no card can be told otherwise without reflashing. Write them down, store them offline, and\n' +
      'do not put them on the MCP box.'
  ),
  async () => {
    const mnemonic = attest.generateMnemonic()
    const identityKey = await attest.identityKeyOf(mnemonic)
    console.log('')
    console.log('  ' + mnemonic)
    console.log('')
    console.log('identity key: ' + b4a.toString(identityKey, 'hex'))
    console.log('')
    console.log('That key goes on every card. The words go nowhere near this fleet.')
  }
)

const attestCmd = command(
  'attest',
  summary('attest a box into the fleet (offline machine only)'),
  description(
    'Reads the words from --words=<file>, or from stdin. Prints a proof to import with `mcp proof`.'
  ),
  arg('<key>', "the box's device key, from `mcp device`"),
  flag('--words [file]', 'file holding the mnemonic; omit to read stdin'),
  async (cmd) => {
    const deviceKey = cmd.args.key.trim()
    if (!/^[0-9a-f]{64}$/i.test(deviceKey)) throw new Error('a device key is 64 hex characters')

    const src = cmd.flags.words || '/dev/stdin'
    const mnemonic = b4a.toString(fs.readFileSync(src), 'utf8').trim()
    if (!mnemonic) throw new Error('no mnemonic given — pass --words=<file> or pipe it in')

    const proof = await attest.attest(mnemonic, b4a.from(deviceKey, 'hex'))
    console.log(b4a.toString(proof, 'hex'))
  }
)

const proofCmd = command(
  'proof',
  summary("import this box's attestation, or print the current one"),
  arg('[hex]', 'the proof from `mcp attest`; omit to print what is installed'),
  flag('--dir [path]', 'where the state lives'),
  (cmd) => {
    const dir = resolveDir(cmd.flags.dir)
    const file = path.join(dir, '.proof')
    if (!cmd.args.hex) {
      if (!fs.existsSync(file)) return console.log('no proof installed (state: ' + dir + ')')
      return console.log(b4a.toString(fs.readFileSync(file), 'hex'))
    }

    const proof = b4a.from(cmd.args.hex.trim(), 'hex')
    const mine = readKey(dir, '.mcp-key')
    const attested = attest.deviceOf(proof)
    if (!attested) throw new Error('that is not a readable proof')
    // Refuse a proof for another box here, rather than letting every prop reject us silently.
    if (mine && b4a.toString(attested, 'hex') !== mine) {
      throw new Error(
        'that proof attests ' +
          b4a.toString(attested, 'hex').slice(0, 12) +
          '… but this box is ' +
          mine.slice(0, 12) +
          '…'
      )
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, proof)
    console.log('installed — identity ' + b4a.toString(attest.identityOf(proof), 'hex'))
  }
)

const room = command(
  'room',
  summary('print the room secret, if this fleet is private'),
  flag('--dir [path]', 'where the room secret lives'),
  (cmd) => {
    const dir = resolveDir(cmd.flags.dir)
    console.log(
      readKey(dir, '.room-key') || 'no room secret — this fleet is public (state: ' + dir + ')'
    )
  }
)

const install = command(
  'install',
  summary('keep the daemon running across reboots, via systemd'),
  description(
    'Optional. Running `mcp` already hosts the fleet while the console is open; install a unit\n' +
      'when a box should simply always be the MCP.'
  ),
  flag('--dir [path]', 'where the identity lives'),
  flag('--system', 'a system unit (needs sudo) instead of a user unit'),
  flag('--private-room', 'pass --private-room to the daemon'),
  (cmd) =>
    require('./lib/systemd.js').install({
      dir: resolveDir(cmd.flags.dir),
      privateRoom: !!cmd.flags.privateRoom,
      user: !cmd.flags.system
    })
)

const uninstall = command(
  'uninstall',
  summary('remove the systemd unit; the identity is left alone'),
  flag('--system', 'remove the system unit instead of the user unit'),
  (cmd) => require('./lib/systemd.js').uninstall({ user: !cmd.flags.system })
)

// paparam throws a raw Bail otherwise, which reads like a crash for what is usually a typo.
function onBail(b) {
  if (b.err) console.error('mcp: ' + b.err.message)
  else if (b.reason === 'UNKNOWN_FLAG') console.error('mcp: unknown flag --' + b.flag.name)
  else if (b.reason === 'UNKNOWN_ARG') console.error('mcp: unknown command or argument')
  else if (b.reason === 'MISSING_ARG') console.error('mcp: missing argument')
  else console.error('mcp: ' + b.reason)
  console.error("try 'mcp --help'")
  Bare.exit(1)
}

const mcp = command(
  'mcp',
  bail(onBail),
  header('Master Control Program'),
  summary('watch and drive a fleet of subsystems'),
  description(
    'With no subcommand: opens the console, and hosts the fleet itself if nothing else on this\n' +
      'machine already is. Other operators attach over the swarm with --host.'
  ),
  flag('--host [64-hex]', 'attach to an MCP elsewhere instead of hosting'),
  flag('--dir [path]', 'where the identity, roster and room secret live'),
  flag('--private-room', 'when hosting, mint a room secret'),
  footer('one daemon per installation — the loopback lock on 9599 decides which process it is'),
  serve,
  key,
  device,
  identityCmd,
  attestCmd,
  proofCmd,
  room,
  install,
  uninstall,
  (cmd) => consoleOrHost(cmd.flags)
)

const parsed = mcp.parse(Bare.argv.slice(2))
if (parsed && parsed.running) {
  parsed.running.catch((e) => {
    console.error('[mcp] ' + (e && e.message ? e.message : e))
    Bare.exit(1)
  })
}
