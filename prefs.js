import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { createProviders, detectProvider } from './providers.js';

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const providers = createProviders();

        const page = new Adw.PreferencesPage({
            title: 'Codex Usage',
            icon_name: 'preferences-system-symbolic'
        });

        const providersGroup = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'Choose which AI providers to show in the top bar.'
        });

        const rescanButton = new Gtk.Button({
            label: 'Re-scan',
            valign: Gtk.Align.CENTER
        });
        providersGroup.set_header_suffix(rescanButton);

        const providerRows = new Map();
        for (const provider of providers) {
            const row = new Adw.SwitchRow({
                title: provider.name,
                subtitle: 'Checking availability...'
            });

            try {
                row.add_prefix(new Gtk.Image({
                    gicon: new Gio.FileIcon({
                        file: Gio.File.new_for_path(`${this.path}/icons/${provider.icon}`)
                    }),
                    pixel_size: 24
                }));
            } catch {
                // If icon load fails, row remains functional.
            }

            settings.bind(`show-provider-${provider.id}`, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            providersGroup.add(row);
            providerRows.set(provider.id, row);
        }

        let activeProbes = [];
        const scanAll = () => {
            for (const probe of activeProbes) probe?.cancel?.();
            activeProbes = [];

            rescanButton.sensitive = false;
            let pending = providers.length;

            for (const provider of providers) {
                const row = providerRows.get(provider.id);
                if (row) row.subtitle = 'Checking availability...';

                const probe = detectProvider(provider, (available) => {
                    if (row) {
                        row.subtitle = available ? 'Available' : 'Not detected';
                    }
                    pending--;
                    if (pending <= 0) {
                        rescanButton.sensitive = true;
                    }
                });
                if (probe) activeProbes.push(probe);
            }
        };

        rescanButton.connect('clicked', () => scanAll());
        scanAll();

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'Codex and Grok stay together at the outer edge of the chosen top-bar section.'
        });

        const positionRow = new Adw.ComboRow({
            title: 'Panel box',
            subtitle: 'Left stays on the left edge. Center and right stay on the right edge.',
            model: new Gtk.StringList({ strings: ['Left', 'Center', 'Right'] })
        });

        const positions = ['left', 'center', 'right'];

        positionRow.selected = Math.max(0, positions.indexOf(settings.get_string('panel-position')));

        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positions[positionRow.selected]);
        });

        const iconRow = new Adw.SwitchRow({
            title: 'Show icon',
            subtitle: 'Display the Codex logo next to the percentages'
        });

        settings.bind('show-icon', iconRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const fiveHourRow = new Adw.SwitchRow({
            title: 'Show 5-hour window',
            subtitle: 'Kept for compatibility; the top bar shows the weekly limit'
        });

        settings.bind('show-five-hour', fiveHourRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const weeklyRow = new Adw.SwitchRow({
            title: 'Show weekly window',
            subtitle: 'The 7-day limit shown in the top bar'
        });

        settings.bind('show-weekly', weeklyRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        panelGroup.add(positionRow);
        panelGroup.add(iconRow);
        panelGroup.add(fiveHourRow);
        panelGroup.add(weeklyRow);

        const menuGroup = new Adw.PreferencesGroup({
            title: 'Menu',
            description: 'The popup shown when the indicator is clicked.'
        });

        const creditsRow = new Adw.SwitchRow({
            title: 'Show credits remaining',
            subtitle: 'Hide it if your plan does not use credits'
        });

        settings.bind('show-credits', creditsRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const barsRow = new Adw.SwitchRow({
            title: 'Show progress bars',
            subtitle: 'Draw a usage bar under each window'
        });

        settings.bind('show-progress-bars', barsRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        menuGroup.add(creditsRow);
        menuGroup.add(barsRow);

        const usageGroup = new Adw.PreferencesGroup({
            title: 'Usage',
            description: 'How often Codex itself is asked for the current limits.'
        });

        const intervalRow = new Adw.SpinRow({
            title: 'Seconds between reads',
            subtitle: 'The panel redraws every 30 seconds either way',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 30
            })
        });

        intervalRow.value = settings.get_int('limit-interval');

        intervalRow.connect('notify::value', () => {
            settings.set_int('limit-interval', Math.round(intervalRow.value));
        });

        usageGroup.add(intervalRow);

        page.add(providersGroup);
        page.add(panelGroup);
        page.add(menuGroup);
        page.add(usageGroup);

        window.add(page);
    }
}
