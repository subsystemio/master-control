const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')

// Who this MCP trusts. One file, one place — which is the whole point of the singleton: adding or
// removing an operator is an edit here, never a trip round twelve SD cards.
//
// Format is one entry per line so it stays hand-editable on a box with no tooling:
//
//   operator <64-hex>  <name>
//   subsystem <64-hex>  <name>
//
// A peer not listed here is PENDING: seen, shown, never believed and never obeyed. An admin adopts
// it explicitly. That is what stops anyone who can reach us from inventing a subsystem.
class Roster {
  constructor(file) {
    this.file = file
    this.entries = new Map() // hexKey -> { kind, key, name }
    this.load()
  }

  load() {
    this.entries.clear()
    let text
    try {
      text = b4a.toString(fs.readFileSync(this.file), 'utf8')
    } catch {
      return this
    }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s || s[0] === '#') continue
      const [kind, key, ...rest] = s.split(/\s+/)
      if (!/^(operator|subsystem)$/.test(kind) || !/^[0-9a-f]{64}$/i.test(key || '')) continue
      this.entries.set(key.toLowerCase(), {
        kind,
        key: key.toLowerCase(),
        name: rest.join(' ') || ''
      })
    }
    return this
  }

  save() {
    const lines = [
      '# Who this MCP trusts. Edit by hand or adopt from the console.',
      '#   operator  <64-hex>  <name>     — may watch, and command if listed as admin',
      '#   subsystem <64-hex>  <name>     — its reported state is believed',
      ''
    ]
    for (const e of this.entries.values()) {
      lines.push(e.kind + ' ' + e.key + (e.name ? '  ' + e.name : ''))
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, lines.join('\n') + '\n')
    return this
  }

  has(key, kind) {
    const e = this.entries.get(hex(key))
    return !!e && (!kind || e.kind === kind)
  }

  get(key) {
    return this.entries.get(hex(key)) || null
  }

  adopt(key, kind, name) {
    const k = hex(key)
    this.entries.set(k, { kind, key: k, name: name || '' })
    return this.save()
  }

  revoke(key) {
    this.entries.delete(hex(key))
    return this.save()
  }

  list(kind) {
    return [...this.entries.values()].filter((e) => !kind || e.kind === kind)
  }

  get empty() {
    return this.entries.size === 0
  }
}

function hex(key) {
  return (typeof key === 'string' ? key : b4a.toString(key, 'hex')).toLowerCase()
}

module.exports = { Roster }
