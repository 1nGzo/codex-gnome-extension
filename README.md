<a href="https://shogun.ms" target="_blank" rel="noopener">
	<img src="https://cdn.shogun.ms/assets/branding/app-icon-256.svg" alt="Shogun app-icon" height="62"/>
</a>

---

# Codex Usage GNOME Extension

This GNOME Shell extension adds a Codex usage indicator to the top bar, showing how much of each usage window is left.

It makes **no API calls**. Codex already records the rate limits it is told about into the session transcript it writes locally, and the extension reads those files. Nothing polls OpenAI, so there is nothing to rate-limit.

When both usage windows are reported, the panel label is:

`<codex-icon> <5-hour-remaining> • <weekly-remaining>`

Example:

`<icon> 91% • 95%`

If only one window is reported, the label names it instead:

`<icon> Weekly 64%`

Selecting the indicator opens a popup with:

- 5-hour usage remaining
- Weekly usage remaining
- When each window resets
- Credits remaining, shown as `0` when Codex does not report a credit value
- `Latest Codex update:`, when the newest Codex data was seen

## 📦 Requirements

- GNOME Shell 46, 47, 48, 49, or 50
- A working Codex CLI setup that writes session files to `~/.codex/sessions`

No network access and no credentials are required. The extension only reads local files.

Codex reports whichever windows its plan exposes. If only the weekly window is present in your session files, the panel shows that one window on its own.

## ✨ What It Does

The extension gives GNOME Shell a view of how much of each Codex usage window is left without opening the CLI. It is intended for users already running Codex locally, where session data is being written under `~/.codex/sessions`.

Codex writes one JSONL transcript per session under `~/.codex/sessions/YYYY/MM/DD`. Some records in it are `event_msg` entries whose `token_count` payload carries a `rate_limits` block:

```json
"rate_limits": {
  "primary":   { "used_percent": 30.0, "window_minutes": 10080, "resets_at": 1786194326 },
  "secondary": { "used_percent": 12.0, "window_minutes": 300,   "resets_at": 1786125600 },
  "credits":   { "has_credits": false, "unlimited": false, "balance": "0" }
}
```

Codex appends to those transcripts as it works and nothing signals when one changes, so the extension re-reads the session directory every 30 seconds and leans on modified times to keep that cheap.

On each refresh, the extension:

1. Lists every `.jsonl` file under `~/.codex/sessions` and keeps the 20 most recently modified. Codex files a session under the day it *started* and keeps appending there while it runs, so the newest data is often not in the newest-dated directory; the ranking is by modified time, not by path.
2. Checks each of those files by path and microsecond-precision modified time, reusing cached parse results for unchanged files. The cache belongs to the extension rather than the indicator, so changing a setting does not force a re-parse.
3. Reads the changed files and extracts the `event_msg` records that carry `rate_limits`.
4. Classifies each reported limit by `window_minutes`, where `300` is the 5-hour window and `10080` is the weekly window.
5. Keeps the newest known value for each window independently, so a weekly-only update does not overwrite or masquerade as 5-hour usage.
6. Redraws the panel label and the popup from the newest values.

Because updates only arrive while Codex is running, the last known values stay on screen when it closes rather than being blanked. The popup's `Latest Codex update:` line is how you tell how current they are. Refresh errors are caught and logged inside the timer callback, which always asks for another tick, so a parsing or filesystem error does not stop future updates.

## 💻 Settings

Open them with:

```bash
gnome-extensions prefs codex-usage@almighty-shogun
```

| Setting | Default | Effect |
| --- | --- | --- |
| Panel box | Right | Which section of the top bar holds the indicator |
| Position in box | 0 | Order within that box; `0` is first, `-1` is last, lower negatives count back from the end |
| Show icon | On | Draw the Codex logo beside the percentages |
| Show 5-hour window | On | Include the 5-hour figure in the panel label |
| Show weekly window | On | Include the 7-day figure in the panel label |
| Show credits remaining | On | Include the credits row in the menu |
| Show progress bars | On | Draw a usage bar under each window in the menu |
| Use 24-hour times | Off | Render `19:50` rather than `7:50 PM` |

Clutter appends on any negative index, so `-2` would otherwise be identical to `-1`. Values past `-1` are instead resolved against the box's contents when the indicator is inserted, making `-2` the second-to-last slot, `-3` the third-to-last and so on, clamped to the start of the box.

Turning off both windows leaves the icon on its own. Only the two placement settings rebuild the indicator; the rest are applied to it in place.

The installer writes these for you, so a fresh machine comes up configured:

```bash
./install --panel-position=left --panel-index=-1
./install --use-24-hour-time=true --show-progress-bars=false
```

Every key in the schema is accepted as `--key=value`. Names, ranges and accepted values are read from the schema itself, so `./install --help` always lists exactly what the installed version supports, and a typo is rejected before anything is written.

## 🔧 Setup

Nothing to set up. Codex writes the session files this extension reads as a normal part of running, so once the extension is installed and enabled it picks them up on its next refresh.

If `~/.codex/sessions` is empty, run a Codex prompt and the first transcript appears.

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

- The extension makes no network requests and reads no credentials. It only reads the session files Codex has already written under `~/.codex/sessions`.
- The panel shows **remaining** percentages. The session files store Codex's raw `used_percent`, so the two are inverses of each other.
- With Codex closed, the last known values persist rather than being cleared.
- Reset times drop the date when the window resets today: `Resets at 7:50 PM` versus `Resets August 7 at 10:00 PM`.
- If Codex stops reporting a specific window, the popup keeps the last known value while that window is still relevant and marks when it was last reported.
- Credits are normalized before display. Missing credits and `has_credits: false` are rendered as `0`, while fields like `balance`, `remaining`, or `unlimited` are rendered as simple readable values. The row can be hidden in settings.
- The `resets_at` values are Unix epoch seconds and are rendered in local time.
- The popup uses GNOME Shell's standard panel menu behavior and is anchored to the Codex Usage top-bar indicator.
- The menu width is intentionally compact and the progress bars are sized to match.

## 🩺 Troubleshooting

```bash
# Is Codex writing session files at all?
ls -lt ~/.codex/sessions/*/*/*/*.jsonl | head

# Which usage windows does your plan actually report?
grep -ho '"window_minutes":[0-9]*' ~/.codex/sessions/*/*/*/*.jsonl | sort | uniq -c

# Extension errors
journalctl --user -b | grep codex-usage
```

If the panel reads `Usage unavailable`, no session file has yet reported a
`token_count` payload containing `rate_limits`: run a Codex prompt and wait for
the next 30-second refresh.
