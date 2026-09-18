import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'codex-usage@almighty-shogun';

const REFRESH_INTERVAL_SECONDS = 30;
const PROBE_TIMEOUT_SECONDS = 15;
const MAX_BACKOFF_SECONDS = 3600;
const CACHE_VERSION = 1;
const PROGRESS_BAR_WIDTH = 220;
const MIN_VISIBLE_FILL_WIDTH = 3;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10080;

const HANDSHAKE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;

const PANEL_SEPARATOR = '•';

const PANEL_BOXES = {
    left: '_leftBox',
    center: '_centerBox',
    right: '_rightBox'
};

const REBUILD_KEYS = [
    'panel-position',
    'panel-index'
];

const APPEARANCE_KEYS = [
    'show-icon',
    'show-five-hour',
    'show-weekly',
    'show-credits',
    'show-progress-bars',
    'use-24-hour-time'
];

function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function nowInSeconds() {
    return Math.floor(Date.now() / 1000);
}

function windowTitle(minutes, fallback) {
    if (!Number.isFinite(minutes) || minutes <= 0) return fallback;

    if (minutes === WEEKLY_WINDOW_MINUTES) return 'Weekly usage limit';

    if (minutes % WEEKLY_WINDOW_MINUTES === 0) return `${minutes / WEEKLY_WINDOW_MINUTES}-week usage limit`;

    if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}-day usage limit`;

    if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}-hour usage limit`;

    return `${minutes}-minute usage limit`;
}

function windowPrefix(minutes, fallback) {
    if (!Number.isFinite(minutes) || minutes <= 0) return fallback;

    if (minutes === WEEKLY_WINDOW_MINUTES) return 'Weekly';

    if (minutes % WEEKLY_WINDOW_MINUTES === 0) return `${minutes / WEEKLY_WINDOW_MINUTES}w`;

    if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;

    if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;

    return `${minutes}m`;
}

function parseCredits(credits) {
    if (!credits || typeof credits !== 'object') return null;

    return {
        unlimited: credits.unlimited === true,
        balance: credits.balance ?? null
    };
}

function parseRateLimits(rateLimits) {
    if (!rateLimits || typeof rateLimits !== 'object') return null;

    if (typeof rateLimits.limitId === 'string' && rateLimits.limitId !== 'codex')
        return { windows: [], credits: null };

    const windows = [];

    for (const key of ['primary', 'secondary']) {
        const window = rateLimits[key];

        if (!window || typeof window.usedPercent !== 'number') continue;

        const windowMinutes = Number(window.windowDurationMins);
        const resetsAt = Number(window.resetsAt);

        windows.push({
            usedPercent: window.usedPercent,
            windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
            resetsAt: Number.isFinite(resetsAt) ? resetsAt : null
        });
    }

    return {
        windows,
        credits: parseCredits(rateLimits.credits)
    };
}

function assignWindows(windows) {
    const remaining = [...windows];

    const take = minutes => {
        const index = remaining.findIndex(window => window.windowMinutes === minutes);

        return index < 0 ? null : remaining.splice(index, 1)[0];
    };

    const fiveHour = take(FIVE_HOUR_WINDOW_MINUTES);
    const weekly = take(WEEKLY_WINDOW_MINUTES);

    return {
        fiveHour: fiveHour ?? remaining.shift() ?? null,
        weekly: weekly ?? remaining.shift() ?? null
    };
}

function probeRateLimits(onDone) {
    const program = GLib.find_program_in_path('codex');

    if (program === null) {
        onDone(null);

        return null;
    }

    let subprocess;

    try {
        subprocess = Gio.Subprocess.new(
            [program, 'app-server'],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
    } catch (error) {
        log(`${UUID}: Failed to start the Codex app-server: ${error.message}`);
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
                send({ method: 'initialized', params: {} });
                send({ id: RATE_LIMITS_REQUEST_ID, method: 'account/rateLimits/read' });
            } else if (frame?.id === RATE_LIMITS_REQUEST_ID) {
                finish(frame.error === undefined ? parseRateLimits(frame.result?.rateLimits ?? null) : null);

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

    send({
        id: HANDSHAKE_REQUEST_ID,
        method: 'initialize',
        params: {
            clientInfo: { name: 'codex-usage', title: 'Codex Usage', version: '1.0.0' },
            capabilities: { experimentalApi: true }
        }
    });

    readLine();

    return {
        cancel: () => {
            if (settled) return;

            stop();
        }
    };
}

class RateLimitReader {
    constructor(settings) {
        this._settings = settings;
        this._path = GLib.build_filenamev([GLib.get_user_cache_dir(), UUID, 'limits.json']);
        this._observedAt = 0;
        this._windows = [];
        this._credits = null;
        this._retryAt = 0;
        this._backoff = 0;
        this._probe = null;

        this._load();
    }

    get observedAt() {
        return this._observedAt;
    }

    get windows() {
        return this._windows;
    }

    get credits() {
        return this._credits;
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

        this._probe = probeRateLimits(reading => {
            this._probe = null;

            this._accept(reading, interval);
            onReading();
        });
    }

    destroy() {
        this._probe?.cancel();
        this._probe = null;
    }

    _accept(reading, interval) {
        if (!reading) {
            this._backoff = Math.min(MAX_BACKOFF_SECONDS, Math.max(interval, this._backoff) * 2);
            this._retryAt = nowInSeconds() + this._backoff;

            return;
        }

        this._observedAt = nowInSeconds();
        this._windows = reading.windows;
        this._credits = reading.credits;
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
        this._windows = Array.isArray(cached.windows) ? cached.windows : [];
        this._credits = cached.credits ?? null;
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);

            GLib.file_set_contents(this._path, JSON.stringify({
                version: CACHE_VERSION,
                observed_at: this._observedAt,
                windows: this._windows,
                credits: this._credits
            }));
        } catch (error) {
            log(`${UUID}: Failed to write ${this._path}: ${error.message}`);
        }
    }
}

const CodexUsageIndicator = GObject.registerClass(
    class CodexUsageIndicator extends PanelMenu.Button {
        _init(extension, settings, limits) {
            super._init(0.5, 'Codex Usage');

            this._extension = extension;
            this._settings = settings;
            this._limits = limits;
            this._refreshTimeoutId = null;
            this._destroyed = false;

            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
                y_align: Clutter.ActorAlign.CENTER
            });

            const iconBin = new St.Bin({
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'codex-usage-icon-bin'
            });

            this._iconBin = iconBin;

            this._icon = new St.Icon({
                gicon: new Gio.FileIcon({
                    file: Gio.File.new_for_path(`${this._extension.path}/icons/codex-icon.svg`)
                }),
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER
            });

            iconBin.set_child(this._icon);

            this._label = new St.Label({
                text: 'Loading Codex usage...',
                y_align: Clutter.ActorAlign.CENTER
            });

            box.add_child(iconBin);
            box.add_child(this._label);

            this.add_child(box);

            this._fiveHourItem = this._createUsageMenuItem('5-hour usage limit');
            this._weeklyItem = this._createUsageMenuItem('Weekly usage limit');
            this._creditsItem = this._createValueMenuItem('Credits remaining');
            this._statusItem = this._createCenteredMessageItem();

            this._fiveHourItem.item.visible = false;
            this.menu.addMenuItem(this._fiveHourItem.item);

            this.menu.addMenuItem(this._weeklyItem.item);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._creditsSeparator = new PopupMenu.PopupSeparatorMenuItem();

            this.menu.addMenuItem(this._creditsItem.item);
            this.menu.addMenuItem(this._creditsSeparator);

            this.menu.addMenuItem(this._statusItem.item);

            this.menu.box.add_style_class_name('codex-usage-menu');

            this.applySettings();

            this._refreshTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                REFRESH_INTERVAL_SECONDS,
                () => this._refresh()
            );
        }

        applySettings() {
            this._iconBin.visible = this._settings.get_boolean('show-icon');

            this._creditsItem.item.visible = false;
            this._creditsSeparator.visible = false;

            const showBars = this._settings.get_boolean('show-progress-bars');

            this._fiveHourItem.barTrack.visible = showBars;
            this._weeklyItem.barTrack.visible = showBars;

            this._refresh();
        }

        destroy() {
            this._destroyed = true;

            if (this._refreshTimeoutId) {
                GLib.Source.remove(this._refreshTimeoutId);
                this._refreshTimeoutId = null;
            }

            super.destroy();
        }

        _refresh() {
            try {
                this._limits.poll(() => this._renderSafely());
            } catch (error) {
                logError(error, 'Codex usage read failed');
            }

            this._renderSafely();

            return GLib.SOURCE_CONTINUE;
        }

        _renderSafely() {
            if (this._destroyed) return;

            try {
                this._render();
            } catch (error) {
                logError(error, 'Codex usage refresh failed');
            }
        }

        _render() {
            if (!this._limits.hasReading) {
                if (this._limits.busy && this._label.text === 'Loading Codex usage...') return;

                this._label.text = 'Usage unavailable';
                this._label.visible = true;
                this._statusItem.label.text = 'Latest Codex update: unavailable';

                this._setUsageMenuItemUnavailable(this._fiveHourItem);
                this._setUsageMenuItemUnavailable(this._weeklyItem);

                this._creditsItem.valueLabel.text = '0';

                return;
            }

            const windows = assignWindows(this._limits.windows);
            const labelText = this._formatPanelLabel(windows);
            const windowsHidden = !this._settings.get_boolean('show-five-hour') && !this._settings.get_boolean('show-weekly');

            this._label.text = labelText === '' && !windowsHidden ? 'Usage unavailable' : labelText;
            this._label.visible = this._label.text !== '';

            this._statusItem.label.text = this._formatStatusLine(this._limits.observedAt);

            this._setUsageMenuItem(this._fiveHourItem, windows.fiveHour);
            this._setUsageMenuItem(this._weeklyItem, windows.weekly);

            this._creditsItem.valueLabel.text = this._formatCredits(this._limits.credits);
        }

        _createCenteredMessageItem(styleClass = 'codex-usage-status-label') {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });

            const label = new St.Label({
                text: '',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: styleClass
            });

            item.add_child(label);

            return {
                item,
                label
            };
        }

        _createUsageMenuItem(title) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });

            const layout = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'codex-usage-menu-item'
            });

            const titleLabel = new St.Label({
                text: title,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'codex-usage-section-title'
            });

            const valueLabel = new St.Label({
                text: '',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'codex-usage-section-value'
            });

            const barTrack = new St.BoxLayout({
                style_class: 'codex-usage-progress-track',
                x_expand: false,
                x_align: Clutter.ActorAlign.START
            });

            const barFill = new St.Bin({
                style_class: 'codex-usage-progress-fill'
            });

            barTrack.add_child(barFill);

            const resetLabel = new St.Label({
                text: '',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'codex-usage-section-reset'
            });

            layout.add_child(titleLabel);
            layout.add_child(valueLabel);
            layout.add_child(barTrack);
            layout.add_child(resetLabel);

            item.add_child(layout);

            return {
                item,
                title,
                titleLabel,
                valueLabel,
                barTrack,
                barFill,
                resetLabel
            };
        }

        _createValueMenuItem(title) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });

            const layout = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'codex-usage-menu-item'
            });

            const titleLabel = new St.Label({
                text: title,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'codex-usage-section-title'
            });

            const valueLabel = new St.Label({
                text: '0',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'codex-usage-section-value'
            });

            layout.add_child(titleLabel);
            layout.add_child(valueLabel);

            item.add_child(layout);

            return {
                item,
                valueLabel
            };
        }

        _setUsageMenuItem(entry, window) {
            if (!window) {
                this._setUsageMenuItemUnavailable(entry);

                return;
            }

            const remainingPercent = this._getRemainingPercent(window);
            const usedPercent = this._getUsedPercent(window);

            entry.titleLabel.text = windowTitle(window.windowMinutes, entry.title);
            entry.valueLabel.text = `${remainingPercent}% remaining`;
            entry.resetLabel.text = this._formatReset(window.resetsAt);

            const fillWidth = usedPercent === 0
                ? 0
                : Math.max(MIN_VISIBLE_FILL_WIDTH, Math.round((usedPercent / 100) * PROGRESS_BAR_WIDTH));

            entry.barFill.set_width(fillWidth);
            entry.barFill.remove_style_pseudo_class('warning');
            entry.barFill.remove_style_pseudo_class('critical');

            if (remainingPercent <= 10) {
                entry.barFill.add_style_pseudo_class('critical');
            } else if (remainingPercent <= 25) {
                entry.barFill.add_style_pseudo_class('warning');
            }
        }

        _setUsageMenuItemUnavailable(entry) {
            entry.titleLabel.text = entry.title;
            entry.valueLabel.text = 'Not reported';
            entry.resetLabel.text = 'Reset time unavailable';

            entry.barFill.set_width(0);
            entry.barFill.remove_style_pseudo_class('warning');
            entry.barFill.remove_style_pseudo_class('critical');
        }

        _formatPanelLabel(windows) {
            const fiveHour = this._settings.get_boolean('show-five-hour') ? windows.fiveHour : null;
            const weekly = this._settings.get_boolean('show-weekly') ? windows.weekly : null;

            if (fiveHour && weekly)
                return `${this._formatRemainingUsage(fiveHour)} ${PANEL_SEPARATOR} ${this._formatRemainingUsage(weekly)}`;

            if (fiveHour)
                return `${windowPrefix(fiveHour.windowMinutes, '5h')} ${this._formatRemainingUsage(fiveHour)}`;

            if (weekly)
                return `${windowPrefix(weekly.windowMinutes, 'Weekly')} ${this._formatRemainingUsage(weekly)}`;

            return '';
        }

        _formatRemainingUsage(window) {
            return !window ? '--' : `${this._getRemainingPercent(window)}%`;
        }

        _formatReset(resetSeconds) {
            const seconds = Number(resetSeconds);

            if (!Number.isFinite(seconds) || seconds <= 0) return 'Reset time unknown';

            const date = GLib.DateTime.new_from_unix_local(seconds);

            if (!date) return `Resets at ${resetSeconds}`;

            const time = date.format(this._timeFormat());

            if (this._isToday(date)) return `Resets at ${time}`;

            return `Resets ${date.format('%B %-d')} at ${time}`;
        }

        _isToday(date) {
            const now = GLib.DateTime.new_now_local();

            return date.get_year() === now.get_year() && date.get_day_of_year() === now.get_day_of_year();
        }

        _timeFormat() {
            return this._settings.get_boolean('use-24-hour-time') ? '%H:%M' : '%-I:%M %p';
        }

        _formatCredits(credits) {
            if (!credits) return '0';

            if (credits.unlimited) return 'Unlimited';

            if (credits.balance === null || credits.balance === undefined) return '0';

            return String(credits.balance);
        }

        _formatStatusLine(observedAt) {
            return `Latest Codex update: ${this._formatAbsoluteTime(observedAt)}`;
        }

        _formatAbsoluteTime(seconds) {
            if (!seconds) return 'unknown';

            const date = GLib.DateTime.new_from_unix_local(seconds);

            return date ? date.format(this._timeFormat()) : String(seconds);
        }

        _getRemainingPercent(window) {
            return clampPercent(100 - (window?.usedPercent ?? 0));
        }

        _getUsedPercent(window) {
            return clampPercent(window?.usedPercent ?? 0);
        }
    });

export default class CodexUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._limits = new RateLimitReader(this._settings);

        this._settingsSignalIds = [
            ...REBUILD_KEYS.map(
                key => this._settings.connect(`changed::${key}`, () => this._rebuild())
            ),
            ...APPEARANCE_KEYS.map(
                key => this._settings.connect(`changed::${key}`, () => this._indicator?.applySettings())
            )
        ];

        this._build();
    }

    disable() {
        for (const id of this._settingsSignalIds ?? [])
            this._settings.disconnect(id);

        this._settingsSignalIds = null;

        this._indicator?.destroy();
        this._limits?.destroy();

        this._indicator = null;
        this._limits = null;
        this._settings = null;
    }

    _build() {
        this._indicator = new CodexUsageIndicator(this, this._settings, this._limits);

        const position = this._settings.get_string('panel-position');

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            this._resolveIndex(this._settings.get_int('panel-index'), position),
            position
        );
    }

    _resolveIndex(index, position) {
        if (index >= -1) return index;

        const box = PANEL_BOXES[position] ?? PANEL_BOXES.right;
        const children = Main.panel[box]?.get_n_children() ?? 0;

        return Math.max(0, children + index + 1);
    }

    _rebuild() {
        this._indicator?.destroy();
        this._indicator = null;

        this._build();
    }
}
