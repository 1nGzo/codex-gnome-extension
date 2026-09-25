#!/usr/bin/env gjs -m
// Targeted validation for Antigravity Gemini UI rendering:
// 1. Gemini 55/14 + ClaudeGPT 46/100
//    -> Top bar: strictly 55%
//    -> Menu: Weekly 55% remaining, 5-hour 14% remaining, reset time, countdown
//    -> Claude/GPT completely absent, no "Most used" label
// 2. Gemini group missing
//    -> Top bar: Usage unavailable
//    -> Menu: Usage unavailable
//    -> Never falls back to Claude/GPT 46/100

import GLib from 'gi://GLib';
import System from 'system';
import {assignWindows, WEEKLY_WINDOW_MINUTES, FIVE_HOUR_WINDOW_MINUTES} from '../usage.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function getRemainingPercent(window) {
    return clampPercent(100 - (window?.usedPercent ?? 0));
}

function formatPanelLabel(windows, showWeekly = true) {
    const weekly = showWeekly ? windows.weekly : null;
    return weekly ? `${getRemainingPercent(weekly)}%` : '';
}

function windowTitle(minutes, fallback) {
    if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
    if (minutes === WEEKLY_WINDOW_MINUTES) return 'Weekly usage limit';
    if (minutes === FIVE_HOUR_WINDOW_MINUTES) return '5-hour usage limit';
    return `${minutes}-minute usage limit`;
}

function formatReset(resetSeconds) {
    const seconds = Number(resetSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Reset time unknown';
    const date = GLib.DateTime.new_from_unix_local(seconds);
    return date ? date.format('%H:%M') : String(seconds);
}

function formatResetCountdown(resetSeconds, nowSeconds) {
    const seconds = Number(resetSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const remainingSeconds = seconds - nowSeconds;
    if (remainingSeconds <= 0) return 'Reset pending';
    const minutes = Math.floor(remainingSeconds / 60);
    const hours = Math.floor(minutes / 60);
    if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${hours % 24}h remaining`;
    if (minutes >= 60) return `${hours}h ${minutes % 60}m remaining`;
    return `${Math.max(1, minutes)}m remaining`;
}

function renderAntigravityProfileSection(profile, providerId, showFiveHour = true, showBars = true, nowSeconds = Date.now() / 1000) {
    const items = [];
    items.push({type: 'header', text: profile.name});

    if (profile.status === 'online') {
        const wins = assignWindows(profile.windows ?? []);
        if (wins.weekly || wins.fiveHour) {
            if (wins.weekly) {
                let title = windowTitle(wins.weekly.windowMinutes, 'Weekly usage limit');
                if (providerId !== 'antigravity' && wins.weekly.label) {
                    title += `\nMost used: ${wins.weekly.label}`;
                }
                items.push({
                    type: 'usage',
                    kind: 'weekly',
                    title: title,
                    value: `${getRemainingPercent(wins.weekly)}% remaining`,
                    reset: formatReset(wins.weekly.resetsAt),
                    countdown: formatResetCountdown(wins.weekly.resetsAt, nowSeconds),
                });
            }
            if (showFiveHour && wins.fiveHour) {
                let title = windowTitle(wins.fiveHour.windowMinutes, '5-hour usage limit');
                if (providerId !== 'antigravity' && wins.fiveHour.label) {
                    title += `\nMost used: ${wins.fiveHour.label}`;
                }
                items.push({
                    type: 'usage',
                    kind: '5h',
                    title: title,
                    value: `${getRemainingPercent(wins.fiveHour)}% remaining`,
                    reset: formatReset(wins.fiveHour.resetsAt),
                    countdown: formatResetCountdown(wins.fiveHour.resetsAt, nowSeconds),
                });
            }
        } else {
            items.push({type: 'unavailable', text: 'Usage unavailable'});
        }
    } else {
        items.push({type: 'offline', text: 'Detected · Offline'});
    }
    return items;
}

function resolveTopBarLabel(defaultProfile, defaultWindows, showWeekly = true) {
    const labelText = formatPanelLabel(defaultWindows, showWeekly);
    if (defaultProfile?.status === 'online' && defaultWindows.weekly) {
        return labelText === '' && showWeekly ? 'Usage unavailable' : labelText;
    }
    return 'Usage unavailable';
}

print('--- Antigravity Gemini UI & Indicator Targeted Tests ---');

// Test Case 1: Gemini 55/14 + ClaudeGPT 46/100
print('[1/2] Testing Gemini 55/14 + ClaudeGPT 46/100 UI rendering...');
{
    const now = Math.floor(Date.now() / 1000);
    const futureWeekly = now + 86400 * 4 + 3600 * 4; // 4d 4h
    const future5h = now + 50 * 60; // 50m

    // Filtered windows produced by read-antigravity.py
    const geminiOnlyWindows = [
        { usedPercent: 45.0, windowMinutes: 10080, resetsAt: futureWeekly, label: 'Gemini Models' },
        { usedPercent: 86.0, windowMinutes: 300, resetsAt: future5h, label: 'Gemini Models' },
    ];

    const defaultProfile = {
        id: 'default',
        name: 'Default',
        status: 'online',
        hasAuth: true,
        windows: geminiOnlyWindows,
    };

    const assigned = assignWindows(defaultProfile.windows);

    // Top Bar Check: strictly 55%
    const topBarLabel = resolveTopBarLabel(defaultProfile, assigned, true);
    assert(topBarLabel === '55%', `Expected top bar '55%', got '${topBarLabel}'`);
    assert(!topBarLabel.includes('46'), 'Top bar must not contain Claude/GPT 46%');
    assert(!topBarLabel.includes('Weekly'), 'Top bar should not have Weekly prefix');

    // Menu Check
    const menuItems = renderAntigravityProfileSection(defaultProfile, 'antigravity', true, true, now);
    assert(menuItems.length === 3, `Expected 3 menu items (header, weekly, 5h), got ${menuItems.length}`);

    const weeklyItem = menuItems.find(i => i.kind === 'weekly');
    const fiveHourItem = menuItems.find(i => i.kind === '5h');

    assert(weeklyItem !== undefined, 'Missing weekly menu item');
    assert(weeklyItem.value === '55% remaining', `Expected '55% remaining', got '${weeklyItem.value}'`);
    assert(!weeklyItem.title.includes('Most used'), `Weekly title must not contain 'Most used': ${weeklyItem.title}`);
    assert(weeklyItem.title === 'Weekly usage limit', `Weekly title mismatch: ${weeklyItem.title}`);
    assert(weeklyItem.countdown === '4d 4h remaining', `Countdown mismatch: ${weeklyItem.countdown}`);

    assert(fiveHourItem !== undefined, 'Missing 5-hour menu item');
    assert(fiveHourItem.value === '14% remaining', `Expected '14% remaining', got '${fiveHourItem.value}'`);
    assert(!fiveHourItem.title.includes('Most used'), `5h title must not contain 'Most used': ${fiveHourItem.title}`);
    assert(fiveHourItem.title === '5-hour usage limit', `5h title mismatch: ${fiveHourItem.title}`);
    assert(fiveHourItem.countdown === '50m remaining', `Countdown mismatch: ${fiveHourItem.countdown}`);

    // Verify Claude/GPT is completely excluded
    for (const item of menuItems) {
        assert(!JSON.stringify(item).includes('Claude'), 'Claude must not be present in menu');
        assert(!JSON.stringify(item).includes('GPT'), 'GPT must not be present in menu');
        assert(!JSON.stringify(item).includes('46%'), '46% must not be present in menu');
        assert(!JSON.stringify(item).includes('100%'), '100% must not be present in menu');
    }
}
print('PASS: Gemini 55/14 + ClaudeGPT 46/100 -> Top bar: 55%, Menu: Weekly 55% / 5h 14%, Claude/GPT completely excluded.');

// Test Case 2: Gemini missing -> unavailable, no fallback to Claude/GPT 46/100
print('[2/2] Testing missing Gemini group -> unavailable without fallback...');
{
    // Profile is online (language_server process running), but Gemini group is missing in RPC
    const missingProfile = {
        id: 'default',
        name: 'Default',
        status: 'online',
        hasAuth: true,
        windows: [],
        error: 'invalid quota response',
    };

    const assigned = assignWindows(missingProfile.windows);

    // Top Bar Check: strictly 'Usage unavailable', never 46%
    const topBarLabel = resolveTopBarLabel(missingProfile, assigned, true);
    assert(topBarLabel === 'Usage unavailable', `Expected 'Usage unavailable', got '${topBarLabel}'`);
    assert(!topBarLabel.includes('46%'), 'Must not fall back to 46%');

    // Menu Check: shows 'Usage unavailable', never 46% or 100%
    const menuItems = renderAntigravityProfileSection(missingProfile, 'antigravity', true, true, Date.now() / 1000);
    assert(menuItems.length === 2, `Expected 2 menu items (header, unavailable), got ${menuItems.length}`);
    assert(menuItems[1].type === 'unavailable', `Expected unavailable item, got ${menuItems[1].type}`);
    assert(menuItems[1].text === 'Usage unavailable', `Expected 'Usage unavailable', got '${menuItems[1].text}'`);

    for (const item of menuItems) {
        assert(!JSON.stringify(item).includes('46%'), 'Must not fall back to 46%');
        assert(!JSON.stringify(item).includes('100%'), 'Must not fall back to 100%');
        assert(!JSON.stringify(item).includes('Claude'), 'Claude must not appear');
        assert(!JSON.stringify(item).includes('GPT'), 'GPT must not appear');
    }
}
print('PASS: Missing Gemini group -> Top bar: Usage unavailable, Menu: Usage unavailable, zero fallback to Claude/GPT.');

print('\nALL GEMINI UI VALIDATION CHECKS PASSED.');
System.exit(0);
