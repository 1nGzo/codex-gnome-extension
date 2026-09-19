import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseCodex, parseGrok, usageWindow} from './usage.js';

const UUID = 'codex-usage@almighty-shogun';
const PROBE_TIMEOUT_SECONDS = 20;
const MAX_BACKOFF_SECONDS = 3600;
const ANTIGRAVITY_RETRIES = [5, 10, 20, 30, 60];
const ANTIGRAVITY_ERRORS = new Set([
    'process unavailable', 'port unavailable', 'rpc unavailable', 'invalid quota response',
]);
const CACHE_VERSION = 1;
const HANDSHAKE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;
const nowInSeconds = () => Math.floor(Date.now() / 1000);

const CODEX = {
    id: 'codex', name: 'Codex', icon: 'codex-icon.svg',
    program: 'codex', args: ['app-server'], initialized: true,
    initialize: {
        clientInfo: {name: 'codex-usage', title: 'Codex Usage', version: '1.0.0'},
        capabilities: {experimentalApi: true},
    },
    method: 'account/rateLimits/read', parse: parseCodex,
};
const GROK = {
    id: 'grok', name: 'Grok', icon: 'grok-icon.svg',
    program: 'grok', args: ['agent', '--no-leader', 'stdio'],
    initialize: {protocolVersion: 1, clientCapabilities: {},
        clientInfo: {name: 'codex-usage', version: '1.0.0'}},
    method: '_x.ai/billing', parse: parseGrok,
};

export function createProviders(extensionPath) {
    return [CODEX, GROK].map(provider => ({
        ...provider, probe: onDone => probeRpc(provider, onDone),
    })).concat({
        id: 'antigravity', name: 'Antigravity', icon: 'antigravity-icon.svg',
        showFiveHour: true,
        probe: onDone => probeAntigravity(extensionPath, onDone),
    });
}

export function detectProvider(provider, onDone) {
    return provider.probe((reading, failure) => {
        const available = Boolean(reading && Array.isArray(reading.windows) && reading.windows.length > 0);
        onDone(available, failure);
    });
}

function probeAntigravity(extensionPath, onDone) {
    const python = GLib.find_program_in_path('python3');
    if (!python) { onDone(null, 'rpc unavailable'); return null; }
    let process;
    try {
        process = Gio.Subprocess.new([python, `${extensionPath}/read-antigravity.py`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch {
        onDone(null, 'rpc unavailable');
        return null;
    }
    const cancellable = new Gio.Cancellable();
    let settled = false;
    let timeoutId = 0;
    const stop = () => {
        settled = true;
        if (timeoutId) GLib.Source.remove(timeoutId);
        timeoutId = 0;
        cancellable.cancel();
        try { process.force_exit(); } catch { /* Already exited. */ }
    };
    const finish = (reading, failure = 'rpc unavailable') => {
        if (settled) return;
        stop();
        onDone(reading, reading ? null : failure);
    };
    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PROBE_TIMEOUT_SECONDS, () => {
        timeoutId = 0;
        finish(null);
        return GLib.SOURCE_REMOVE;
    });
    process.communicate_utf8_async(null, cancellable, (source, result) => {
        if (settled) return;
        let reading = null;
        let failure = 'rpc unavailable';
        try {
            const [, stdout] = source.communicate_utf8_finish(result);
            const payload = JSON.parse(stdout);
            if (source.get_successful() && Array.isArray(payload?.windows) && payload.windows.length)
                reading = payload;
            else if (ANTIGRAVITY_ERRORS.has(payload?.error)) failure = payload.error;
            else failure = 'invalid quota response';
        } catch { /* No valid reading. */ }
        finish(reading, failure);
    });
    return {cancel: stop};
}

function probeRpc(provider, onDone) {
    const program = GLib.find_program_in_path(provider.program);

    if (program === null) {
        onDone(null);

        return null;
    }

    let subprocess;

    try {
        const launcher = new Gio.SubprocessLauncher({flags:
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
        // CLI tools do not inherit GNOME's manual proxy as environment variables.
        // Preserve explicit environment overrides; local Antigravity never uses it.
        const proxy = new Gio.Settings({schema_id: 'org.gnome.system.proxy'});
        if (proxy.get_string('mode') === 'manual') {
            const http = new Gio.Settings({schema_id: 'org.gnome.system.proxy.http'});
            for (const scheme of ['http', 'https']) {
                if (GLib.getenv(`${scheme}_proxy`) || GLib.getenv(`${scheme.toUpperCase()}_PROXY`)) continue;
                let config = new Gio.Settings({schema_id: `org.gnome.system.proxy.${scheme}`});
                if (!config.get_string('host')) config = http;
                let host = config.get_string('host');
                const port = config.get_int('port');
                if (host && port > 0) {
                    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
                    launcher.setenv(`${scheme}_proxy`, `http://${host}:${port}`, true);
                }
            }
        }
        subprocess = launcher.spawnv([program, ...provider.args]);
        launcher.close();
    } catch (error) {
        log(`${UUID}: Failed to start provider CLI: ${error.message}`);
        onDone(null);

        return null;
    }

    const stdin = subprocess.get_stdin_pipe();
    const stdout = new Gio.DataInputStream({ base_stream: subprocess.get_stdout_pipe() });
    const cancellable = new Gio.Cancellable();

    let settled = false;
    let timeoutId = 0;

    const stop = () => {
        settled = true;

        if (timeoutId) {
            GLib.Source.remove(timeoutId);
            timeoutId = 0;
        }

        cancellable.cancel();

        try {
            subprocess.force_exit();
        } catch {
        }
    };

    const finish = reading => {
        if (settled) return;

        stop();
        onDone(reading);
    };

    const send = frame => {
        try {
            stdin.write_all(new TextEncoder().encode(`${JSON.stringify(frame)}\n`), null);
            stdin.flush(null);
        } catch (error) {
            finish(null);
        }
    };

    const readLine = () => {
        if (settled) return;

        stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
            if (settled) return;

            let line;

            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (error) {
                finish(null);

                return;
            }

            if (line === null) {
                finish(null);

                return;
            }

            let frame = null;

            try {
                frame = JSON.parse(line);
            } catch {
            }

            if (frame?.id === HANDSHAKE_REQUEST_ID) {
                if (frame.error) { finish(null); return; }
                if (provider.initialized) send({ method: 'initialized', params: {} });
                send({ jsonrpc: '2.0', id: RATE_LIMITS_REQUEST_ID, method: provider.method, params: {} });
            } else if (frame?.id === RATE_LIMITS_REQUEST_ID) {
                let reading = null;
                try {
                    if (!frame.error) reading = provider.parse(frame.result);
                } catch {
                    // A changed upstream schema is an unavailable reading.
                }
                finish(reading);

                return;
            }

            readLine();
        });
    };

    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PROBE_TIMEOUT_SECONDS, () => {
        timeoutId = 0;
        finish(null);

        return GLib.SOURCE_REMOVE;
    });

    send({jsonrpc: '2.0', id: HANDSHAKE_REQUEST_ID, method: 'initialize', params: provider.initialize});

    readLine();

    return {
        cancel: () => {
            if (settled) return;

            stop();
        }
    };
}

export class UsageReader {
    constructor(settings, provider) {
        this._settings = settings;
        this.provider = provider;
        this.failed = false;
        this._path = GLib.build_filenamev([GLib.get_user_cache_dir(), UUID, provider.id === 'codex' ? 'limits.json' : `${provider.id}-limits.json`]);
        this._observedAt = 0;
        this._windows = [];
        this._retryAt = 0;
        this._backoff = 0;
        this._startupAttempts = 0;
        this._retryTimer = 0;
        this.failureReason = null;
        this._probe = null;

        this._load();
    }

    get observedAt() {
        return this._observedAt;
    }

    get windows() {
        return this._windows;
    }

    get hasReading() {
        return this._observedAt > 0;
    }

    get busy() {
        return this._probe !== null;
    }

    poll(onReading) {
        if (this._probe) return;

        const interval = this._settings.get_int('limit-interval');
        const due = Math.max(this._observedAt + interval, this._retryAt);

        if (nowInSeconds() < due) return;

        if (this._retryTimer) GLib.Source.remove(this._retryTimer);
        this._retryTimer = 0;
        this._probe = this.provider.probe((reading, failure) => {
            this._probe = null;

            this._accept(reading, interval, failure);
            if (this.provider.id === 'antigravity' && this.failed && this._startupAttempts <= ANTIGRAVITY_RETRIES.length &&
                ANTIGRAVITY_ERRORS.has(this.failureReason) && this._backoff === 0) {
                // The panel polls every 30s; its cadence cannot drive 5s retries.
                this._retryTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                    Math.max(1, this._retryAt - nowInSeconds()), () => {
                        this._retryTimer = 0;
                        this.poll(onReading);
                        return GLib.SOURCE_REMOVE;
                    });
            }
            onReading();
        });
    }

    rescan(onReading) {
        if (this._probe) {
            this._probe.cancel();
            this._probe = null;
        }
        if (this._retryTimer) {
            GLib.Source.remove(this._retryTimer);
            this._retryTimer = 0;
        }
        this._retryAt = 0;
        this._backoff = 0;
        this._startupAttempts = 0;
        const interval = this._settings.get_int('limit-interval');
        this._probe = this.provider.probe((reading, failure) => {
            this._probe = null;
            this._accept(reading, interval, failure);
            onReading?.();
        });
    }

    destroy() {
        if (this._retryTimer) GLib.Source.remove(this._retryTimer);
        this._retryTimer = 0;
        this._probe?.cancel();
        this._probe = null;
    }

    _accept(reading, interval, failure = null) {
        this.failed = !reading;
        this.failureReason = this.provider.id === 'antigravity' && !reading
            ? (ANTIGRAVITY_ERRORS.has(failure) ? failure : 'rpc unavailable') : null;
        if (!reading) {
            if (this.provider.id === 'antigravity' && ANTIGRAVITY_ERRORS.has(this.failureReason) &&
                this._startupAttempts < ANTIGRAVITY_RETRIES.length) {
                this._retryAt = nowInSeconds() + ANTIGRAVITY_RETRIES[this._startupAttempts++];
                return;
            }
            this._backoff = Math.min(MAX_BACKOFF_SECONDS, Math.max(interval, this._backoff) * 2);
            this._retryAt = nowInSeconds() + this._backoff;

            return;
        }

        this._startupAttempts = 0;
        this._observedAt = nowInSeconds();
        this._windows = reading.windows;
        this._backoff = 0;
        this._retryAt = 0;

        this._save();
    }

    _load() {
        let contents;

        try {
            [, contents] = Gio.File.new_for_path(this._path).load_contents(null);
        } catch {
            return;
        }

        let cached;

        try {
            cached = JSON.parse(new TextDecoder().decode(contents));
        } catch {
            return;
        }

        if (cached?.version !== CACHE_VERSION) return;

        this._observedAt = Number(cached.observed_at) || 0;
        this._windows = Array.isArray(cached.windows)
            ? cached.windows.map(w => usageWindow(w.usedPercent, w.windowMinutes, w.resetsAt, w.label)).filter(Boolean) : [];
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o700);

            GLib.file_set_contents(this._path, JSON.stringify({
                version: CACHE_VERSION,
                observed_at: this._observedAt,
                windows: this._windows
            }));
        } catch (error) {
            log(`${UUID}: Failed to write ${this._path}: ${error.message}`);
        }
    }
}
