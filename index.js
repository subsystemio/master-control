#!/usr/bin/env bare
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const env = require('bare-env')
const b4a = require('b4a')
const { command, flag, summary, description, header, footer, bail } = require('paparam')

// Master Control Program. One daemon per installation, any number of consoles. Operators talk to
// the daemon, never to a subsystem — that is what keeps a card's trust list to a single entry it
// never has to change.

// State must NOT live beside the code. Installed globally, __dirname is inside node_modules, so an
// upgrade or reinstall would delete this MCP's identity — and every card in the field carries the
// matching public key, so losing it orphans the whole fleet at once.
function resolveDir(explicit) {
  if (explicit) return path.resolve(explicit)
  if (env.MCP_DIR) return path.resolve(env.MCP_DIR)
  // A checkout that already holds state keeps using it, so an existing install is never moved out
  // from under a live fleet.
  //
  // Keyed on .mcp-key — the public mirror — and NOT on .identity. If .identity is the thing that
  // went missing, this directory must still win, so that start()'s "refuse rather than mint" guard
  // is the code that speaks. Keying on .identity meant a lost private key silently relocated the
  // whole MCP to a fresh directory and minted a new fleet, which is the one failure this project
  // exists to prevent. It cost a real identity here before anyone had shipped a card.
  if (fs.existsSync(path.join(__dirname, '.mcp-key'))) return __dirname
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
    console.log('[mcp] key ' + mcp.pubkey)
    console.log('[mcp] put that on a card as `mcp = …` in its config.txt')
  }
)

const key = command(
  'key',
  summary("print this MCP's public key — what goes on every card"),
  flag('--dir [path]', 'where the identity lives'),
  (cmd) => {
    const dir = resolveDir(cmd.flags.dir)
    console.log(readKey(dir, '.mcp-key') || 'no key yet — run `mcp` once (state: ' + dir + ')')
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
