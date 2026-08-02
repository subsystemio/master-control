const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const { loadOrCreateKeyPair } = require('subsystem').identity
const { createChannels } = require('subsystem').channels
const { loadOrCreateRoomKey, topic, guard } = require('subsystem').room

// Master controller: joins the room topic, dials every subsystem announcing there, and keeps a registry
// of what it has heard. It observes and it commands — nothing more. It does not deploy apps (those
// ship on the SD card) and it is never required for a subsystem to work.
//
// Several consoles can run at once: each dials the subsystems independently, so there is no primary and
// no shared state to diverge. This keypair IS the admin identity — subsystems allowlist its PUBLIC key,
// and the Noise handshake proves we hold the private half.
//
// It has no app-specific code. Every subsystem tells it what it is and what it accepts via `describe`,
// and the UI is rendered from that manifest, so a new app type needs no controller change.
class Controller {
  constructor ({ dir, onLog } = {}) {
    this.dir = dir || '.'
    this.onLog = onLog || (() => {})
    this.subsystems = new Map() // keyHex -> record
    this.logLines = []
    this.swarm = null
    this.keyPair = null
    this.pubkey = null
    this.roomKey = null
    this.roomId = null
  }

  // The room secret in the form an operator pastes onto a card.
  roomSecret () { return b4a.toString(this.roomKey, 'hex') }

  log (line) {
    this.logLines.push(line)
    if (this.logLines.length > 300) this.logLines.shift()
    this.onLog(line)
  }

  async start () {
    this.keyPair = loadOrCreateKeyPair(path.join(this.dir, '.identity'))
    this.pubkey = b4a.toString(this.keyPair.publicKey, 'hex')
    // Not an address — subsystems allowlist this PUBLIC key to decide who may command them.
    fs.writeFileSync(path.join(this.dir, '.controller-key'), this.pubkey)

    // The room secret every device in this room shares. Mirrored beside the identity so a card
    // builder can read it straight off disk instead of the operator copying secrets by hand.
    this.roomKey = loadOrCreateRoomKey(path.join(this.dir, '.room'))
    fs.writeFileSync(path.join(this.dir, '.room-key'), b4a.toString(this.roomKey, 'hex'))

    const t = topic(this.roomKey)
    this.roomId = b4a.toString(t, 'hex')
    this.swarm = new Hyperswarm({ keyPair: this.keyPair })
    this.swarm.on('connection', (socket) => this._onConnection(socket))
    this.swarm.join(t, { server: false, client: true })
    await this.swarm.flush()
    this.log('joined room ' + this.roomId.slice(0, 12) + '… — looking for subsystems')
    return this.pubkey
  }

  // Hyperswarm emits `connection` only after the Noise handshake, so the stream is already open and
  // handshakeHash is set. Waiting on an 'open' event here would wait forever.
  _onConnection (socket) {
    socket.on('error', () => {})
    this._onOpen(socket)
  }

  // Nothing is registered, logged by identity, or answered until the peer proves the room secret.
  // A stranger who reaches this port learns only that something accepted a TCP connection.
  _onOpen (socket) {
    const key = b4a.toString(socket.remotePublicKey, 'hex')
    const tag = key.slice(0, 12)
    let nextCmdId = 1
    const pending = new Map()
    let gate = null

    const rec = this.subsystems.get(key) || {}

    const channels = createChannels(socket, {
      onCapability: (m) => gate.onCapability(m),
      onHello: (m) => {
        if (!gate.verified) return
        rec.fw = m.fwVersion
        rec.lastSeen = Date.now()
        this.log('hello ' + tag + ' fw=' + m.fwVersion)
      },
      onDescribe: (d) => {
        if (!gate.verified) return
        rec.appId = d.appId
        rec.appVersion = d.appVersion
        rec.caps = parse(d.caps) || {}
        rec.lastSeen = Date.now()
        this.log(tag + ' is "' + d.appId + '" v' + d.appVersion +
          ' commands=[' + this.commands(key).map((c) => c.name).join(', ') + ']')
      },
      onEvent: (e) => {
        if (!gate.verified) return
        rec.lastSeen = Date.now()
        this.log('event "' + e.name + '" ' + tag + ' ' + e.payload)
      },
      onStateReport: (s) => {
        if (!gate.verified) return
        rec.state = parse(s.state)
        rec.lastSeen = Date.now()
      },
      onCommandResult: (r) => {
        if (!gate.verified) return
        const name = pending.get(r.id) || '?'
        pending.delete(r.id)
        this.log('result #' + r.id + ' (' + name + ') ' + tag + ' ok=' + r.ok + ': ' + r.result)
      }
    })

    gate = guard(socket, channels, this.roomKey, {
      log: (m) => this.log(tag + ': ' + m),
      onVerified: () => {
        Object.assign(rec, {
          key,
          tag,
          appId: rec.appId || null,
          appVersion: rec.appVersion || null,
          caps: rec.caps || null,
          state: rec.state || null,
          fw: null,
          online: true,
          lastSeen: Date.now(),
          channels
        })
        rec._invoke = (name, args) => {
          const id = nextCmdId++
          pending.set(id, name)
          channels.sendCommand({ id, name, args: JSON.stringify(args || {}) })
          return id
        }
        this.subsystems.set(key, rec)
        this.log('connection from ' + tag)
      }
    })

    socket.on('close', () => {
      gate.destroy()
      if (!rec.key) return // never made it past the gate; it was never a subsystem
      rec.online = false
      rec.channels = null
      this.log(tag + ' disconnected')
    })
  }

  // What this subsystem said it accepts. The UI builds itself from this — there is no hardcoded list.
  commands (key) {
    const r = this.subsystems.get(key)
    return (r && r.caps && r.caps.commands) || []
  }

  command (key, name, args) {
    const r = this.subsystems.get(key)
    if (!r || !r.channels) return null
    const id = r._invoke(name, args)
    this.log('-> ' + r.tag + ' ' + name + ' #' + id + (args ? ' ' + JSON.stringify(args) : ''))
    return id
  }

  async close () {
    if (this.swarm) await this.swarm.destroy()
  }
}

function parse (json) { try { return JSON.parse(json) } catch { return null } }

module.exports = { Controller }
