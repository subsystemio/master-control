// The console's view of an MCP running in this same process.
//
// `mcp` with no subcommand hosts the fleet itself when nothing else on this machine is, so a single
// command gives you a daemon and a TUI, and other operators can attach to it over the swarm. This
// presents an MCP through the same small surface the TUI already expects from a remote Client —
// subsystems, admin, commands, command, adopt, logLines, and who we reached — so the TUI never
// learns which it has.
class LocalController {
  constructor(mcp) {
    this.mcp = mcp
  }

  get subsystems() {
    return this.mcp.subsystems
  }

  get logLines() {
    return this.mcp.logLines
  }

  fault(what, err) {
    return this.mcp.fault(what, err)
  }

  // Authority is a roster question for remote operators. Hosting the daemon is not a claim about
  // identity — it is the machine holding the private key, so there is nobody left to ask.
  get admin() {
    return true
  }

  // Which MCP we reached, as whom, and whether we got there. Hosting, all three are this box —
  // there is no connection to wait on, so OFFLINE would be a fault nobody could act on.
  get mcpKey() {
    return this.mcp.pubkey
  }

  get pubkey() {
    return this.mcp.pubkey
  }

  get role() {
    return 'admin'
  }

  get connected() {
    return true
  }

  commands(key) {
    return this.mcp.commands(key)
  }

  // `invoke` puts args straight on the wire, where they are a JSON string — the same shape a remote
  // Client sends. Handing it the TUI's object instead killed every command a hosting console sent.
  command(key, name, args) {
    return this.mcp.invoke(key, name, JSON.stringify(args || {}))
  }

  adopt(key, yes = true) {
    return this.mcp.adopt(key, yes)
  }
}

module.exports = { LocalController }
