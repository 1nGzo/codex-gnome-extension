// Targeted simulated delayed-service validation; no account or app interaction.
import GLib from 'gi://GLib';
import System from 'system';
import {UsageReader} from '../providers.js';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const settings = {get_int: () => 300};
const start = Date.now();
const attempts = [];
const loop = new GLib.MainLoop(null, false);
let failed = false;
const reading = {windows: [{usedPercent: 19, windowMinutes: 10080,
    resetsAt: Math.floor(Date.now() / 1000) + 86400, label: 'Simulated group'}]};
const reader = new UsageReader(settings, {id: 'antigravity', probe: done => {
    const seconds = (Date.now() - start) / 1000;
    attempts.push(seconds);
    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        done(seconds >= 17 ? reading : null, 'process unavailable');
        return GLib.SOURCE_REMOVE;
    });
    return {cancel: () => GLib.Source.remove(id)};
}});
// Verify the complete retry budget and unchanged other-provider backoff.
for (const reason of ['process unavailable', 'port unavailable', 'rpc unavailable', 'invalid quota response']) {
    const r = new UsageReader(settings, {id: 'antigravity'});
    for (const delay of [5, 10, 20, 30, 60, 600]) {
        r._accept(null, 300, reason);
        assert(Math.abs(r._retryAt - Math.floor(Date.now() / 1000) - delay) <= 1, 'Retry budget: ' + reason);
    }
    r._accept(reading, 300);
    assert(r._startupAttempts === 0 && r._retryAt === 0 && !r.failureReason, 'Success resets retry state');
    r.destroy();
}
for (const id of ['codex', 'grok']) {
    const r = new UsageReader(settings, {id});
    for (const delay of [600, 1200, 2400, 3600]) {
        r._accept(null, 300);
        assert(Math.abs(r._retryAt - Math.floor(Date.now() / 1000) - delay) <= 1, 'Other provider changed');
    }
    r.destroy();
}
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 58, () => {
    failed = true; printerr('Recovery exceeded one minute'); loop.quit(); return GLib.SOURCE_REMOVE;
});
reader.poll(() => {
    if (!reader.hasReading) return;
    try {
        assert(!reader.failed && !reader.busy, 'Recovery state');
        assert(attempts.length === 4 && attempts.at(-1) < 55, 'Expected recovery around 35s');
        assert(!reader._retryTimer && !reader._retryAt, 'Timer cleared');
        const count = attempts.length;
        reader.poll(() => { throw new Error('Early normal refresh'); });
        assert(attempts.length === count, '300s normal interval not restored');
        print(JSON.stringify({result: 'PASS', simulatedReadyAt: 17, attempts, normalInterval: 300}));
    } catch (error) { failed = true; printerr(error.message); }
    GLib.Source.remove(watchdog);
    loop.quit();
});
loop.run();
reader.destroy();
assert(!reader._retryTimer, 'Destroy clears timer');
System.exit(failed ? 1 : 0);
