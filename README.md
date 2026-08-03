<p align="center">
  <img src="docs/icon.png" alt="" width="150" />
</p>

# master-control

The Master Control Program. One per installation: it dials every
[subsystem](https://github.com/subsystemio/runtime) in the fleet, and serves the operators who watch
them.

```sh
npm install -g bare                                 # the runtime everything here runs on
npm install -g github:subsystemio/master-control    # puts `mcp` on your PATH
mcp                                                 # console — and the daemon, if none is running
```

That is usually the whole setup. `mcp` opens the console and **hosts the fleet itself** when nothing
else on the machine already is, so subsystems connect to you and other operators can attach over the
swarm. The loopback lock on 9599 decides which process is the daemon, so a second `mcp` attaches
instead of splitting the fleet in two.

```sh
mcp serve            # headless daemon only — what a systemd unit runs
mcp install          # keep it up across reboots (optional; see below)
mcp --host=<64-hex>  # attach to an MCP on another machine
```

`subsystem-image` shells out to `mcp key` when writing a card, so having `mcp` on the `PATH` is what
lets a card be configured without anyone naming a checkout path.

Operators talk to the MCP, never to a subsystem. That single rule is what lets a card carry nothing
but the MCP's public key and never be touched again — adding or removing an operator is one edit
here, not a trip round twelve SD cards.

## It knows nothing about your subsystems

Every control it draws comes from the subsystem's own `describe()`. There is no per-subsystem code
here, no plugins, no codegen. A new kind of device shows up with its controls already working.

```
┌─┤ S U B S Y S T E M S ├──────────────────────────────────────────┐
│       ID            SUBSYSTEM       VER     STATE                │
│ ▸ ◆   9be0b0f99858  tile-puzzle     1.0.0   ARMED · #14          │
│   ◆ ✓ 4c1faa093311  door-lock       0.3.1   RETRACTED · ×91      │
│   ? ▸ 77a2be40f0c1  lamp            2.0.0   pending — press A    │
└──────────────────────────────────────────────────────────────────┘
┌─┤ C O M M A N D S ├──────────────────────────────────────────────┐
│ ❰1❱ reset   ❰2❱ solve   ❰3❱ setImage·url                         │
└──────────────────────────────────────────────────────────────────┘
```

The tick column is not hardcoded to a field name — it follows whichever field a subsystem declared
with `role: 'terminal'`, so `open` on a lock and `reached` on a counter both light it. Fields render
per their `display` hint (`tick` · `badge` · `count` · `text` · `hidden`), and anything reported but
never declared still shows as `name=value`.

Commands that declare `args` open a prompt. `↑↓` select · `1-9` run · `q` quit.

## Setting one up

First run mints this MCP's keypair and prints its public key:

```
[mcp] key 7e0e33db5ee9c4fc…
[mcp] put that on a card as `mcp = …` in its config.txt
```

That key goes on every card, once. It is **public** — losing a card leaks nothing, and cards never
need touching again.

```sh
mcp --private-room           # also mint a room secret, so the fleet cannot even be found
mcp key                      # print the key again
mcp --host=<64-hex>          # a console for an MCP on another machine
```

## Adding and removing operators

Everyone is a peer with a keypair; the MCP's `roster.txt` decides what that buys.

- The **first** operator to connect to an empty roster becomes admin, so there is always a way in.
- Anyone else arrives as **pending**: they see the whole fleet live, and can command nothing.
- An admin adopts them, or edits `roster.txt` by hand. Revoking is deleting a line — immediate, with
  nothing to reflash.

Subsystems work the same way. A new one shows as `?` and its reported state is displayed but never
trusted until an admin presses **A**. That is what stops anyone who can reach the MCP from inventing
a device.

```
operator  7e0e33db…  alice
operator  3f10ba22…  bob (evenings)
subsystem 9be0b0f9…  front desk
```

## Keep these

`.identity` is this MCP's keypair — lose it and every card needs reflashing, so it refuses to start
rather than silently mint a new one. `.room` is the optional room secret, restored from its mirror
if the file goes missing. Both are gitignored; back them up.

They live in **`~/.master-control`**, deliberately not beside the code: installed globally the code
sits in `node_modules`, and an upgrade there would delete the one thing whose loss orphans the
entire fleet at once.

```sh
mcp key                                  # also prints the state directory when there is no key yet
mcp --dir=/srv/mcp                       # or MCP_DIR=/srv/mcp
```

A directory that already contains a `.mcp-key` keeps being used, so an existing install is never
moved out from under a live fleet. That check is deliberately on the **public mirror** and not on
`.identity`: if the private key is the file that went missing, this directory must still win, so the
"restore it or explicitly accept a new key" guard is what you hit — rather than silently getting a
new fleet somewhere else. MCP cards written by `subsystem-image mcp` pass
`--dir=/opt/subsystem/mcp` explicitly, because a systemd unit has no useful `HOME`.

## Always-on, if you want it

Mostly you don't need this: `mcp` hosts the fleet for as long as the console is open, which covers a
session at a venue. Install a unit when a box should simply always be the MCP.

```sh
mcp install       # a user unit — runs as you, no sudo, uses ~/.master-control
mcp install --system   # a system unit instead (needs sudo)
mcp uninstall
```

The user unit is the default because it shares the same state directory the console uses, so `mcp
key` and the daemon can never disagree about which fleet this is. It enables lingering, or the unit
would die at logout and never come back on a headless box. `uninstall` removes the unit and leaves
the identity alone.

Linux only — everywhere else, just run `mcp`.

## Running it

```sh
npm test        # real peers on a local DHT testnet
npm run lint
```

## License

MIT
