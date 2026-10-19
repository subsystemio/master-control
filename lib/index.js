// master-control as a library. `require('master-control')` gives the pieces the console is built
// from, so an app can be an operator without reaching into lib/ or running the CLI, which is what
// the package's entry point used to be.
//
//   Client          — an operator: dials an MCP, sees the fleet, sends commands (what the TUI runs on)
//   MCP             — the daemon itself, for hosting a fleet in-process
//   LocalController — the Client interface over an in-process MCP, for a console on the hosting box
const { Client } = require('./client.js')
const { MCP } = require('./mcp.js')
const { LocalController } = require('./local.js')

module.exports = { Client, MCP, LocalController }
