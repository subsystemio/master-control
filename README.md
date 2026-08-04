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
but the fleet's identity key and never be touched again — adding or removing an operator is one edit
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

A fleet is a **root identity**, not a machine. Cards carry the identity's public key; this box proves
it belongs to that identity. That indirection is the point: the box can be replaced without touching
a single card.

The identity's mnemonic never comes near this box. Mint it on a machine that is offline, and keep the
words the way you would keep a master key to the building.

```sh
mcp identity                 # OFFLINE: prints 24 words once, and the identity key
```

Then attest this box into the fleet:

```sh
mcp device                   # on the MCP box: its own key
mcp attest <that key> --words=words.txt   # OFFLINE: prints a proof
mcp proof <that proof>       # on the MCP box: install it
mcp key                      # the identity key — this is what goes on every card
```

Only the proof travels back, and a proof grants nothing on its own. Until one is installed the daemon
runs but **no prop will accept a command from it**, and it says so on every start.

```sh
mcp --private-room           # also mint a room secret, so the fleet cannot even be found
mcp --host=<64-hex>          # a console for an MCP on another machine
```

### Replacing the box

Attest the new one from the same words and the fleet moves. No card is reflashed, no prop is
re-adopted.

Re-attesting also **revokes**: proofs carry an epoch, and a prop that has seen a newer one stops
accepting older ones. So a stolen box's key can be retired — which was impossible when the card
trusted one key directly. Props learn the newer epoch on their next connection; you can also drop it
on the boot partition by hand if you do not want to wait.

The trade is worth stating plainly: the mnemonic is now the thing that must never leak. A stolen box
can be revoked; a stolen mnemonic cannot, short of reflashing every card.

## Adding and removing operators

An operator is an **identity**, not a machine, so `roster.txt` holds one line per _person_.

```
operator  7e0e33db…  alice
operator  3f10ba22…  bob (evenings)
subsystem 9be0b0f9…  front desk
```

- The **first** operator identity to connect to an empty roster becomes admin, so there is always a
  way in.
- Anyone else arrives as **pending**: they see the whole fleet live, and can command nothing.
- Adopting and revoking are one line, from the console or the CLI.

```sh
mcp roster                       # who is trusted
mcp trust <identity> "alice"     # an operator identity — covers every machine she has
mcp revoke <identity>            # locks out all of them at once
mcp trust <key> --subsystem      # a device key, for a prop
```

The roster is re-read on every connection, so an edit — by CLI or by hand — takes effect on the next
one. No restart.

### A second machine

The console mints an operator identity on first run and saves the words next to its state. Adding a
laptop or a phone means attesting it to those same words:

```sh
mcp login --words=words.txt      # on the new machine
mcp whoami                       # identity, and this machine's key
```

That machine is admin immediately, because the roster already trusts the identity. **No roster edit,
no adoption step.** Conversely, revoking the person's single line locks out every machine at once —
which is exactly what you want when a laptop walks off.

An operator proves which identity is on the connection, and the proof must name **that** connection's
key. A copied proof presented from a different machine buys nothing.

Subsystems are still trusted by device key: a prop is one box doing one job, and there is nothing for
an identity to span. A new one shows as `?` and its state is displayed but never trusted until an
admin presses **A**.

## Keep these

`.identity` is this box's own keypair and `.proof` is its attestation — lose either and you re-attest
this box from the words, which is cheap. `.room` is the optional room secret, restored from its mirror
if the file goes missing.

The one irreplaceable thing is the **mnemonic**, and it is deliberately not here. Nothing in this
directory can mint an attestation.

They live in **`~/.master-control`**, deliberately not beside the code: installed globally the code
sits in `node_modules`, and an upgrade there would wipe the directory out from under a running fleet.

```sh
mcp key                                  # also prints the state directory when there is no key yet
mcp --dir=/srv/mcp                       # or MCP_DIR=/srv/mcp
```

One place, no searching. If `.identity` goes missing while `.mcp-key` is still there the daemon
refuses to start rather than minting a replacement, because the installed `.proof` would no longer
match — restore it, or delete both and re-attest. MCP cards written by `subsystem-image mcp` pass
`--dir=/opt/subsystem/mcp`, because a systemd unit has no useful `HOME`.

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
