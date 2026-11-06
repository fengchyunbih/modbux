# Modbux

> A fork of [ploxc/modbux](https://github.com/ploxc/modbux) by [ploxc](https://github.com/ploxc). It adds an MCP server, so an AI agent can drive the client and the server.

## Let an AI agent install it

Paste this into Claude Code, Codex, Antigravity or any agent that can run shell commands:

````text
Install Modbux from https://github.com/fengchyunbih/modbux (branch icp) and
connect it to yourself as an MCP server. Do these in order, and stop at step 2.

1. Clone the repo and run `yarn` in it (needs Node.js LTS and Yarn). Start the app
   with `yarn dev`.
2. Ask me to open the Modbux window, press the settings button on the Home screen,
   open the MCP page and switch "Enable MCP" on. It is off by default and only I can
   switch it. Leave "Allow writes to devices" off unless I say otherwise. Wait for me.
3. Read the token from mcp.json in Modbux's user data directory:
   macOS ~/Library/Application Support/Modbux, Windows %APPDATA%\Modbux,
   Linux ~/.config/modbux when run from source.
4. Register the MCP server in the client you are running in.
   - Claude Code:
     claude mcp add --transport http modbux http://127.0.0.1:15502/mcp --header "Authorization: Bearer <token>"
   - A client without HTTP headers (Codex and others): run `npx electron-vite build`
     once, then register the command `node <repo>/out/main/mcpStdio.js` with the
     environment variable MODBUX_MCP_TOKEN set to the token.
5. Check it: call the tool server_list. An error that starts with "Modbux endpoint:"
   means Modbux is not running or MCP is not enabled.
6. Tell me what I can ask you now. The MCP prompts take a pasted point table:
   point_table_to_client reads the device, point_table_to_simulator builds a simulated
   server, closed_loop_test checks both against each other. Scanning unit IDs and
   registers, polling and reading work without writes. Writing to a device needs
   "Allow writes to devices".
````

The details are in [docs/mcp.md](docs/mcp.md).

<img src="./resources/icon.png" alt="Logo" width="60" />

[![Release](https://img.shields.io/github/v/release/fengchyunbih/modbux?color=5b9279)](https://github.com/fengchyunbih/modbux/releases)
[![Downloads](https://img.shields.io/github/downloads/fengchyunbih/modbux/total?color=5b9279&label=downloads)](https://github.com/fengchyunbih/modbux/releases)
[![License](https://img.shields.io/github/license/fengchyunbih/modbux?color=5b9279)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5b9279)

## An Open Source Modbus Client & Server Simulation Tool for Windows, macOS and Linux

**Modbux is the tool I desperately needed four years ago.** It handles Modbus TCP, RTU and RTU over TCP, lets you assign datatypes to registers, scan for addresses and data, simulate servers for testing, and actually _understand_ what you're reading, all in one app.

## Download

**[Download the latest release](https://github.com/fengchyunbih/modbux/releases/latest)**

Installers for Windows, and for macOS on both Apple silicon and Intel. Linux gets a `.deb`
and an `.AppImage`, x64 and arm64.

**[Read the MCP documentation](docs/mcp.md)**, and the
[upstream documentation](https://ploxc.com/modbux/docs/latest/getting-started) for the rest of the app.

## Features

**Client Mode:**

- Read/write every common data type: int16/32/64, uint16/32/64, float, double, bitmap, timestamps and UTF-8 strings
- Bitmap detail panel: expandable 16-bit view with per-bit toggles, color coding, invert, and inline comments
- Advanced mode: see all numeric data type interpretations simultaneously
- `Read configuration` mode: efficiently read only configured registers with automatic grouping, group index column, and inline error rows
- Scan Unit IDs and register ranges, watching the grid fill as the scan walks
- A unit that answers with an exception is told apart from one that says nothing: the first
  is a device that is there and refusing, the second is nothing on the bus at all
- Big-endian / Little-endian support (swap registers)
- Scaling factors and linear interpolation
- Modbus TCP (with hostname/IP) and RTU support with automatic COM port discovery
- RTU over TCP for serial-to-Ethernet gateways that carry encapsulated RTU frames
- Configuration save/load (JSON)

**Server Mode:**

- Modbus TCP and RTU server modes (serial port, USB converters, socat virtual pairs)
- Simulate several Modbus devices at once (TCP mode)
- The full Unit ID range the protocol allows, 0-255, on every server
- The same data types as the client: numeric registers, bitmap, UTF-8 strings, Unix timestamps and IEC 870-5 datetime
- Static or random value generation with configurable intervals
- Time-based generators for Unix/datetime that output the current system time
- DateTimePicker with UTC toggle for setting exact timestamps
- Redesigned booleans: individual address rows with toggle circles, inline comments, and hover-to-delete
- Configuration save/load (JSON)
- Instant auto-start

**Split Mode:**

- Run client and server simultaneously in separate windows
- Server opens in a second window, main window becomes the client
- Connect to your own server via `127.0.0.1` for local testing
- Great for learning Modbus hands-on or developing both sides of a communication simultaneously

**State Persistence:**

- Everything saves automatically between sessions

## How It Compares

There are plenty of Modbus tools around and several of them are good at what they do. The
catch is that they each do one piece of it, and the good ones are paid and Windows-only:
a client here, a server there, a scanner separately. I used those for years, switching
between windows.

Modbux is free and open source, runs on Windows, macOS and Linux, and puts the client and
the server in one app, so you can point one at the other over `127.0.0.1` and test without
any hardware in front of you. The part I actually built it for is the interpretation:
every data type applied to the same registers at once, endianness you can flip, scaling,
and a scan that tells you where the data is instead of only which unit answered.

If you want it laid out tool by tool, there is a
[comparison page](https://ploxc.com/modbux/alternatives) on the upstream site.

## UI

![Modbux Client UI](./resources/modbux-client.png)

## Why This Exists

Four years ago, I was thrown into a CHP plant commissioning with zero Modbus experience. The client didn't know the addresses. I didn't know the protocol. I had a scanner that found... something... and a hex reader that showed me values I couldn't interpret.

_Is that temperature in register 100 or 101? Does the documentation start at 0 or 1? Why does TIA Portal call it 40000 when the manual says holding register 0? Is it big-endian or little-endian? Input registers or holding registers? Which function code do I even need?_

Oh, and it was Modbus RTU, so add "are my termination resistors right?" and "is my wiring actually correct?" to the list. Because if those aren't perfect, you're reading absolutely nothing and troubleshooting blind.

**This went on for four years.**

Gradually, I figured it out. But I watched colleague after colleague hit the same walls. We'd eventually succeed, sure, with blood, sweat, and way too many site visits. The tools we had could read a float or an int if you were lucky, but they never gave you the full picture. Endianness? Swap the registers yourself and hope. Documentation starting at the wrong offset? Good luck finding where the data actually lives.

Modbus TCP helped, at least the physical layer wasn't fighting you anymore. I built a TypeScript implementation for my home solar panels using [modbus-serial](https://www.npmjs.com/package/modbus-serial) (thanks [yaacov](https://github.com/yaacov)!), and things started clicking. The protocol itself actually made sense once you understood it.

Then came another commissioning. More problems. More frustration. And I snapped.

**"I've had enough of this."**

I dove into the protocol properly, really _understood_ it, and realized: I already have the pieces. I know how this works now. I can build the tool I've been wishing existed this entire time.

So I did.

I built something that shows you every possible data interpretation at once. That scans not just for devices, but for _where the actual data is_ (because I once spent hours discovering third-party documentation had the wrong register range). That lets you test PLC implementations against simulated devices _before_ you're on-site hoping everything works.

I use it every single day now. The idea of writing Modbus code and just _hoping_ it works when I connect to the real device? That's not how I work anymore.

**If you've ever fought with Modbus, you'll understand why this needed to exist.**

Built with Electron, React, and Material-UI. Open source because this industry needs better tools.

### Free, and Staying Free

No account, no trial, no paid tier.

## Why "Modbux"?

It's a typo I always made, _modbux_ instead of _modbus_. But it fits: it's your user experience (UX) working with Modbus. The typo became the brand.

## Pro Tip: Let AI Do the Boring Stuff

Saved configs are JSON. Show Claude or ChatGPT a few example registers, paste your device documentation, ask it to complete the mapping. Load it back into Modbux, done. Welcome to 2026.

## Installation

### Windows

Download the `.exe` file from [releases](https://github.com/fengchyunbih/modbux/releases).

⚠️ **SmartScreen warning**: Click "More info" → "Run anyway"

### macOS

Download the `.dmg` file from [releases](https://github.com/fengchyunbih/modbux/releases). Pick `arm64` for Apple silicon and `x64` for Intel.

**macOS 12 or newer.** Modbux 2.3 moved to Electron 43, which does not run on Catalina or
Big Sur. Modbux 2.2.1 still does, and stays on the [upstream releases page](https://github.com/ploxc/modbux/releases).

⚠️ **First time opening**: Right-click the app and select "Open"
(or go to System Preferences → Security & Privacy → "Open Anyway")

### Linux

Download the `.deb` or the `.AppImage` from [releases](https://github.com/fengchyunbih/modbux/releases), x64 or arm64. Building from source
works too, see [Build It Yourself](#build-it-yourself).

Two things on Linux need a permission the app cannot give itself, and Modbux asks about
both rather than failing quietly:

- **Port 502** is reserved for root, so the server would start somewhere else. Opening the
  server view offers to lower the floor, until reboot or for good.
- **Serial ports** belong to a group, usually `dialout`, and a user outside it cannot open
  one. The port is still listed, so nothing looks wrong until the connection is refused.
  Selecting RTU offers to add you, and offers to log you out afterwards, since a session
  keeps the groups it was given at login.

Both show the exact command before running it, and ask for your password through PolicyKit,
so Modbux never sees it. Inside Flatpak or Snap it hands you the command instead. The
commands are under [Build It Yourself](#build-it-yourself) if you would rather run them
yourself.

## Build It Yourself

Modbux is an Electron application built with React, TypeScript, and Material-UI.

### Prerequisites

- Node.js (LTS version recommended)
- Yarn package manager

### Setup

**Clone and install dependencies:**

```bash
git clone https://github.com/fengchyunbih/modbux.git
cd modbux
yarn
```

### Development

**Run the app in development mode:**

```bash
yarn dev
```

### Testing

**Run unit tests:**

```bash
yarn test
```

**Run unit tests in watch mode:**

```bash
yarn test:watch
```

**Run E2E tests:**

```bash
yarn test:e2e
```

**Run everything this platform can:**

```bash
yarn test:all:mac
yarn test:all:windows
yarn test:all:linux
```

Lint, typecheck, unit tests, both e2e modes, the screenshots and the scan
measurement, plus what only that platform has: the hardware specs on macOS and
Linux, and the port 502 modal on Linux, which is the one step that waits for a
person. `yarn verify` is the shorter one to run before pushing: lint, typecheck,
unit tests and e2e.

**Run E2E tests against a packaged build:**

```bash
yarn test:e2e:packaged
```

This builds, packages with `electron-builder --dir`, and runs the same specs
against the binary in `dist/` instead of the `out/` bundle. It is the only way
to catch problems that exist solely in the packaged app — most importantly a
runtime dependency that sits in `devDependencies`, since only `dependencies` are
packed into `app.asar` while a normal run resolves everything from the repo's
`node_modules`.

Packaged runs use a throwaway user-data directory, so they never touch the
config of an installed Modbux.

On macOS and Linux the socat specs run as well; on Windows they are skipped,
because socat is unavailable there.

**Run the hardware E2E tests:**

```bash
yarn test:e2e:hardware
```

These are left out of the normal runs. They talk to an Arduino running
`tools/arduino/iem3000.ino` over a serial port, and they find the board by its
USB vendor ID rather than asking, so the run is unattended and skips itself when
no board is attached.

### Build

**Create a distributable package for your platform:**

```bash
# For Windows
yarn build:win

# For macOS
yarn build:mac

# For Linux
yarn build:linux
```

> **Linux notes:**
>
> The default Modbus port (502) requires elevated access. Modbux notices this on startup and
> offers to fix it for you — it shows the exact command and asks for your password through
> PolicyKit. To do it by hand instead:
>
> ```bash
> sudo sysctl net.ipv4.ip_unprivileged_port_start=502
> ```
>
> To persist across reboots:
>
> ```bash
> echo 'net.ipv4.ip_unprivileged_port_start=502' | sudo tee /etc/sysctl.d/50-unprivileged-ports.conf
> sudo sysctl --system
> ```
>
> Serial ports belong to a group, usually `dialout`. Modbux offers this one too, when you
> select RTU, and reads the group off the device rather than assuming the name. By hand:
>
> ```bash
> sudo usermod -aG dialout $USER
> ```
>
> Log out and back in for it to take effect: a session keeps the groups it was given at
> login, so the file changes immediately and the session does not.

## Contributing

This fork has issues disabled. Open a pull request into `icp` on [fengchyunbih/modbux](https://github.com/fengchyunbih/modbux). See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules. A bug in the upstream app goes to [ploxc/modbux](https://github.com/ploxc/modbux/issues).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Third-Party Software

This software uses open-source packages with permissive licenses (MIT, ISC, Apache-2.0, BSD).
All third-party licenses are included in the distributed application.
