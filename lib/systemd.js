const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { spawnSync } = require('bare-subprocess')

// Optional convenience: keep `mcp serve` up across reboots.
//
// Mostly you do not need this — running `mcp` hosts the fleet for as long as the console is open,
// which covers a session at a venue. Install a unit when you want a box that is simply always the
// MCP: a permanent installation, or an operator who should never have to remember to start it.
//
// A user unit is the default. It runs as you, so it uses the same ~/.master-control the console
// does, and it needs no root. A system unit needs sudo and must be told which directory to use.
const UNIT = 'mcp.service'

function unitPath(user) {
  return user
    ? path.join(os.homedir(), '.config', 'systemd', 'user', UNIT)
    : path.join('/etc/systemd/system', UNIT)
}

function sh(cmd) {
  return spawnSync('/bin/sh', ['-c', cmd], { stdio: 'inherit' })
}

function systemctl(user, args) {
  return sh('systemctl ' + (user ? '--user ' : '') + args)
}

function requireLinux() {
  if (os.platform() === 'linux') return
  throw new Error(
    'systemd units are Linux-only (this is ' +
      os.platform() +
      ').\n' +
      '  Everywhere else, just run `mcp` — it hosts the fleet while the console is open.'
  )
}

function unit({ exec, dir, user }) {
  return (
    '[Unit]\n' +
    'Description=Master Control Program\n' +
    'After=network-online.target\n' +
    'Wants=network-online.target\n' +
    '\n' +
    '[Service]\n' +
    'Type=simple\n' +
    'ExecStart=' +
    exec +
    '\n' +
    'Restart=always\n' +
    'RestartSec=2\n' +
    // The identity in here is the whole fleet; a unit that cannot read it is worse than no unit.
    'Environment=MCP_DIR=' +
    dir +
    '\n' +
    '\n' +
    '[Install]\n' +
    'WantedBy=' +
    (user ? 'default.target' : 'multi-user.target') +
    '\n'
  )
}

function install({ dir, privateRoom = false, user = true, log = console.log }) {
  requireLinux()

  const runtime = Bare.argv[0]
  const script = path.join(__dirname, '..', 'index.js')
  const exec =
    runtime + ' ' + script + ' serve --dir=' + dir + (privateRoom ? ' --private-room' : '')

  const file = unitPath(user)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, unit({ exec, dir, user }))
  log('wrote ' + file)

  systemctl(user, 'daemon-reload')
  systemctl(user, 'enable --now ' + UNIT)

  if (user) {
    // Without lingering a user unit dies at logout, which on a headless box means it never runs.
    sh('loginctl enable-linger "$USER" >/dev/null 2>&1 || true')
    log('enabled (user unit, lingering) — status: systemctl --user status ' + UNIT)
  } else {
    log('enabled (system unit) — status: systemctl status ' + UNIT)
  }
  log('state: ' + dir)
}

function uninstall({ user = true, log = console.log }) {
  requireLinux()
  const file = unitPath(user)
  systemctl(user, 'disable --now ' + UNIT)
  if (fs.existsSync(file)) {
    fs.unlinkSync(file)
    log('removed ' + file)
  } else {
    log('no unit at ' + file)
  }
  systemctl(user, 'daemon-reload')
  log('the identity in ~/.master-control is untouched')
}

module.exports = { install, uninstall, unitPath, UNIT }
