import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import {UsageReader, createProviders} from './providers.js';
import {assignWindows, WEEKLY_WINDOW_MINUTES} from './usage.js';

const REFRESH_INTERVAL_SECONDS = 30;
const PROGRESS_BAR_WIDTH = 220;
const MIN_VISIBLE_FILL_WIDTH = 3;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const PANEL_BOXES = {
    left: '_leftBox',
    center: '_centerBox',
    right: '_rightBox'
};

const REBUILD_KEYS = [
    'panel-position',
    'panel-index',
    'show-provider-codex',
    'show-provider-grok',
    'show-provider-antigravity'
];

const APPEARANCE_KEYS = [
    'show-icon',
    'show-five-hour',
    'show-weekly',
    'show-credits',
    'show-progress-bars'
];

function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function windowTitle(minutes, fallback) {
    if (!Number.isFinite(minutes) || minutes <= 0) return fallback;

    if (minutes === WEEKLY_WINDOW_MINUTES) return 'Weekly usage limit';

    if (minutes % WEEKLY_WINDOW_MINUTES === 0) return `${minutes / WEEKLY_WINDOW_MINUTES}-week usage limit`;

    if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}-day usage limit`;

    if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}-hour usage limit`;

    return `${minutes}-minute usage limit`;
}

const CodexUsageIndicator = GObject.registerClass(
    class CodexUsageIndicator extends PanelMenu.Button {
        _init(extension, settings, limits) {
            super._init(0.5, `${limits.provider.name} Usage`);

            this._extension = extension;
            this._settings = settings;
            this._limits = limits;
            this._provider = limits.provider;
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
                    file: Gio.File.new_for_path(`${this._extension.path}/icons/${this._provider.icon}`)
                }),
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER
            });

            iconBin.set_child(this._icon);

            this._label = new St.Label({
                text: `Loading ${this._provider.name} usage...`,
                y_align: Clutter.ActorAlign.CENTER
            });

            box.add_child(iconBin);
            box.add_child(this._label);

            this.add_child(box);

            this._fiveHourItem = this._createUsageMenuItem('5-hour usage limit');
            this._weeklyItem = this._createUsageMenuItem('Weekly usage limit');
            this._statusItem = this._createCenteredMessageItem();

            this._fiveHourItem.item.visible = this._provider.showFiveHour === true;
            this.menu.addMenuItem(this._fiveHourItem.item);

            this.menu.addMenuItem(this._weeklyItem.item);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());


            this.menu.addMenuItem(this._statusItem.item);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._rescanItem = new PopupMenu.PopupMenuItem('Re-scan');
            this._rescanItem.connect('activate', () => {
                this._statusItem.label.text = `Scanning ${this._provider.name}...`;
                this._limits.rescan(() => this._renderSafely());
            });
            this.menu.addMenuItem(this._rescanItem);

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
                logError(error, `${this._provider.name} usage read failed`);
            }

            this._renderSafely();

            return GLib.SOURCE_CONTINUE;
        }

        _renderSafely() {
            if (this._destroyed) return;

            try {
                this._render();
            } catch (error) {
                logError(error, `${this._provider.name} usage refresh failed`);
            }
        }

        _render() {
            if (!this._limits.hasReading) {
                if (this._limits.busy && this._label.text === `Loading ${this._provider.name} usage...`) return;

                this._label.text = 'Usage unavailable';
                this._label.visible = true;
                this._statusItem.label.text = `Latest ${this._provider.name} update: unavailable`;

                this._setUsageMenuItemUnavailable(this._fiveHourItem);
                this._setUsageMenuItemUnavailable(this._weeklyItem);

                return;
            }

            const windows = assignWindows(this._limits.windows);
            const labelText = this._formatPanelLabel(windows);
            const windowsHidden = !this._settings.get_boolean('show-weekly');

            this._label.text = labelText === '' && !windowsHidden ? 'Usage unavailable' : labelText;
            this._label.visible = this._label.text !== '';

            this._statusItem.label.text = this._formatStatusLine(this._limits.observedAt);

            this._setUsageMenuItem(this._fiveHourItem, windows.fiveHour);
            this._setUsageMenuItem(this._weeklyItem, windows.weekly);

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

        _setUsageMenuItem(entry, window) {
            if (!window) {
                this._setUsageMenuItemUnavailable(entry);

                return;
            }

            const remainingPercent = this._getRemainingPercent(window);
            const usedPercent = this._getUsedPercent(window);

            entry.titleLabel.text = windowTitle(window.windowMinutes, entry.title);
            if (window.label) entry.titleLabel.text += `\nMost used: ${window.label}`;
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
            const weekly = this._settings.get_boolean('show-weekly') ? windows.weekly : null;
            return weekly ? `Weekly ${this._formatRemainingUsage(weekly)}` : '';
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
            return '%H:%M';
        }

        _formatStatusLine(observedAt) {
            return `Latest ${this._provider.name} update: ${this._formatAbsoluteTime(observedAt)}` +
                (this._limits.failed ? ' (cached; read failed)' : '');
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
        this._readers = createProviders(this.path).map(provider => new UsageReader(this._settings, provider));

        this._settingsSignalIds = [
            ...REBUILD_KEYS.map(
                key => this._settings.connect(`changed::${key}`, () => this._rebuild())
            ),
            ...APPEARANCE_KEYS.map(
                key => this._settings.connect(`changed::${key}`, () => this._indicators?.forEach(indicator => indicator.applySettings()))
            )
        ];

        this._build();
    }

    disable() {
        for (const id of this._settingsSignalIds ?? [])
            this._settings.disconnect(id);

        this._settingsSignalIds = null;

        this._indicators?.forEach(indicator => indicator.destroy());
        this._readers?.forEach(reader => reader.destroy());

        this._indicators = null;
        this._readers = null;
        this._settings = null;
    }

    _build() {
        const position = this._settings.get_string('panel-position');
        const index = this._resolveIndex(this._settings.get_int('panel-index'), position);
        this._indicators = [];

        let offset = 0;
        for (const reader of this._readers) {
            const key = `show-provider-${reader.provider.id}`;
            if (!this._settings.get_boolean(key)) continue;

            const indicator = new CodexUsageIndicator(this, this._settings, reader);
            const role = reader.provider.id === 'codex' ? this.uuid : `${this.uuid}-${reader.provider.id}`;
            Main.panel.addToStatusArea(
                role,
                indicator,
                index < 0 ? index : index + offset,
                position
            );
            this._indicators.push(indicator);
            offset++;
        }
    }

    _resolveIndex(index, position) {
        if (index >= -1) return index;

        const box = PANEL_BOXES[position] ?? PANEL_BOXES.right;
        const children = Main.panel[box]?.get_n_children() ?? 0;

        return Math.max(0, children + index + 1);
    }

    _rebuild() {
        this._indicators?.forEach(indicator => indicator.destroy());
        this._indicators = null;

        this._build();
    }
}
