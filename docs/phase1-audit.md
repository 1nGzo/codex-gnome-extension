# Phase 1 local-source audit

Audited 2026-09-19 (Asia/Taipei), on **zoNuc**, after the user explicitly changed
this run's target from X1C. This is not X1C validation.

## Accepted source baseline

- Branch: `feat/multi-provider-foundation`; starting commit `dd180bc`.
- Initial worktree clean; installed/source `extension.js` SHA-256 matched.
- Existing extension ACTIVE; GJS 1.80.2. Existing Codex implementation combined
  transport, cache, window inference and rendering in `extension.js`.
- Its unknown-window fallback could mislabel periods. New mapping requires exact
  window durations. All top-bar percentages continue to mean **remaining**.
- GNOME's PATH includes `~/.local/bin`; its environment has no proxy variables.
  GNOME manual proxy is configured, so CLI launchers inherit that configuration
  without changing desktop settings or wrappers.

## Actual sources (no fixtures)

| Provider | Installed version | Verified read path | Initial live result |
| --- | --- | --- | --- |
| Codex | CLI 0.154.0 | stdio `account/rateLimits/read` | weekly 93% used; 5h absent |
| Grok Build | CLI 1.0.34 | ACP `_x.ai/billing`, no session creation | weekly 24% used, typed weekly period with start/end |
| Antigravity | 2.13.0 | local `LanguageServerService/RetrieveUserQuotaSummary` | Gemini weekly 81.0355% remaining, 5h 100%; Claude/GPT both 100% |

Grok's local `docs/user-guide/04-slash-commands.md` documents `/usage` account
allowance; `grok usage` reports session token/cost and is unsuitable for this task.
The installed CLI's billing extension and live ACP response established the
actual method and fields. Authentication remains owned by the CLI.

Antigravity's installed language-server binary and local logs established the
quota-summary route. Live response fields are `response.groups[].buckets[]` with `window`,
`remainingFraction` and RFC3339 `resetTime`. The app parent without a custom
`--user-data-dir` identifies the default profile. A second profile is running,
but is excluded; its observed reset times were stale. Ports/tokens/PIDs are
runtime state and are not hard-coded or committed.

For Antigravity, each window takes the most-used group and preserves its label.
This is a conservative display of the binding model-group budget, not a provider
aggregate. All groups remain separate upstream; nothing is averaged.

## Scope and boundaries

Fixed provider order; no new preferences, provider auto-selection, account
management or sorting. Existing preferences are retained for compatibility;
legacy five-hour and credits switches do not broaden the minimal UI.

Antigravity must be open in the default profile. Its internal local RPC and
Grok's ACP billing extension are version-sensitive. Unsupported/malformed reads
fail as unavailable (or explicitly marked cached data), never fabricated usage.
No credentials, raw auth responses, account identity or session contents are
stored in the repository or usage cache.

## Validation

The single targeted validation used GJS with the actual running GNOME Shell's
process environment (including its PATH and lack of terminal proxy variables),
real GSettings, an empty temporary cache, and real signed-in services. No mock
responses were used.

- JavaScript/Python/shell syntax, schema compilation and `git diff --check`: PASS.
- All three 16px SVGs load through GdkPixbuf: PASS.
- Codex: weekly **5% remaining** at validation time (usage advanced since audit),
  5h absent; independent cache round trip and refresh interval gating PASS.
- Grok: weekly **76% remaining**, 5h absent; cache and refresh gating PASS.
- Antigravity initially failed because the helper missed the `response` envelope.
  After fixing that single field access, only this failed provider was rerun:
  weekly **81% remaining** (Gemini Models), 5h **100%**; cache round trip including
  the model-group label and refresh gating PASS.
- These are point-in-time readings, not constants or expected future values.

Installed with `./install`; all 11 runtime file hashes match source. The previous
installed bundle was backed up under `/tmp/codex-usage-pre-phase1-3vj4skng/extension`. Native Wayland reload/visual
acceptance requires logout/login and is separate from these tests. No visual
PASS is inferred from syntax, live data, or installed file hashes.

## Icon provenance

Codex icon unchanged. Grok and Antigravity icons are from LobeHub's `lobe-icons`
`packages/static-svg/icons/grok.svg` and `antigravity-color.svg` (MIT; included
`icons/LICENSE.lobe-icons`). SVG sizing is fixed to 24px; Grok uses the same light
fill as the existing Codex icon. Provider marks belong to their respective owners.
Source: https://github.com/lobehub/lobe-icons
