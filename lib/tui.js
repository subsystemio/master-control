const { quit, every, key, style, textinput } = require('bare-tui')
const { C, paint, panel, pad, clip, etch, fill } = require('./theme.js')

// Operator console, styled as a Tron grid. Everything it can do to a subsystem comes from that subsystem's
// own `describe` manifest — there is no hardcoded command list, so a new app type shows up here
// with its controls already working. Commands that declare args open a prompt.
const MIN_W = 56
const MIN_H = 20

class ConsoleModel {
  constructor (controller) {
    this.c = controller
    this.sel = 0
    this.w = 100
    this.h = 32
    this.prompt = null // { key, name, args, values, at, input }
  }

  init () { return tick() }

  keys () { return [...this.c.subsystems.keys()] }
  selected () { return this.keys()[this.sel] }

  update (msg) {
    if (msg.type === 'resize') { this.w = msg.width; this.h = msg.height; return [this, null] }
    if (msg.type === 'refresh') return [this, tick()]
    if (msg.type !== 'key') return [this, null]
    if (this.prompt) return this._updatePrompt(msg)

    if (key.matches(msg, 'q', 'ctrl+c')) return [this, quit]

    const keys = this.keys()
    if (key.matches(msg, 'up', 'k')) { this.sel = Math.max(0, this.sel - 1); return [this, null] }
    if (key.matches(msg, 'down', 'j')) { this.sel = Math.min(Math.max(0, keys.length - 1), this.sel + 1); return [this, null] }

    const sel = this.selected()
    if (!sel) return [this, null]

    const cmds = this.c.commands(sel)
    for (let i = 0; i < cmds.length && i < 9; i++) {
      if (key.matches(msg, String(i + 1))) return [this._invoke(sel, cmds[i]), null]
    }
    return [this, null]
  }

  _invoke (propKey, cmd) {
    const args = Object.keys(cmd.args || {})
    if (args.length === 0) { this.c.command(propKey, cmd.name, {}); return this }
    this.prompt = {
      key: propKey,
      name: cmd.name,
      args,
      values: {},
      at: 0,
      input: textinput.create({ placeholder: args[0] }).focus()
    }
    return this
  }

  _updatePrompt (msg) {
    const p = this.prompt
    if (key.matches(msg, 'esc', 'ctrl+c')) { this.prompt = null; return [this, null] }

    if (key.matches(msg, 'enter')) {
      p.values[p.args[p.at]] = p.input.value
      if (++p.at >= p.args.length) {
        this.c.command(p.key, p.name, p.values)
        this.prompt = null
        return [this, null]
      }
      p.input = textinput.create({ placeholder: p.args[p.at] }).focus()
      return [this, null]
    }

    const [next] = p.input.update(msg)
    p.input = next
    return [this, null]
  }

  // Fills the terminal exactly. Header, commands and footer take what they need; the programs list
  // and the log split every remaining row between them, so the frame always reaches the bottom.
  view () {
    const w = Math.max(MIN_W, this.w)
    const h = Math.max(MIN_H, this.h)

    const header = this._header(w)
    const commands = this._commands(w)
    const footer = this._footer()
    const fixed = rows(header) + rows(commands) + rows(footer)

    const avail = Math.max(6, h - fixed - 4) // body rows shared by the two flexible panels
    const gridBody = Math.max(3, Math.min(this.keys().length + 2, avail - 3))
    const logBody = avail - gridBody

    return [header, this._grid(w, gridBody), commands, this._log(w, logBody), footer].join('\n')
  }

  _header (w) {
    const c = this.c
    const online = [...c.subsystems.values()].filter((r) => r.online).length
    const total = c.subsystems.size
    const title = style().bold().foreground(C.glow).render('◤ ' + etch('master control program') + ' ◢')
    const idKey = paint.mute('ROOM ') + paint.line(c.roomId ? c.roomId.slice(0, 16) + '…' : 'joining') +
      paint.mute('   ADMIN ') + paint.line(c.pubkey ? c.pubkey.slice(0, 12) + '…' : '—')
    const nodes = paint.mute('NODES ') +
      (online ? paint.good(online + '/' + total) : paint.dead(online + '/' + total)) +
      paint.mute(' ONLINE')
    const gap = Math.max(1, w - 4 - style.width(idKey) - style.width(nodes))
    return panel(null, [title, '', idKey + ' '.repeat(gap) + nodes], w, { colour: C.glow })
  }

  _grid (w, bodyRows) {
    const c = this.c
    const keys = this.keys()
    const lines = [
      // 6 = row prefix (marker + link dot) + the terminal-role column, so headings sit over values
      paint.mute(pad('', 6) + pad('ID', 14) + pad('PROGRAM', 16) + pad('VER', 8) + 'STATE'),
      paint.dim('─'.repeat(w - 4))
    ]

    if (keys.length === 0) {
      lines.push('')
      lines.push(paint.dim('  no programs on the grid — waiting for subsystems to connect'))
    }

    // Scroll the list rather than overflow the panel, keeping the selection in view.
    const capacity = Math.max(1, bodyRows - 2)
    const start = Math.max(0, Math.min(this.sel - (capacity >> 1), keys.length - capacity))

    keys.slice(start, start + capacity).forEach((k, n) => {
      const i = start + n
      const r = c.subsystems.get(k)
      const dot = r.online ? paint.good('◆') : paint.dead('◇')
      // Which field means "finished" is the app's to declare — we only look for the role.
      const spec = (r.caps && r.caps.state) || []
      const term = spec.find((f) => f.role === 'terminal')
      const done = term && r.state && r.state[term.name] ? paint.good('✓') : ' '
      const sel = i === this.sel
      const body = pad(r.tag, 14) + pad(r.appId || '-', 16) + pad(r.appVersion || '-', 8) +
        clip(renderState(spec, r.state), Math.max(10, w - 46))
      lines.push((sel ? paint.glow('▸ ') : '  ') + dot + ' ' + done + ' ' +
        (sel ? paint.sel(body) : paint.text(body)))
    })

    if (keys.length > capacity) {
      lines[1] = paint.dim('─'.repeat(w - 4 - 12)) + paint.mute(' ' + (start + 1) + '-' +
        Math.min(start + capacity, keys.length) + '/' + keys.length + ' ')
    }

    return panel('programs', fill(lines, bodyRows), w)
  }

  _commands (w) {
    const sel = this.selected()
    if (!sel) return panel('commands', [paint.dim('  select a program')], w, { colour: C.dim, titleColour: C.dim })

    const cmds = this.c.commands(sel)
    if (cmds.length === 0) return panel('commands', [paint.dim('  this program declared no commands')], w, { colour: C.dim })

    // Straight from the manifest — the controller has no idea what these mean.
    const list = cmds.slice(0, 9).map((cmd, i) => {
      const args = Object.keys(cmd.args || {})
      return paint.amber('❰' + (i + 1) + '❱ ') + paint.text(cmd.name) +
        (args.length ? paint.mute('·' + args.join(',')) : '')
    }).join('   ')

    const lines = [list]
    if (this.prompt) {
      const p = this.prompt
      lines.push('')
      lines.push(paint.amber('▶ ' + p.name + ' · ' + p.args[p.at] + ' ') + p.input.view() +
        paint.mute('   ⏎ send   esc cancel'))
    }
    return panel('commands', lines, w, { colour: C.amber, titleColour: C.amber })
  }

  _log (w, bodyRows) {
    const lines = this.c.logLines.slice(-bodyRows).map((l) => paint.mute('› ' + clip(l, w - 8)))
    return panel('system log', fill(lines, bodyRows), w, { colour: C.dim, titleColour: C.line })
  }

  _footer () {
    const k = (a, b) => paint.glow(a) + paint.mute(' ' + b)
    return '  ' + [k('↑↓', 'SELECT'), k('1-9', 'EXECUTE'), k('Q', 'DISCONNECT')].join(paint.dim('   ·   '))
  }
}

// Rendered entirely from the app's own manifest. Anything the app reports but never declared still
// shows, as name=value — a console should never silently hide state it was told about.
function renderState (spec, state) {
  if (!state) return paint.dim('-')

  const drawn = new Set()
  const out = []

  for (const f of spec) {
    drawn.add(f.name)
    if (f.display === 'hidden' || f.role === 'terminal') continue // terminal has its own column
    if (!(f.name in state)) continue
    out.push(chip(f, state[f.name]))
  }
  for (const k of Object.keys(state)) {
    if (!drawn.has(k)) out.push(paint.mute(k + '=') + paint.text(JSON.stringify(state[k])))
  }

  return out.length ? out.join(paint.dim(' · ')) : paint.dim('-')
}

function chip (f, v) {
  switch (f.display) {
    case 'tick': return v ? paint.good('✓ ' + f.name) : paint.dim('· ' + f.name)
    case 'badge': return paint.amber(String(v).toUpperCase())
    case 'count': return paint.mute(f.label || f.name + ' ') + paint.text(String(v))
    case 'text': return paint.text(String(v))
    default: return paint.mute(f.name + '=') + paint.text(JSON.stringify(v))
  }
}

function rows (block) { return block.split('\n').length }
function tick () { return every(500, () => ({ type: 'refresh' })) }

module.exports = { ConsoleModel }
