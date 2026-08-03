// The console's view of an MCP running in this same process.
//
// `mcp` with no subcommand hosts the fleet itself when nothing else on this machine is, so a single
// command gives you a daemon and a TUI, and other operators can attach to it over the swarm. This
// presents an MCP through the same small surface the TUI already expects from a remote Client —
// subsystems, admin, commands, command, adopt, logLines — so the TUI never learns which it has.
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

  // Authority is a roster question for remote operators. Hosting the daemon is not a claim about
  // identity — it is the machine holding the private key, so there is nobody left to ask.
  get admin() {
    return true
  }

  commands(key) {
    return this.mcp.commands(key)
  }

  command(key, name, args) {
    return this.mcp.invoke(key, name, args)
  }

  adopt(key, yes = true) {
    return this.mcp.adopt(key, yes)
  }
}

module.exports = { LocalController }
