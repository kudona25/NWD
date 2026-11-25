# NWD — Real-time Logical Topology (CDP + LLDP)

[ภาษาไทย](README.md) | **English**

NWD SSHes into a **Seed Switch** (core) and reads `show cdp neighbors detail`, `show lldp neighbors detail` and `show interfaces status`. It then walks the network one switch at a time (breadth-first) and draws a map that refreshes itself every 5 minutes.
The terms used throughout the system are defined in [CONTEXT.md](CONTEXT.md).

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg) ![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue.svg) ![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-lightgrey.svg)

## Features

- **Automatic topology discovery** — starts at the Seed Switch and follows CDP/LLDP neighbors breadth-first across the whole site
- **Real-time updates** — re-crawls every 5 minutes (or on Rescan) and pushes changes to the web page over WebSocket
- **Change detection** — devices or cables that appear, disappear or move port are recorded as Change Events, with a Suspect state to avoid false alarms
- **Cable media types** — UTP / Fiber MM / Fiber SM / DAC inferred from the SFP type, overridable per cable
- **Access point support** — APs (e.g. Cisco, Aruba) seen via CDP/LLDP appear as leaves on the map; NWD never logs in to them
- **Encrypted credentials** — switch passwords are stored in SQLite encrypted with Fernet; the key lives in a separate file
- **SSH + Telnet fallback** — one default credential, or per-IP overrides
- **Open a terminal to a switch straight from the map** (Windows Terminal / cmd)
- **Bilingual UI** — English / Thai, switchable at any time (also in exported HTML files)
- **Works fully offline**, with a portable build that needs no Python installation
- **Read-only** — never changes any configuration on the switches

## Getting started (Windows 11)

> **Language:** the web UI is available in English and Thai. Use the **EN / ไทย** button in the top-right corner to switch; your choice is remembered. On first visit the language follows your browser (Thai browsers get Thai, everything else gets English).

1. Install Python 3.11 or newer from python.org (tick **Add python.exe to PATH** during setup)
2. Double-click `start.bat`
   The first run creates `.venv` and installs packages (about 1–2 minutes), then opens http://127.0.0.1:8000 in your browser.
3. Go to the **Settings** tab, enter the Seed Switch IP, username/password/enable and Allowed Subnets, click **Save**, then **Rescan**

To stop the system, close the cmd window.

### Portable build (no Python needed on the target PC)

On a PC with internet access, run `powershell -ExecutionPolicy Bypass -File tools\make-portable.ps1` once.
This creates `runtime\python` (Python + all packages, ~75 MB). Copy the whole NWD folder to any Windows 10/11 x64 PC and double-click `start.bat`.
No Python installation and no internet needed — `start.bat` always prefers `runtime\python` when it exists.

Even easier: **Settings** tab → **⬇ Download zip** gives you the program plus portable Python (it builds `runtime\python` first if missing), **without** the `data` folder (map / credentials).

Do not copy `.venv` to another PC (it only works on the PC that created it) — if it gets copied, `start.bat` rebuilds it automatically.

> The server binds to `127.0.0.1`, so other machines on the LAN cannot reach it. This is intentional, because the system stores switch credentials.

## Switch requirements

- SSH enabled, and the account must have privilege 15 (or provide the enable secret)
- `cdp run` enabled (on by default)
- `lldp run` enabled to see Aruba APs, which only send LLDP
- Only read-only commands are used; NWD never changes switch configuration

### Timeout

**Per-switch timeout** in the Settings tab (default 60 seconds, range 10–600) is the maximum time for one switch, from connecting until all commands have been read.
If exceeded, that switch is marked "unreachable" with the note `TimeoutError` and the crawl moves on immediately.
If nothing answers at all (wrong IP or blocked by a firewall), NWD gives up on its own within about 8 seconds.
If a switch is genuinely slow (long link or high CPU) and times out often, increase this value.

### Telnet

Two modes:
- **Global:** tick "Try Telnet when SSH is refused" under Default Credential. NWD switches to telnet only when port 22 actively refuses the connection; it does not try telnet on timeout or wrong password.
- **Per device:** add an override for that IP and set Protocol = Telnet. Such devices use telnet only and never fall back.

Switches reached over telnet get a **⚠ TELNET** badge on the map, and the event log records when SSH was replaced by telnet.
Telnet sends the password unencrypted on every crawl, so enable SSH on those switches when you can.

## Map colors

| Device | Meaning |
|---|---|
| Green border | Normal |
| Yellow border | Suspect: its parent switch was unreachable this round. If it is missing again next round it becomes "gone" |
| Red border | Gone: stays until you click it and press **Acknowledge** |
| Grey border | Login failed / no IP / outside Allowed Subnets / beyond max hops |

Line color shows the cable type: grey = UTP, teal = Fiber MM, yellow = Fiber SM, purple = DAC, dashed = Unknown or Suspect.
If the cables in one Link are of different types, the line is white-dotted with a `×2 · mixed` label; click the line to see each cable's type.
Lines that would cross over another device when drawn straight are automatically curved around it.
An orange line with a `×1/2` label means some cables in that Link are down.
Cable type is inferred from the SFP type reported by the switch; if it is wrong, click the line and choose the correct one.

### Groups and positioning

- **Automatic groups:** every switch connected directly to the Seed Switch that has devices below it forms a group (its whole subtree), drawn in a coloured box with its name and device count. Groups are packed into several rows instead of one long line
- End switches with nothing below them, and APs, are arranged in a grid under their parent switch
- **Box select:** hold **Shift and drag** on an empty part of the map (Ctrl+Shift adds to the selection), then drag any selected device to move them all together
- **Double-click inside a group box** selects the whole group · **Esc** clears the selection
- Drag devices anywhere and NWD remembers their positions. To return to automatic layout, press **Auto layout** twice

## Data files

All data lives in the `data\` folder:
- `nwd.db` (SQLite) stores the topology, events and encrypted credentials
- `secret.key` is the key used to decrypt passwords. **Always back it up together with nwd.db** — if it is lost, all passwords must be entered again

## Code layout

```
app/parsers.py   turns CLI output into neighbor data, identifies switches/APs, infers cable type
app/crawler.py   SSH (Netmiko) + BFS → Snapshot
app/state.py     compares the Snapshot with the current map and applies Suspect/down rules → Change Events
app/main.py      FastAPI, scheduler, WebSocket, REST API
static/          web UI (vis-network is bundled locally, works without internet)
static/i18n.js   UI text in English/Thai + translation of server messages
tests/           pytest + simulated network
```

Testing without real switches:

```
.venv\Scripts\python -m pytest -q tests
.venv\Scripts\python -m uvicorn tests.fake_server:app --port 8001
```

The second command starts a simulated network at http://127.0.0.1:8001. Set the Seed to `10.10.1.1` and enter any user/pass. Simulation data is kept separately in `data-fake\`, so it never mixes with real data.

Other folders:

```
app/crypto.py           encrypts/decrypts credentials with the key in data/secret.key
app/db.py               SQLite schema and helpers
tools/make-portable.ps1 builds runtime\python for the portable build
docs/adr/               Architecture Decision Records (ADR)
CONTEXT.md              domain glossary (Seed Switch, Crawl, Suspect, etc.)
```

## REST API

The web UI talks to the backend through the following API (all served at `127.0.0.1:8000`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/topology` | All devices and cables on the map |
| GET | `/api/events?limit=300` | Recent Change Events |
| GET | `/api/status` | Current crawl status |
| POST | `/api/rescan` | Start a crawl now |
| GET / PUT | `/api/settings` | Read/save Seed, credentials, Allowed Subnets, timeout |
| GET / PUT / DELETE | `/api/overrides` | Per-IP credential/protocol |
| POST / DELETE | `/api/positions` | Save/clear manually dragged device positions |
| POST | `/api/cables/media` | Change a cable's media type |
| POST | `/api/cables/ack` | Acknowledge a down cable |
| POST | `/api/devices/ack` | Acknowledge a gone device |
| DELETE | `/api/devices` | Remove devices from the map |
| POST | `/api/devices/terminal` | Open an SSH/Telnet terminal to a device (Windows) |
| DELETE | `/api/topology?events=false` | Clear the map (move to a new site) |
| GET | `/api/package` | Download the portable zip (without `data\`) |
| WS | `/ws` | Real-time change push |

## Security

- Never commit the `data\` folder to git (it holds credentials and `secret.key`) — `.gitignore` already excludes it
- The server binds to `127.0.0.1` only. To expose it to other machines, put it behind your own reverse proxy with authentication
- Use a switch account with the least privilege that can still run the `show` commands

## License

Released under the [MIT License](LICENSE) — anyone may use, modify, distribute or use it commercially, as long as the copyright and license notice are kept.

**There is no warranty of any kind, and the authors accept no liability for any damage** arising from the use of this software (it is provided "AS IS"). You test it and use it at your own risk, especially on production networks.
