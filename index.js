#!/usr/bin/env bare
const path = require('bare-path')
const { Controller } = require('./lib/core.js')

const DIR = __dirname

// Usage:
//   bare controller/index.js [--tui]
//   --tui      operator console (interactive; needs a real terminal)
//   default    headless: logs to stdout
//
// The controller is optional. Subsystems run without it; it exists to watch a whole room at once and to
// step in when a team is stuck.
async function main() {
  const tui = Bare.argv.includes('--tui')

  if (tui) {
    const { Program } = require('bare-tui')
    const { ConsoleModel } = require('./lib/tui.js')
    const controller = new Controller({ dir: DIR, onLog: () => {} })
    await controller.start()
    await new Program(new ConsoleModel(controller)).run()
    return
  }

  const controller = new Controller({ dir: DIR, onLog: (l) => console.log('[controller]', l) })
  await controller.start()
  // What an operator needs to provision a card: who may command, and which room.
  console.log('[controller] admin key  ' + controller.pubkey)
  console.log('[controller] room       ' + controller.roomSecret())
}

main().catch((e) => {
  console.error('[controller] fatal', e)
  Bare.exit(1)
})
