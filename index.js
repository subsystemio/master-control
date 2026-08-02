#!/usr/bin/env bare
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const env = require('bare-env')
const b4a = require('b4a')

// Master Control Program.
//
//   mcp serve [--private-room]     run the daemon: dial the fleet, serve operators
//   mcp [--host=<64-hex>]          operator console; defaults to the daemon on this machine
//   mcp key                        print this MCP's public key (what goes on a card)
//   mcp room                       print the room secret, if this fleet is private
//
//   --dir=<path>                   where this MCP keeps its identity, roster and room secret
//
// One daemon per installation, any number of consoles. Operators talk to the daemon, never to a
// subsystem — that is what keeps a card's trust list to a single entry it never has to change.
const argv = Bare.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith('-')) || 'console'

function flag(name) {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit && hit.slice(name.length + 3)
}

// State must NOT live beside the code. Installed globally, __dirname is inside node_modules, so an
// upgrade or reinstall would delete this MCP's identity — and every card in the field carries the
// matching public key, so losing it orphans the whole fleet at once.
function resolveDir() {
  const explicit = flag('dir') || env.MCP_DIR
  if (explicit) return path.resolve(explicit)
  // A checkout that already holds an identity keeps using it. Moving state out from under a live
  // fleet would orphan it just as surely as deleting it.
  if (fs.existsSync(path.join(__dirname, '.identity'))) return __dirname
  return path.join(os.homedir(), '.master-control')
}

const DIR = resolveDir()

// A console on the same machine as the daemon needs no configuration at all. `subsystem-image`
// reads both of these too, so a card gets its settings from the MCP itself rather than from
// somebody's checkout path.
function readKey(name) {
  const file = path.join(DIR, name)
  if (!fs.existsSync(file)) return null
  return b4a.toString(fs.readFileSync(file), 'utf8').trim()
}

function localKey() {
  return readKey('.mcp-key')
}

async function serve() {
  fs.mkdirSync(DIR, { recursive: true })
  const { MCP } = require('./lib/mcp.js')
  const mcp = new MCP({
    dir: DIR,
    privateRoom: argv.includes('--private-room'),
    onLog: (l) => console.log('[mcp]', l)
  })
  await mcp.start()
  console.log('[mcp] state ' + DIR)
  console.log('[mcp] key ' + mcp.pubkey)
  console.log('[mcp] put that on a card as `mcp = …` in its config.txt')
}

async function operatorConsole() {
  const host = flag('host') || localKey()
  if (!host) {
    console.log('no mcp to connect to.')
    console.log('  start one here:  mcp serve')
    console.log('  or point at one: mcp --host=<64-hex>')
    Bare.exit(1)
    return
  }

  const { Client } = require('./lib/client.js')
  const { Program } = require('bare-tui')
  const { ConsoleModel } = require('./lib/tui.js')

  fs.mkdirSync(DIR, { recursive: true })
  const client = new Client({ dir: path.join(DIR, '.operator'), mcpKey: host, onLog: () => {} })
  await client.start()
  await new Program(new ConsoleModel(client)).run()
  await client.close()
}

async function main() {
  if (cmd === 'serve') return serve()
  if (cmd === 'key') {
    console.log(localKey() || 'no key yet — run `mcp serve` once (state: ' + DIR + ')')
    return
  }
  if (cmd === 'room') {
    console.log(
      readKey('.room-key') || 'no room secret — this fleet is public (state: ' + DIR + ')'
    )
    return
  }
  return operatorConsole()
}

main().catch((e) => {
  console.error('[mcp] fatal', e)
  Bare.exit(1)
})
