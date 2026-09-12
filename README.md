<a href="https://shogun.ms" target="_blank" rel="noopener">
	<img src="https://cdn.shogun.ms/assets/branding/app-icon-256.svg" alt="Shogun app-icon" height="62"/>
</a>

---

# Codex Usage GNOME Extension

This GNOME Shell extension adds a Codex usage indicator to the top bar, showing how much of each usage window is left.

The extension itself opens no sockets and reads no credentials. It asks the Codex CLI, over that CLI's own stdio, for the limits of the account it is already signed in as, and does so at most once every few minutes.

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
- `Latest Codex update:`, when the limits were last read

## 📦 Requirements

- GNOME Shell 46, 47, 48, 49, or 50
- The `codex` CLI on your `PATH`, signed in to an account with a plan

Codex reports whichever windows its plan exposes. If only the weekly window comes back, the panel shows that one window on its own. An API key account reports no plan windows at all, and the panel reads `Usage unavailable`.

## ✨ What It Does

The extension gives GNOME Shell a view of how much of each Codex usage window is left without opening the CLI.

Codex ships a JSON-RPC server, `codex app-server`, that speaks newline-delimited JSON over stdio. The extension starts it, exchanges three frames, and kills it:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-usage","title":"Codex Usage","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized","params":{}}
{"id":2,"method":"account/rateLimits/read"}
```

The answer to the third frame carries the current limits:

```json
"rateLimits": {
  "limitId":   "codex",
  "primary":   { "usedPercent": 0,  "windowDurationMins": 300,   "resetsAt": 1789186574 },
  "secondary": { "usedPercent": 54, "windowDurationMins": 10080, "resetsAt": 1789510969 },
  "credits":   { "hasCredits": false, "unlimited": false, "balance": "0" },
  "planType":  "plus"
}
```

On each read, the extension:

1. Finds `codex` on `PATH` and starts `codex app-server` with pipes for stdin and stdout. A missing CLI is a clean failure rather than an error.
2. Sends the handshake and the read, holding stdin open until the answer arrives. The server exits without answering if stdin is closed early.
3. Ignores frames it does not recognize. The server sends notifications of its own, such as `remoteControl/status/changed`, before the answer.
4. Takes `rateLimits` and ignores `rateLimitsByLimitId`. The other entries there are a single model's own budget, and showing them would read as a second plan. A `limitId` that is not `codex` is treated as no plan windows.
5. Classifies each window by `windowDurationMins`, where `300` is the 5-hour window and `10080` is the weekly one. The labels come from the duration rather than from the field name, so a window whose length changes is still named correctly.
6. Writes the reading to `~/.cache/codex-usage@almighty-shogun/limits.json` and redraws the panel and the popup.

The whole exchange takes under a second, needs no terminal, and writes nothing into `~/.codex/sessions`.

Reading is deliberately rarer than drawing. The panel redraws every 30 seconds, but Codex is only asked every 5 minutes by default, and the last reading is used in between. A read that fails leaves the last numbers on screen and doubles the wait before the next attempt, up to an hour, so a CLI that is gone or signed out costs one failed start an hour rather than one every 30 seconds. The first success resets that wait.

The cached reading is loaded again when the extension is enabled, so the panel comes up with the last known numbers instead of blank. The popup's `Latest Codex update:` line is how you tell how current they are.

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
| Seconds between reads | 300 | How often Codex is asked for the limits, from 60 to 3600 |

Clutter appends on any negative index, so `-2` would otherwise be identical to `-1`. Values past `-1` are instead resolved against the box's contents when the indicator is inserted, making `-2` the second-to-last slot, `-3` the third-to-last and so on, clamped to the start of the box.

Turning off both windows leaves the icon on its own. Only the two placement settings rebuild the indicator; the rest are applied to it in place.

The installer writes these for you, so a fresh machine comes up configured:

```bash
./install --panel-position=left --panel-index=-1
./install --use-24-hour-time=true --limit-interval=900
```

Every key in the schema is accepted as `--key=value`. Names, ranges and accepted values are read from the schema itself, so `./install --help` always lists exactly what the installed version supports, and a typo is rejected before anything is written.

## 🔧 Setup

Nothing to set up beyond a working Codex CLI. Once the extension is installed and enabled it asks Codex for the limits on its first refresh.

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

- The extension makes no requests of its own and reads no credentials. It asks the signed-in Codex CLI and renders what comes back.
- Nothing pops up. `codex app-server` is a stdio JSON-RPC server, not a terminal, and no terminal window is opened to run it.
- The panel shows **remaining** percentages. Codex reports `usedPercent`, so the two are inverses of each other.
- With Codex closed, or with the CLI removed, the last known values persist rather than being cleared.
- Reset times drop the date when the window resets today: `Resets at 7:50 PM` versus `Resets August 7 at 10:00 PM`.
- Credits are normalized before display. Missing credits are rendered as `0`, `unlimited` as `Unlimited`, and anything else as its `balance`. The row can be hidden in settings.
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
