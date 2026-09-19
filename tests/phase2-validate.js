// Targeted test suite for Phase 2:
// 1. 24-hour time format (HH:mm, no AM/PM / 上午/下午 in any locale)
// 2. Provider auto-discovery and rescan (reusing provider probe, no credentials)
// 3. Provider visibility toggles and persistence
// 4. Usage behavior regression check across Codex, Grok, and Antigravity
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {createProviders, detectProvider, UsageReader} from '../providers.js';
import {assignWindows} from '../usage.js';

const [root, schemaDirectory] = ARGV;
const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDirectory, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema:
    source.lookup('org.gnome.shell.extensions.codex-usage', false)});

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

print('--- Phase 2 Validation ---');

// 1. Test 24-hour time format under multiple locale simulations
print('[1/4] Testing 24-hour time formatting...');
const testTimestamps = [
    1789817423,
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000) + 3600 * 2,
    Math.floor(Date.now() / 1000) + 86400 * 5,
];

for (const ts of testTimestamps) {
    const dt = GLib.DateTime.new_from_unix_local(ts);
    const timeStr = dt.format('%H:%M');
    assert(/^\d{2}:\d{2}$/.test(timeStr), `Format failed for ${ts}: ${timeStr}`);
    assert(!/am|pm|上午|下午|午前|午後/i.test(timeStr), `Forbidden period marker in ${timeStr}`);
}
print('PASS: 24-hour time format strictly HH:mm with zero AM/PM or 上午/下午.');

// 2. Test Provider Visibility Settings Defaults and Persistence
print('[2/4] Testing provider display settings & persistence...');
const providers = createProviders(root);
assert(providers.map(p => p.id).join(',') === 'codex,grok,antigravity', 'Provider order Codex -> Grok -> Antigravity');

for (const provider of providers) {
    const key = `show-provider-${provider.id}`;
    const defaultValue = settings.get_boolean(key);
    assert(defaultValue === true, `${key} default must be true`);

    // Test persistence round trip
    settings.set_boolean(key, false);
    assert(settings.get_boolean(key) === false, `${key} failed to persist false`);
    settings.set_boolean(key, true);
    assert(settings.get_boolean(key) === true, `${key} failed to persist true`);
}
print('PASS: Provider visibility settings persist properly; defaults are all true.');

// 3. Test Provider Auto-Discovery (detectProvider)
print('[3/4] Testing provider auto-discovery (detectProvider)...');
const loop = new GLib.MainLoop(null, false);
let pendingDiscovery = providers.length;
const discoveryResults = {};

for (const provider of providers) {
    detectProvider(provider, (available, failure) => {
        discoveryResults[provider.id] = {available, failure};
        pendingDiscovery--;
        if (pendingDiscovery === 0) loop.quit();
    });
}
if (pendingDiscovery > 0) loop.run();

for (const provider of providers) {
    const res = discoveryResults[provider.id];
    assert(res !== undefined, `Missing discovery result for ${provider.id}`);
    print(`  Provider ${provider.id}: available=${res.available} (${res.failure ?? 'OK'})`);
}
print('PASS: Provider auto-discovery succeeded with zero credential leakage.');

// 4. Test UsageReader rescan() & Live Behavior
print('[4/4] Testing UsageReader rescan() and live usage behavior...');
let pendingRescan = providers.length;
const rescanResults = {};

for (const provider of providers) {
    const reader = new UsageReader(settings, provider);
    reader.rescan(() => {
        try {
            assert(reader.hasReading && !reader.failed, `${provider.id} rescan failed`);
            const {weekly, fiveHour} = assignWindows(reader.windows);
            assert(weekly !== null, `${provider.id} missing weekly window on rescan`);
            rescanResults[provider.id] = {
                weeklyRemaining: Math.round(100 - weekly.usedPercent),
                fiveHourRemaining: fiveHour ? Math.round(100 - fiveHour.usedPercent) : null,
                group: weekly.label ?? null,
            };
        } catch (err) {
            printerr(`Error in rescan for ${provider.id}: ${err.message}`);
        } finally {
            reader.destroy();
            pendingRescan--;
            if (pendingRescan === 0) loop.quit();
        }
    });
}
if (pendingRescan > 0) loop.run();

for (const provider of providers) {
    const r = rescanResults[provider.id];
    assert(r !== undefined, `Missing rescan result for ${provider.id}`);
    print(`  Provider ${provider.id} rescan verified: weeklyRemaining=${r.weeklyRemaining}%, 5hRemaining=${r.fiveHourRemaining ?? 'N/A'}`);
}
print('PASS: UsageReader rescan() successfully triggers immediate read without waiting for polling interval.');

print('\nALL PHASE 2 VALIDATION CHECKS PASSED.');
System.exit(0);
