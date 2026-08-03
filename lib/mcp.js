const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const { identity, room, channels } = require('@subsystemio/runtime')
const { Roster } = require('./roster.js')

const REDISCOVER_MS = 15000
const LOCK_PORT = 9599 // loopback mutex: one MCP per machine

const { loadOrCreateKeyPair } = identity
const { roomKey, loadOrCreateRoomKey, topic, guard } = room
const { createChannels, createFleetChannels } = channels

// The Master Control Program. One per installation.
//
// Downward it dials every subsystem announcing on its topic and holds the live registry. Upward it
// serves operators on its own public key. Those are the only two hops: an operator never talks to a
// subsystem, which is precisely what lets a card carry nothing but this MCP's public key and never
// be touched again.
//
// Trust is a roster, not a secret. A peer that is not on it is PENDING — visible, never believed,
// never obeyed — until an admin adopts it.
class MCP {
  constructor({ dir, onLog, privateRoom = false, bootstrap, lockPort = LOCK_PORT } = {}) {
    this.dir = dir
    this.onLog = onLog || (() => {})
    this.privateRoom = privateRoom
    this.bootstrap = bootstrap
    this.lockPort = lockPort // 0 = ephemeral, for tests that run several in one process

    this.subsystems = new Map() // hexKey -> record
    this.operators = new Map() // hexKey -> { key, tag, role, channels }
    this.logLines = []

    this.swarm = null
    this.keyPair = null
    this.pubkey = null
    this.roomKey = null
    this.roster = null
    this._nextId = 1
    this._pending = new Map() // invoke id -> { operator, subsystemKey, name }
  }

  log(line) {
    this.logLines.push(line)
    if (this.logLines.length > 300) this.logLines.shift()
    this.onLog(line)
  }

  // A second daemon on the same identity is a split brain: both announce the same key, so consoles
  // and subsystems attach to whichever they happen to reach and neither sees the whole fleet. An
  // OS-held loopback port is the one mutex that cannot go stale the way a pid file does.
  async _claimSingleton() {
    const http = require('bare-http1')
    this._lock = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(this.pubkey || '')
    })
    await new Promise((resolve, reject) => {
      this._lock.on('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err)
        // Not fatal to every caller: `mcp` with no subcommand takes this as "a daemon already
        // exists here" and attaches to it as a console instead.
        const taken = new Error('another mcp is already serving this installation')
        taken.code = 'ELOCKED'
        reject(taken)
      })
      this._lock.listen(this.lockPort, '127.0.0.1', resolve)
    })
  }

  async start() {
    await this._claimSingleton()
    // Losing .identity means a new MCP key, which orphans every card. Refuse rather than do it by
    // accident: an operator who really means it can delete .mcp-key too.
    const idFile = path.join(this.dir, '.identity', 'seed')
    const keyMirror = path.join(this.dir, '.mcp-key')
    if (!fs.existsSync(idFile) && fs.existsSync(keyMirror)) {
      throw new Error(
        '.identity is missing but .mcp-key still names ' +
          readTrimmed(keyMirror).slice(0, 12) +
          '…\n' +
          '  Restore .identity from backup, or delete .mcp-key to accept a NEW key\n' +
          '  (every card would then need reflashing).'
      )
    }

    this.keyPair = loadOrCreateKeyPair(path.join(this.dir, '.identity'))
    this.pubkey = b4a.toString(this.keyPair.publicKey, 'hex')
    this.roster = new Roster(path.join(this.dir, 'roster.txt'))

    // Optional: hides the fleet from anyone who learns our public key. Never decides authority.
    //
    // Minting a NEW secret when `.room` is merely missing would orphan every card already carrying
    // the old one — silently, and only discovered in a venue. If the mirror is still there, that is
    // a lost file, not a new room.
    const roomFile = path.join(this.dir, '.room')
    const roomMirror = path.join(this.dir, '.room-key')
    if (!fs.existsSync(roomFile) && fs.existsSync(roomMirror)) {
      fs.writeFileSync(roomFile, readTrimmed(roomMirror))
      this.log('restored .room from .room-key — the fleet keeps its topic')
    }
    this.roomKey = this.privateRoom ? loadOrCreateRoomKey(roomFile) : roomKey(readTrimmed(roomFile))

    // Cards need this, so keep it somewhere a card builder can read.
    fs.writeFileSync(keyMirror, this.pubkey)
    if (this.roomKey) fs.writeFileSync(roomMirror, b4a.toString(this.roomKey, 'hex'))

    this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap: this.bootstrap })
    this.swarm.on('connection', (socket) => this._onConnection(socket))

    // Dial subsystems on the fleet topic; serve operators on our own key.
    this.topic = topic(this.keyPair.publicKey, this.roomKey)
    this._fleet = this.swarm.join(this.topic, { server: true, client: true })
    this.swarm.join(this.keyPair.publicKey, { server: true, client: false })

    // Announcing is the important half: a subsystem that powers on an hour from now looks the topic
    // up and finds us at once, instead of waiting on our next lookup. The refresh below just covers
    // any subsystem that announced before we did.
    this._rediscover = setInterval(() => this._fleet.refresh().catch(() => {}), REDISCOVER_MS)
    await this.swarm.flush()

    this.log('mcp ' + this.pubkey.slice(0, 12) + '… serving operators')
    this.log(
      'fleet ' +
        b4a.toString(this.topic, 'hex').slice(0, 12) +
        '…' +
        (this.roomKey ? ' (private room)' : '') +
        ' — ' +
        this.roster.list('subsystem').length +
        ' adopted, ' +
        this.roster.list('operator').length +
        ' operators'
    )
    return this.pubkey
  }

  // Connection direction is NOT a reliable discriminator here — hyperswarm may end up server-side
  // for a peer we went looking for. Dispatch on the protocol the peer actually opens instead, which
  // is exactly what protomux pairing is for. A peer that opens neither never becomes anything.
  _onConnection(socket) {
    socket.on('error', () => {})
    const mux = Protomux.from(socket)
    // Pair on the FIRST protocol each kind opens. Pairing on a later one means the earlier channel
    // is already unmatched by the time we build ours, and the capability sent on it is dropped.
    mux.pair({ protocol: 'subsystem/auth' }, () => this._onSubsystem(socket))
    mux.pair({ protocol: 'mcp/fleet' }, () => this._onOperator(socket))
  }

  // ── downward: subsystems ────────────────────────────────────────────────
  _onSubsystem(socket) {
    const key = b4a.toString(socket.remotePublicKey, 'hex')
    const tag = key.slice(0, 12)
    const known = this.roster.get(key)

    const rec = this.subsystems.get(key) || { key, tag }
    Object.assign(rec, {
      adopted: !!known && known.kind === 'subsystem',
      name: (known && known.name) || '',
      online: false,
      channels: null
    })

    // The peer may already have sent its capability before we opened our side of the auth channel:
    // protomux delivers it the moment the channel exists, which is *during* createChannels, before
    // `gate` exists. Buffer it rather than throwing into protomux's dispatch — that destroys the
    // stream, and the peer reconnects into the same trap forever.
    let gate = null
    let earlyCapability = null
    const ch = createChannels(socket, {
      onCapability: (m) => (gate ? gate.onCapability(m) : (earlyCapability = m)),
      onDescribe: (d) => {
        if (!gate.verified) return
        rec.appId = d.appId
        rec.appVersion = d.appVersion
        rec.caps = validateCaps(parse(d.caps))
        rec.lastSeen = Date.now()
        this.log(
          tag +
            ' is "' +
            d.appId +
            '" v' +
            d.appVersion +
            (rec.adopted ? '' : '  [PENDING — adopt to trust]')
        )
        this._pushSubsystem(rec)
      },
      onEvent: (e) => {
        if (!gate.verified) return
        rec.lastSeen = Date.now()
        this.log('event "' + e.name + '" ' + tag + ' ' + e.payload)
        this._toOperators('sendEvent', {
          key: socket.remotePublicKey,
          name: e.name,
          payload: e.payload,
          ts: e.ts
        })
      },
      onStateReport: (s) => {
        if (!gate.verified) return
        rec.state = parse(s.state)
        rec.lastSeen = Date.now()
        this._toOperators('sendState', {
          key: socket.remotePublicKey,
          state: s.state,
          ts: s.ts
        })
      },
      onCommandResult: (r) => {
        if (!gate.verified) return
        const p = this._pending.get(r.id)
        this._pending.delete(r.id)
        const name = (p && p.name) || '?'
        this.log('result #' + r.id + ' (' + name + ') ' + tag + ' ok=' + r.ok + ': ' + r.result)
        if (p && p.operator && p.operator.channels) {
          p.operator.channels.sendResult({ id: r.id, ok: r.ok, result: r.result })
        }
      }
    })

    gate = guard(socket, ch, this.roomKey, {
      log: (m) => this.log(tag + ': ' + m),
      onVerified: () => {
        rec.online = true
        rec.channels = ch
        rec.lastSeen = Date.now()
        this.subsystems.set(key, rec)
        this.log('subsystem ' + tag + ' connected' + (rec.adopted ? '' : ' (pending)'))
        this._pushSubsystem(rec)
      }
    })
    if (earlyCapability) gate.onCapability(earlyCapability)

    socket.on('close', () => {
      gate.destroy()
      if (!rec.online) return
      rec.online = false
      rec.channels = null
      this.log('subsystem ' + tag + ' disconnected')
      this._pushSubsystem(rec)
    })
  }

  // ── upward: operators ───────────────────────────────────────────────────
  _onOperator(socket) {
    const key = b4a.toString(socket.remotePublicKey, 'hex')
    const tag = key.slice(0, 12)
    const known = this.roster.get(key)

    // Bootstrap: the very first operator to appear on an empty roster is adopted automatically, so
    // there is always a way in. After that, adoption is an explicit act by an existing admin.
    let role = 'pending'
    if (known && known.kind === 'operator') role = 'admin'
    else if (this.roster.list('operator').length === 0) {
      this.roster.adopt(key, 'operator', 'first operator')
      role = 'admin'
      this.log('adopted first operator ' + tag + ' (roster was empty)')
    }

    const op = { key, tag, role, channels: null }

    const ch = createFleetChannels(socket, {
      onInvoke: (m) => this._onInvoke(op, m),
      onAdopt: (m) => this._onAdopt(op, m)
    })

    op.channels = ch
    this.operators.set(key, op)
    ch.sendOperatorHello({ role })
    this.log('operator ' + tag + ' attached as ' + role)

    // Catch them up on the whole fleet.
    for (const rec of this.subsystems.values()) this._pushSubsystem(rec, ch)

    socket.on('close', () => {
      this.operators.delete(key)
      this.log('operator ' + tag + ' detached')
    })
  }

  // Send a command to a subsystem. `operator` is who gets the result relayed back; a local console
  // passes none and reads the outcome from the log like everything else.
  invoke(key, name, args, opts = {}) {
    const { operator = null, refuse = () => {} } = opts
    const rec = this.subsystems.get(key)

    if (!rec || !rec.channels) {
      this.log('cannot reach ' + key.slice(0, 12) + ' for ' + name + ' — offline')
      return refuse('"subsystem offline"')
    }
    if (!rec.adopted) {
      this.log('refused ' + name + ' to ' + rec.tag + ' — not adopted')
      return refuse('"subsystem not adopted"')
    }

    const id = this._nextId++
    this._pending.set(id, { operator, subsystemKey: key, name })
    rec.channels.sendCommand({ id, name, args })
    this.log('-> ' + rec.tag + ' ' + name + ' #' + id)
    return id
  }

  adopt(key, yes = true) {
    const rec = this.subsystems.get(key)
    if (yes) {
      this.roster.adopt(key, 'subsystem', (rec && rec.appId) || '')
      this.log('adopted subsystem ' + key.slice(0, 12))
    } else {
      this.roster.revoke(key)
      this.log('revoked subsystem ' + key.slice(0, 12))
    }
    if (rec) {
      rec.adopted = yes
      this._pushSubsystem(rec)
    }
  }

  _onInvoke(op, m) {
    if (op.role !== 'admin') {
      this.log('refused ' + m.name + ' from operator ' + op.tag + ' — not an admin')
      return op.channels.sendResult({ id: m.id, ok: false, result: '"not authorised"' })
    }
    this.invoke(b4a.toString(m.key, 'hex'), m.name, m.args, {
      operator: op,
      refuse: (result) => op.channels.sendResult({ id: m.id, ok: false, result })
    })
  }

  _onAdopt(op, m) {
    if (op.role !== 'admin') return
    this.adopt(b4a.toString(m.key, 'hex'), m.adopt)
  }

  _pushSubsystem(rec, only) {
    const msg = {
      key: b4a.from(rec.key, 'hex'),
      adopted: !!rec.adopted,
      online: !!rec.online,
      appId: rec.appId || '',
      appVersion: rec.appVersion || '',
      caps: JSON.stringify(rec.caps || {})
    }
    if (only) return only.sendSubsystem(msg)
    this._toOperators('sendSubsystem', msg)
  }

  _toOperators(method, msg) {
    for (const op of this.operators.values()) {
      try {
        op.channels[method](msg)
      } catch {
        /* dropped; close will clean it up */
      }
    }
  }

  commands(key) {
    const r = this.subsystems.get(key)
    return (r && r.caps && r.caps.commands) || []
  }

  async close() {
    clearInterval(this._rediscover)
    if (this._lock) await new Promise((r) => this._lock.close(r))
    if (this.swarm) await this.swarm.destroy()
  }
}

// A manifest arrives over the wire from something we may not trust yet. Anything the console will
// iterate must actually be iterable, or one malformed message blanks every operator's screen.
function validateCaps(caps) {
  if (!caps || typeof caps !== 'object') return {}
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])
  return {
    id: typeof caps.id === 'string' ? caps.id : '',
    version: typeof caps.version === 'string' ? caps.version : '',
    commands: arr(caps.commands).filter((c) => typeof c.name === 'string'),
    events: arr(caps.events),
    state: arr(caps.state).filter((f) => typeof f.name === 'string')
  }
}

function readTrimmed(file) {
  try {
    return b4a.toString(fs.readFileSync(file), 'utf8').trim()
  } catch {
    return null
  }
}

function parse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

module.exports = { MCP, validateCaps }
