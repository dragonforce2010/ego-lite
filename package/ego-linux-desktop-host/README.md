# Linux desktop reference host (experimental)

An opt-in Linux host for the public ego-browser SDK, with a visible Spaces UI.
The top-right counter opens a grid of real page previews; choosing a card enters
the exact space and page that an Agent is using. Spaces have separate persistent
Electron partitions, visible ownership, and human takeover/return controls.

This package is private and experimental. It does not change the installed macOS
or Windows application, the default SDK, installation guides, or release jobs.
It is not the proprietary ego lite browser or an official Linux distribution.
Related Linux work is tracked in [#140](https://github.com/citrolabs/ego-lite/issues/140),
[#202](https://github.com/citrolabs/ego-lite/pull/202) and
[#291](https://github.com/citrolabs/ego-lite/pull/291). This proposal focuses on a
headed, inspectable desktop with per-space site data and user control.

## Prerequisites and setup

Use Linux x86_64, Node.js 22+, Python 3, a working desktop display and the system
libraries required by Electron. Run as an unprivileged desktop user with Chromium
sandbox support. Do not use `--no-sandbox` or disable TLS verification.

```sh
cd package/ego-linux-desktop-host
npm install --ignore-scripts
node node_modules/electron/install.js
npm run prepare:sdk
npm start
```

Electron is pinned to 45.2.3. The SDK preparation command verifies the original
v2.2.0 ZIP's SHA-256 before extraction and refuses to overwrite an existing SDK.
It records the source and adapted bundle digests. There is no runtime download.
Build systems that download or cache dependencies separately may run
`python3 prepare-sdk.py --archive /absolute/path/ego-browser-v2.2.0.zip`.
This offline path enforces the same archive size limit, pinned SHA-256,
safe extraction and guarded SDK adaptations as the direct download path.

The SDK bundle receives two guarded adapters: use the Electron host's random
instance identity for the cross-round page ledger, and use the host's serialized
native clipboard transaction on Linux. Neither adapter changes the SDK public
helpers. This pinned experiment deliberately leaves the SDK source and native
platform implementations unchanged; upstream maintainers can choose the eventual
extension contract separately.

```sh
node cli.mjs skill
node cli.mjs nodejs <<'JS'
const task = await taskSpace('Read the example page');
const page = task.page('p1');
await page.goto('https://example.org');
console.log(task.spaceId, await page.title());
console.log(await page.snapshot());
JS
```

The optional `ego-browser-linux` bin has the same `skill`, `--version`, and
`nodejs [-e script]` commands. Resume the printed numeric space ID in the next
invocation. Closing the browser preserves spaces, page URLs and site data;
reopening creates new target identities, so observe/adopt the restored tabs
instead of reusing pre-restart target IDs or stale refs.

## View and take over a space

1. Click the counter in the top-right corner to open **All spaces**.
2. Inspect each card's real preview, name, active title, tab count and state.
3. Click a card to enter that Agent space. Its existing page and data stay intact.
4. Select **Take over** to control that space. Agent input is rejected while you
   own it. Select **Return control**, then let the Agent observe the page again.
5. Use the plus card to create a separate personal space.

The running badge requires an active SDK client in that space. An idle Agent is
shown as waiting; model thinking is not presented as browser input. Previews are
captured only while the overview is open and remain in memory.

## Local configuration and security boundary

- `EGO_LINUX_USER_DATA_DIR`: absolute private profile directory. Default:
  `$XDG_DATA_HOME/ego-linux-reference` (or `~/.local/share/ego-linux-reference`).
- `EGO_LINUX_WORKSPACE`: optional existing absolute directory owned by the user
  for local page navigation; defaults to a private `workspace` inside the profile.
  It remains stable when CLI rounds have different current working directories.
- `EGO_LINUX_ELECTRON`: optional absolute Electron executable; otherwise uses the
  package's pinned dependency. No browser process is launched as root.
- `EGO_LINUX_CONTROL_FILE`: optional private regular file supplied by a desktop
  supervisor. It contains `ready`, `boot_id` and `control_mode` (`agent` or `human`);
  the launcher reads that supervisor's `boot_id` and binds the runtime to it.
  The profile stays stable across desktop boots while the private socket runtime
  changes with the boot identity. Refresh the file atomically at least every two
  seconds. Missing, unsafe, over-five-second-old or mismatched configured state
  blocks automation. Without this option, per-space ownership is enforced.

Version 0.2.3 clears the waiting-for-takeover status on an explicit return,
preserves each space's original creator across a restart, and keeps restored
page URLs while their first navigation is still loading. A normal window close
or SIGTERM writes the space state and flushes site storage before quitting.

The Unix socket and runtime/profile directories are private to the current Unix
user. Scripts running as that user are trusted; spaces do not isolate untrusted
local users or code from the operating system. Foreign task target/session IDs
and browser-wide CDP operations are refused. Web content uses sandboxed renderers,
context isolation, Node integration disabled and normal Chromium web security.
No raw CDP listener, HTTP control port or public WebSocket is opened.

## Validation status and limits

The originating Linux desktop implementation has been exercised in an isolated
remote acceptance environment with SDK v2.2.0 and Electron 45.2.3: real two-space
browsing, same-origin localStorage isolation, page reuse across independent CLI
rounds, the overview/detail UI, and human takeover/return. Private deployment
addresses, credentials and customer artifacts are intentionally absent here.

The extracted package at `10dfd2d4a5524f32a47fe77cf3cb9b148cbf2d9d`
was downloaded from the public fork into a separate remote desktop profile.
All 12 package files were checked against their SHA-256 values before launch.
The unprivileged launcher became ready; real Example/IANA browsing, same-origin
localStorage isolation, and reuse of the same page targets across independent
CLI rounds passed. The visible overview and entry into an existing Agent page
were also observed. These runs reused verified SDK/Electron dependencies already
present on that remote desktop; a fresh dependency installation is not claimed.

The first receipt attempted to read `Page.targetId`, which is not part of this
pinned SDK's Page surface. That failure was retained. The next run used the
documented `tabs()` inventory to inspect the existing pages and site data across
two CLI processes, without replaying their setup writes.

Extracted UI takeover/return, restart restoration and the optional supervisor
adapter are not yet signed off. Desktop transport interruptions prevented those
checks from completing; the originating implementation's results do not fill
these gaps. No local product tests or development CI were run for this
contribution.

Native Wayland, ARM64, broad distribution compatibility, the native Ego browser
E2E suite, proprietary snapshots and native-profile import remain unverified or
unsupported. Closing a browser persists its pages, not an unfinished script or
the remote site's server session. Sites can expire or revoke login state normally.
