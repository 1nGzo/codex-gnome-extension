// Run with gjs -m, an isolated XDG_CACHE_HOME, and the real GNOME environment.
// No fixtures, fabricated quota, prompts, or model calls.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';
import {createProviders, UsageReader} from '../providers.js';
import {assignWindows} from '../usage.js';

const [root, schemaDirectory, onlyProvider] = ARGV;
const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDirectory, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema:
    source.lookup('org.gnome.shell.extensions.codex-usage', false)});
const providers = createProviders(root);
const selected = onlyProvider ? providers.filter(p => p.id === onlyProvider) : providers;
const loop = new GLib.MainLoop(null, false);
const readers = [];
let pending = selected.length;
let failures = 0;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(providers.map(p => p.id).join(',') === 'codex,grok,antigravity', 'Provider order');
assert(providers.filter(p => p.showFiveHour).map(p => p.id).join() === 'antigravity', 'Menu-only 5h');
assert(selected.length > 0, 'Unknown provider');
for (const provider of selected) {
    GdkPixbuf.Pixbuf.new_from_file_at_scale(`${root}/icons/${provider.icon}`, 16, 16, true);
    const reader = new UsageReader(settings, provider);
    readers.push(reader);
    assert(!reader.hasReading, 'Validation requires an empty, isolated cache');
    reader.poll(() => {
        try {
            assert(reader.hasReading && !reader.failed && !reader.busy, `${provider.name}: live read failed`);
            const {weekly, fiveHour} = assignWindows(reader.windows);
            assert(weekly !== null, `${provider.name}: no verified weekly window`);
            for (const window of reader.windows) {
                assert(Number.isFinite(window.usedPercent) && window.usedPercent >= 0 &&
                    window.usedPercent <= 100, 'Invalid percentage');
                assert(window.resetsAt > Date.now() / 1000, 'Expired/missing reset');
            }
            if (provider.showFiveHour) assert(fiveHour?.label && weekly.label, 'Antigravity windows/group attribution');
            const restored = new UsageReader(settings, provider);
            assert(restored.observedAt === reader.observedAt &&
                JSON.stringify(restored.windows) === JSON.stringify(reader.windows), 'Cache round trip');
            restored.poll(() => { failures++; printerr('Unexpected read inside refresh interval'); });
            assert(!restored.busy, 'Refresh interval bypassed');
            restored.destroy();
            print(JSON.stringify({provider: provider.id, observedAt: reader.observedAt,
                weeklyRemaining: Math.round(100 - weekly.usedPercent),
                fiveHourRemaining: fiveHour ? Math.round(100 - fiveHour.usedPercent) : null,
                group: weekly.label ?? null, cacheRoundTrip: 'PASS'}));
        } catch (error) {
            failures++;
            printerr(error.message);
        } finally {
            reader.destroy();
            if (--pending === 0) loop.quit();
        }
    });
}
if (pending > 0) loop.run();
for (const reader of readers) reader.destroy();
System.exit(failures ? 1 : 0);
