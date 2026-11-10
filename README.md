<a href="https://shogun.ms" target="_blank" rel="noopener">
	<img src="https://cdn.shogun.ms/assets/branding/app-icon-256.svg" alt="Shogun app-icon" height="62"/>
</a>

---

# Codex Usage GNOME Extension

The top bar shows a fixed **Codex → Grok** sequence.
Each entry retains the minimal Codex layout: its logo and `N%` **remaining**.
The top bar shows weekly remaining. Codex's popup still includes the 5-hour
window when Codex reports one.
Each opens its own standard GNOME popup with remaining usage, reset time and
`Latest <provider> update`. The existing Codex logo, CSS, bar size and menu behavior are retained.

## Requirements and real data sources

- GNOME Shell 46–50; `codex` and `grok` on the GNOME session's PATH.
- Codex CLI signed in: `codex app-server` → `account/rateLimits/read`.
- Grok Build CLI signed in: `grok agent --no-leader stdio` → ACP `initialize`
  (protocol version 1), then `_x.ai/billing`. Only a
  `USAGE_PERIOD_TYPE_WEEKLY` period is displayed as weekly; monthly billing and
  per-session token/cost totals are not substituted.

Provider order is fixed. No prompts or model calls are made, and no mock data is used.

## Data layer

- `usage.js`: strict normalized `{usedPercent, windowMinutes, resetsAt, label?}`
  windows and Codex/Grok parsers. Only 10080-minute/300-minute windows map to
  weekly/5h; unknown periods never fill those slots. Missing usage is unavailable,
  not zero. Codex's explicit `rateLimitsByLimitId.codex` is preferred when present,
  with the legacy `rateLimits` response supported.
- `providers.js`: fixed provider registry, cancellable bounded probes, independent
  caches, refresh intervals and exponential failure backoff (maximum one hour).
- `extension.js`: shared presentation; one independent menu per provider.

Reads default to every five minutes, with redraws every 30 seconds. A failed
provider cannot block another. Failed refreshes preserve the last successful
reading and mark its timestamp `(cached; read failed)` in the popup. The Codex
cache remains `~/.cache/codex-usage@almighty-shogun/limits.json`; Grok uses
`grok-limits.json`.
Caches contain only quota and observation times, not account credentials.
CLI processes inherit explicit proxy environment values, or use GNOME's existing
manual HTTP/HTTPS proxy configuration when those values are absent.

See [the Phase 1 audit](docs/phase1-audit.md) for host-specific evidence and the
native GNOME acceptance boundary. `tests/validate-live.js` exercises both
real adapters and cache round trips with an isolated `XDG_CACHE_HOME`.

## 💻 Settings

Open them with:

```bash
gnome-extensions prefs codex-usage@almighty-shogun
```

| Setting | Default | Effect |
| --- | --- | --- |
| Panel box | Right | Which section of the top bar holds the indicators. They stay at its outer edge |
| Show icon | On | Draw each provider logo beside the percentage |
| Show 5-hour window | On | Legacy setting; the top bar stays on the weekly figure |
| Show weekly window | On | Show the 7-day figure in the panel label |
| Show credits remaining | On | Legacy setting; the minimal menus omit credits |
| Show progress bars | On | Draw a usage bar under each window in the menu |
| Show Codex | On | Show Codex usage indicator in the top bar |
| Show Grok | On | Show Grok usage indicator in the top bar |
| Use 24-hour times | On | Render `19:50` (24-hour time is standard across all locales) |
| Seconds between reads | 300 | How often each provider is asked for limits, from 60 to 3600 |

Codex and Grok stay together at the outer edge of the chosen section: the left screen edge on the left, and the right edge of the center or right section. Other status icons can appear and disappear without moving them. From left to right the order remains Codex, then Grok.

Turning off the weekly window leaves the icons on their own. Changing the panel box or which providers are shown rebuilds the indicators; the other settings are applied in place.

The installer writes these for you, so a fresh machine comes up configured:

```bash
./install --panel-position=left
./install --use-24-hour-time=true --limit-interval=900
```

Every key in the schema is accepted as `--key=value`. Names, ranges and accepted values are read from the schema itself, so `./install --help` always lists exactly what the installed version supports, and a typo is rejected before anything is written.

## 🔧 Setup

Use the existing CLI logins listed above. Each provider is read independently on its first refresh.

Check that the CLI is where the extension will look for it:

```bash
command -v codex
```

GNOME Shell starts the CLI with the session's `PATH`, so a `codex` installed under `~/.local/bin` or `~/.bun/bin` is found only if that directory is on the `PATH` your session was started with.

## 🚀 Installation & Updating

```bash
git clone https://github.com/Almighty-Shogun/codex-gnome-extension.git
cd codex-gnome-extension
./install
```

Then reload GNOME Shell:

- On X11: press `Alt+F2`, type `r`, and press `Enter`
- On Wayland: log out and log back in

On Wayland, disabling and re-enabling the extension does **not** reload changed source files. GNOME Shell caches the module, so a full logout and login is required.

Enable the extension:

```bash
gnome-extensions enable codex-usage@almighty-shogun
```

To update an existing clone and reinstall the extension:

```bash
cd codex-gnome-extension
./update
```

The update script fetches changes from GitHub, fast-forwards the current branch, and runs the installer.

## 📝 Notes

- Codex and Grok delegate authentication to their CLIs.
- Nothing pops up. `codex app-server` is a stdio JSON-RPC server, not a terminal, and no terminal window is opened to run it.
- The panel shows **remaining** percentages. Codex reports `usedPercent`, so the two are inverses of each other.
- With Codex closed, or with the CLI removed, the last known values persist rather than being cleared.
- Reset times drop the date when the window resets today: `Resets at 7:50 PM` versus `Resets August 7 at 10:00 PM`.
- The `resetsAt` values are Unix epoch seconds and are rendered in local time.
- The popup uses GNOME Shell's standard panel menu behavior and is anchored to the Codex Usage top-bar indicator.
- The menu width is intentionally compact and the progress bars are sized to match.

## 🩺 Troubleshooting

```bash
# Does the CLI answer at all, and how fast?
time (printf '%s\n' \
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"c","title":"c","version":"1"},"capabilities":{"experimentalApi":true}}}' \
  '{"method":"initialized","params":{}}' \
  '{"id":2,"method":"account/rateLimits/read"}'; sleep 3) | codex app-server | grep '"id":2'

# What the extension last read, and when
cat ~/.cache/codex-usage@almighty-shogun/limits.json

# Extension errors
journalctl --user -b | grep codex-usage
```

The `sleep 3` matters: the server exits without answering if stdin closes before the answer is written.

If the panel reads `Usage unavailable`, Codex reported no plan windows. That is what an API key account answers, and what a signed-out CLI answers. Run `codex` once, confirm it is signed in to an account with a plan, and wait for the next read.
