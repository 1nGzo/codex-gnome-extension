# Antigravity cold-start recovery

The local language server can start after GNOME Shell. Antigravity now reports
only four fixed failure categories: `process unavailable`, `port unavailable`,
`rpc unavailable`, and `invalid quota response`. No exception text, process
arguments, CSRF token, or raw response is returned on failure.

Each consecutive failure episode gets five short retries with delays of
5, 10, 20, 30, and 60 seconds. A reader-owned GLib timer drives these retries
because the panel's existing 30-second polling cannot provide a 5-second retry.
Once exhausted, the existing slow backoff applies (600 seconds initially with
the current 300-second setting, capped at 3600 seconds). Success clears the
short-retry budget and restores the configured normal refresh interval, currently
300 seconds. Destroying the reader cancels its retry timer.

Only Antigravity selects this policy. Codex and Grok retain their existing
backoff, and the panel, preferences, authentication and quota semantics are
unchanged. There is no OAuth fallback.

Targeted validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tests/test-antigravity.py
XDG_CACHE_HOME=$(mktemp -d /tmp/antigravity-startup-XXXXXX) gjs -m tests/antigravity-startup.js
```

The Python test checks the four adapter failure categories. The GJS test uses
the real UsageReader and GLib timers with a simulated probe unavailable until
17 seconds after provider startup; recovery is expected around 35 seconds.
It also checks retry exhaustion, reset after success, normal interval gating,
and unchanged Codex/Grok backoff. This is a simulated service-startup test,
not a native GNOME logout/login or an installed-extension visual acceptance.
