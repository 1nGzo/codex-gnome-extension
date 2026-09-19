import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {UsageReader} from '../providers.js';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const settings = {get_int: () => 300};
let start = Date.now();
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
for (const reason of ['port unavailable', 'rpc unavailable', 'invalid quota response']) {
    const r = new UsageReader(settings, {id: 'antigravity'});
    for (const delay of [5, 10, 20, 30, 60, 600]) {
        r._accept(null, 300, reason);
        assert(Math.abs(r._retryAt - Math.floor(Date.now() / 1000) - delay) <= 1, 'Retry budget: ' + reason);
    }
    r._accept(reading, 300);
    assert(r._startupAttempts === 0 && r._retryAt === 0 && !r.failureReason, 'Success resets retry state');
    r.destroy();
}
// process unavailable enters 30s low-cost periodic polling after 5->10->20->30->60s
{
    const r = new UsageReader(settings, {id: 'antigravity'});
    for (const delay of [5, 10, 20, 30, 60, 30, 30]) {
        r._accept(null, 300, 'process unavailable');
        assert(Math.abs(r._retryAt - Math.floor(Date.now() / 1000) - delay) <= 1, 'Process unavailable delay: ' + delay);
        assert(r._backoff === 0, 'Process unavailable must not enter exponential backoff');
    }
    // Transition from process unavailable to port unavailable resets startup attempts
    r._accept(null, 300, 'port unavailable');
    assert(Math.abs(r._retryAt - Math.floor(Date.now() / 1000) - 5) <= 1, 'Service transition resets to 5s');
    r._accept(reading, 300);
    assert(r._startupAttempts === 0 && r._retryAt === 0 && !r.failureReason, 'Success resets retry state');
    r.destroy();
}
// Delayed startup (> 2 minutes): Antigravity launches after short retries exhausted
{
    const r = new UsageReader(settings, {id: 'antigravity'});
    for (let i = 0; i < 5; i++) {
        r._accept(null, 300, 'process unavailable');
    }
    // 6th attempt (T+125s) exhausts short retries
    r._accept(null, 300, 'process unavailable');
    assert(r._backoff === 0, 'Delayed startup backoff remains 0');
    assert(Math.abs(r._retryAt - Math.floor(Date.now() / 1000) - 30) <= 1, '30s idle poll scheduled');
    // Simulated panel poll succeeds when Antigravity appears
    r._accept(reading, 300);
    assert(!r.failed && r.hasReading && r._backoff === 0 && r._retryAt === 0, 'Auto-recovers without manual rescan');
    assert(r.windows.length > 0, 'Valid windows present');
    r.poll(() => { throw new Error('Early poll during 300s interval'); });
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
try { Gio.File.new_for_path(reader._path).delete(null); } catch {}
reader._observedAt = 0;
reader._windows = [];
reader._retryAt = 0;
reader._backoff = 0;
reader._startupAttempts = 0;
reader.failed = false;
start = Date.now();
attempts.length = 0;

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
