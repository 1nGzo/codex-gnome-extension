<a href="https://shogun.ms" target="_blank" rel="noopener">
	<img src="https://cdn.shogun.ms/assets/branding/app-icon-256.svg" alt="Shogun app-icon" height="62"/>
</a>

---

# Codex Usage GNOME Extension

Phase 1 adds a fixed **Codex → Grok → Antigravity** sequence to the top bar.
Each entry retains the minimal Codex layout: its logo and `N%` **remaining**.
Each opens its own standard GNOME popup with weekly remaining, reset time and
`Latest <provider> update`. Antigravity additionally shows 5-hour remaining **only
in its popup**. The existing Codex logo, CSS, bar size and menu behavior are retained.

## Requirements and real data sources

- GNOME Shell 46–50; `codex`, `grok`, and `python3` on the GNOME session's PATH.
- Codex CLI signed in: `codex app-server` → `account/rateLimits/read`.
- Grok Build CLI signed in: `grok agent --no-leader stdio` → ACP `initialize`
  (protocol version 1), then `_x.ai/billing`. Only a
  `USAGE_PERIOD_TYPE_WEEKLY` period is displayed as weekly; monthly billing and
  per-session token/cost totals are not substituted.
- Antigravity's **default profile must be running and signed in**. A short-lived
  Python standard-library helper reads its own user's language-server process,
  finds its loopback port, and calls `RetrieveUserQuotaSummary` with
  `forceRefresh: true`. Its per-process CSRF token stays in memory and never enters
  the extension output, cache, logs, or repository. Alternate profiles and
  ambiguous default instances are excluded. No app is started or logged in.

Antigravity reports separate model-group pools. For each window, the indicator
uses the **lowest remaining percentage across groups**, never an average or sum.
The popup names the most-used group; weekly and 5h can refer to different groups.
Expired quota responses are rejected. The helper discovers only the running
service's ephemeral transport endpoint; provider availability/order is fixed.

There are no new settings pages, provider auto-selection, sorting, account
switching, or multi-account support in this phase. No prompts/model calls are
made and no mock data is used.

## Data layer

- `usage.js`: strict normalized `{usedPercent, windowMinutes, resetsAt, label?}`
  windows and Codex/Grok parsers. Only 10080-minute/300-minute windows map to
  weekly/5h; unknown periods never fill those slots. Missing usage is unavailable,
  not zero. Codex's explicit `rateLimitsByLimitId.codex` is preferred when present,
  with the legacy `rateLimits` response supported.
- `providers.js`: fixed provider registry, cancellable bounded probes, independent
  caches, refresh intervals and exponential failure backoff (maximum one hour).
- `read-antigravity.py`: default-profile loopback adapter; emits normalized usage
  only. This internal endpoint was verified against Antigravity 2.13.0 and can
  change in later versions.
- `extension.js`: shared presentation; one independent menu per provider.

Reads default to every five minutes, with redraws every 30 seconds. A failed
provider cannot block another. Failed refreshes preserve the last successful
reading and mark its timestamp `(cached; read failed)` in the popup. The Codex
cache remains `~/.cache/codex-usage@almighty-shogun/limits.json`; Grok and
Antigravity use separate `grok-limits.json` and `antigravity-limits.json` files.
Caches contain only quota and observation times, not account credentials.
CLI processes inherit explicit proxy environment values, or use GNOME's existing
manual HTTP/HTTPS proxy configuration when those values are absent. Antigravity
requests stay on loopback and bypass proxies.

See [the Phase 1 audit](docs/phase1-audit.md) for host-specific evidence and the
native GNOME acceptance boundary. `tests/validate-live.js` exercises all three
real adapters and cache round trips with an isolated `XDG_CACHE_HOME`.

## 💻 Settings

Open them with:

```bash
gnome-extensions prefs codex-usage@almighty-shogun
```

| Setting | Default | Effect |
| --- | --- | --- |
| Panel box | Right | Which section of the top bar holds the indicator |
| Position in box | 0 | Order within that box; `0` is first, `-1` is last, lower negatives count back from the end |
| Show icon | On | Draw each provider logo beside the percentage |
| Show 5-hour window | On | Legacy setting; keeps the panel weekly-only |
| Show weekly window | On | Include the 7-day figure in the panel label |
| Show credits remaining | On | Legacy setting; the minimal menus omit credits |
| Show progress bars | On | Draw a usage bar under each window in the menu |
| Show Codex | On | Show Codex usage indicator in the top bar |
| Show Grok | On | Show Grok usage indicator in the top bar |
| Show Antigravity | On | Show Antigravity usage indicator in the top bar |
| Use 24-hour times | On | Render `19:50` (24-hour time is standard across all locales) |
| Seconds between reads | 300 | How often each provider is asked for limits, from 60 to 3600 |

Clutter appends on any negative index, so `-2` would otherwise be identical to `-1`. Values past `-1` are instead resolved against the box's contents when the indicator is inserted, making `-2` the second-to-last slot, `-3` the third-to-last and so on, clamped to the start of the box.

Turning off the weekly window leaves the icons on their own. Only the two placement settings rebuild the indicator; the rest are applied to it in place.

The installer writes these for you, so a fresh machine comes up configured:

```bash
./install --panel-position=left --panel-index=-1
./install --use-24-hour-time=true --limit-interval=900
```

Every key in the schema is accepted as `--key=value`. Names, ranges and accepted values are read from the schema itself, so `./install --help` always lists exactly what the installed version supports, and a typo is rejected before anything is written.

## 🔧 Setup

Use the existing CLI logins and running default Antigravity profile listed above. Each provider is read independently on its first refresh.

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

- Codex/Grok delegate authentication to their CLIs; Antigravity uses its running local service and in-memory CSRF token.
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
