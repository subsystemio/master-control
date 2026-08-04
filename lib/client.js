const path = require('bare-path')
const fs = require('bare-fs')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const { identity, channels, attest } = require('@subsystemio/runtime')

const { loadOrCreateKeyPair } = identity
const { createFleetChannels } = channels

// An operator console. Dials one MCP and mirrors its fleet.
//
// There is no shared secret on this hop. We prove which OPERATOR IDENTITY this machine belongs to —
// a proof minted from that identity's words — and the MCP's roster decides what the identity buys.
//
// The roster therefore holds one line per person, not per laptop. A second machine is attested from
// the same words and needs no roster edit; removing the person's line locks out every machine they
// have at once, with nothing to re-flash.
//
// Deliberately thin. It holds no authority and makes no trust decisions; it renders what the MCP
// tells it and asks the MCP to act.
function readProof(dir) {
  const file = path.join(dir, '.proof')
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

// One operator identity, minted locally, with this machine attested to it. The words are the only
// way to add a second machine, so they are written where the operator can find them and told about
// loudly rather than left implicit.
async function mintIdentity(dir, keyPair, log) {
  const mnemonic = attest.generateMnemonic()
  const proof = await attest.attest(mnemonic, keyPair.publicKey)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.proof'), proof)
  const wordsFile = path.join(dir, 'words.txt')
  fs.writeFileSync(wordsFile, mnemonic + '\n')
  // These words are this operator's identity. Owner-only, so a shared or synced home directory does
  // not quietly hand them to anyone else with an account.
  try {
    fs.chmodSync(wordsFile, 0o600)
  } catch {
    // Not fatal: some filesystems (FAT on a card) have no modes to set.
  }
  log('new operator identity — words saved to ' + path.join(dir, 'words.txt'))
  log('keep them: they are how you add another machine as the same operator')
  return proof
}

class Client {
  constructor({ dir, mcpKey, onLog, onChange, bootstrap } = {}) {
    this.dir = dir
    this.mcpKey = typeof mcpKey === 'string' ? b4a.from(mcpKey.trim(), 'hex') : mcpKey
    this.onLog = onLog || (() => {})
    this.onChange = onChange || (() => {})
    this.bootstrap = bootstrap

    this.proof = null // this machine's attestation, binding it to an operator identity
    this.identityKey = null
    this.subsystems = new Map() // hexKey -> record
    this.logLines = []
    this.role = 'connecting'
    this.connected = false

    this.swarm = null
    this.keyPair = null
    this.pubkey = null
    this.channels = null
    this._nextId = 1
    this._pending = new Map()
  }

  log(line) {
    this.logLines.push(line)
    if (this.logLines.length > 300) this.logLines.shift()
    this.onLog(line)
  }

  async start() {
    this.keyPair = loadOrCreateKeyPair(path.join(this.dir, '.identity'))
    this.pubkey = b4a.toString(this.keyPair.publicKey, 'hex')

    // An operator with no identity yet gets one on the spot: the common case is one person on one
    // laptop, and making them run a ceremony first would be friction for no gain. The words are
    // written out so a second machine can join the same identity later — see `mcp login`.
    this.proof = readProof(this.dir)
    if (!this.proof) this.proof = await mintIdentity(this.dir, this.keyPair, (l) => this.log(l))
    this.identityKey = attest.identityOf(this.proof)

    this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap: this.bootstrap })
    this.swarm.on('connection', (socket) => this._onConnection(socket))
    this.swarm.join(this.mcpKey, { server: false, client: true })

    this.log('dialing mcp ' + b4a.toString(this.mcpKey, 'hex').slice(0, 12) + '…')
    return this.pubkey
  }

  _onConnection(socket) {
    socket.on('error', () => {})
    if (!b4a.equals(socket.remotePublicKey, this.mcpKey)) return socket.destroy()

    const ch = createFleetChannels(socket, {
      onOperatorHello: (m) => {
        this.role = m.role
        this.connected = true
        // Quote the IDENTITY, not this machine's key: the identity is what `mcp trust` takes, and it
        // is what covers every machine this operator has. Naming the device key here would send
        // someone to adopt a key the roster never consults.
        this.log(
          m.role === 'admin'
            ? 'connected as admin'
            : 'connected as ' +
                m.role +
                ' — watching only; ask an admin for: mcp trust ' +
                b4a.toString(this.identityKey, 'hex')
        )
        this.onChange()
      },
      onSubsystem: (m) => {
        const key = b4a.toString(m.key, 'hex')
        const rec = this.subsystems.get(key) || { key, tag: key.slice(0, 12), state: null }
        rec.adopted = m.adopted
        rec.online = m.online
        rec.appId = m.appId
        rec.appVersion = m.appVersion
        rec.caps = parse(m.caps) || {}
        this.subsystems.set(key, rec)
        this.onChange()
      },
      onState: (m) => {
        const rec = this.subsystems.get(b4a.toString(m.key, 'hex'))
        if (!rec) return
        rec.state = parse(m.state)
        this.onChange()
      },
      onEvent: (m) => {
        this.log(
          'event "' + m.name + '" ' + b4a.toString(m.key, 'hex').slice(0, 12) + ' ' + m.payload
        )
      },
      onResult: (m) => {
        const name = this._pending.get(m.id) || '?'
        this._pending.delete(m.id)
        this.log('result #' + m.id + ' (' + name + ') ok=' + m.ok + ': ' + m.result)
      }
    })

    this.channels = ch
    // Before anything else: which identity is on this connection. The MCP assigns no role until it
    // has this.
    ch.sendAttestation({ proof: this.proof })

    socket.on('close', () => {
      this.channels = null
      this.connected = false
      this.role = 'connecting'
      for (const rec of this.subsystems.values()) rec.online = false
      this.log('mcp disconnected — retrying')
      this.onChange()
    })
  }

  get admin() {
    return this.role === 'admin'
  }

  commands(key) {
    const r = this.subsystems.get(key)
    return (r && r.caps && Array.isArray(r.caps.commands) ? r.caps.commands : []).filter(
      (c) => c && typeof c.name === 'string'
    )
  }

  command(key, name, args) {
    if (!this.channels) return this.log('not connected to an mcp')
    if (!this.admin) return this.log('refused ' + name + ' — this console is watching only')
    const id = this._nextId++
    this._pending.set(id, name)
    this.channels.sendInvoke({
      id,
      key: b4a.from(key, 'hex'),
      name,
      args: JSON.stringify(args || {})
    })
    this.log('-> ' + key.slice(0, 12) + ' ' + name + ' #' + id)
    return id
  }

  adopt(key, yes = true) {
    if (!this.channels) return
    if (!this.admin) return this.log('refused adopt — this console is watching only')
    this.channels.sendAdopt({ key: b4a.from(key, 'hex'), adopt: yes })
    this.log((yes ? 'adopting ' : 'revoking ') + key.slice(0, 12))
  }

  async close() {
    if (this.swarm) await this.swarm.destroy()
  }
}

function parse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

module.exports = { Client }
