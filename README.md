# master-controller

The operator console for a room of [subsystems](https://github.com/subsystemio/subsystem-js). Watch
them all, drive any of them — entirely from the manifests they publish about themselves.

```
npm install && npm run tui
```

## It knows nothing about your subsystems

Every control it draws comes from the subsystem's own `describe()`. There is no per-subsystem code
here, no plugins, no codegen. A new kind of device shows up with its controls already working.

```
┌─┤ S U B S Y S T E M S ├──────────────────────────────────────────┐
│       ID            PROGRAM         VER     STATE                │
│ ▸ ◆   9be0b0f99858  tile-puzzle     1.0.0   ARMED · #14          │
│   ◆ ✓ 4c1faa093311  door-lock       0.3.1   RETRACTED · ×91      │
│   ◇   77a2be40f0c1  lamp            2.0.0   lit=true             │
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

## Joining a room

First run mints an admin keypair and a room secret, then prints both:

```
[controller] admin key  7e0e33db5ee9c4fc…
[controller] room       cf3f3a12b13dec1a…
```

Put those on each device (`room` and `admins` in its `config.txt`) and they find each other over
Hyperswarm — no addresses, no port forwarding, no same-LAN requirement.

- **`room`** is the shared secret. It finds the room and proves membership. Holding it is enough to
  **watch**.
- **`admins`** are public keys. Only those may **command**. Your private key never leaves this
  machine, and the Noise handshake proves it.

So a second operator can check in on a whole room with the room secret alone and touch nothing until
you add their key. Run as many consoles as you like — each dials the subsystems independently, so
there is no primary and nothing to diverge.

`.identity`, `.room` and the mirrored key files are gitignored. Keep them; losing `.identity` means
minting a new admin key and updating every device.

## License

MIT
