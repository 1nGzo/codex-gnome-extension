// Targeted unit test suite for Grok parser edge cases:
// 1. Weekly period valid + creditUsagePercent omitted (new reset cycle at 0% usage)
//    -> used 0%, remaining 100%, resetAt preserved
// 2. creditUsagePercent present and non-zero
//    -> behavior preserved
// 3. Period structure malformed / non-Weekly
//    -> remains unavailable (windows empty / no weekly), not masked by default 0

import System from 'system';
import {parseGrok, assignWindows, WEEKLY_WINDOW_MINUTES} from '../usage.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

print('--- Grok Parser Targeted Validation ---');

// Test Case 1: Weekly period valid + creditUsagePercent missing (post-reset 0% usage)
print('[1/3] Testing Weekly period valid with omitted creditUsagePercent...');
{
    const resetEndStr = '2026-09-29T08:59:57.482496+00:00';
    const expectedResetTs = Date.parse(resetEndStr) / 1000;
    const postResetResponse = {
        config: {
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                start: '2026-09-22T08:59:57.482496+00:00',
                end: resetEndStr,
            },
            billingPeriodStart: '2026-09-22T08:59:57.482496+00:00',
            billingPeriodEnd: resetEndStr,
            isUnifiedBillingUser: true,
            onDemandCap: {val: 0},
            onDemandUsed: {val: 0},
            prepaidBalance: {val: 0},
        },
        subscription_tier: 'SuperGrok',
    };

    const reading = parseGrok(postResetResponse);
    assert(reading !== null, 'parseGrok must not return null for valid config');
    assert(Array.isArray(reading.windows) && reading.windows.length === 1,
        'parseGrok must return exactly one weekly window');

    const weekly = assignWindows(reading.windows).weekly;
    assert(weekly !== null, 'assignWindows must extract weekly window');
    assert(weekly.windowMinutes === WEEKLY_WINDOW_MINUTES, 'windowMinutes must match weekly window');
    assert(weekly.usedPercent === 0, `usedPercent must be 0, got ${weekly.usedPercent}`);
    assert(Math.round(100 - weekly.usedPercent) === 100, 'remaining percent must be 100%');
    assert(weekly.resetsAt === expectedResetTs, `resetAt must be preserved: expected ${expectedResetTs}, got ${weekly.resetsAt}`);
}
print('PASS: Valid Weekly period with omitted creditUsagePercent correctly maps to 0% used, 100% remaining, valid resetAt.');

// Test Case 2: creditUsagePercent present and non-zero
print('[2/3] Testing creditUsagePercent present and non-zero...');
{
    const resetEndStr = '2026-09-22T08:59:57.482496+00:00';
    const expectedResetTs = Date.parse(resetEndStr) / 1000;
    const activeUsageResponse = {
        config: {
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                start: '2026-09-15T08:59:57.482496+00:00',
                end: resetEndStr,
            },
            creditUsagePercent: 24,
            billingPeriodStart: '2026-09-15T08:59:57.482496+00:00',
            billingPeriodEnd: resetEndStr,
        },
        subscription_tier: 'SuperGrok',
    };

    const reading = parseGrok(activeUsageResponse);
    assert(reading !== null, 'parseGrok must not return null');
    const weekly = assignWindows(reading.windows).weekly;
    assert(weekly !== null, 'weekly window must exist');
    assert(weekly.usedPercent === 24, `usedPercent must be 24, got ${weekly.usedPercent}`);
    assert(Math.round(100 - weekly.usedPercent) === 76, 'remaining percent must be 76%');
    assert(weekly.resetsAt === expectedResetTs, `resetAt must match expected: ${expectedResetTs}`);
}
print('PASS: Non-zero creditUsagePercent preserved without regression.');

// Test Case 3: Period structure abnormal / non-Weekly -> remains unavailable
print('[3/3] Testing malformed period structures and non-Weekly periods...');
{
    // 3a. Monthly billing period (even if creditUsagePercent is omitted or 0)
    const monthlyResponse = {
        config: {
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_MONTHLY',
                start: '2026-09-01T00:00:00.000000+00:00',
                end: '2026-10-01T00:00:00.000000+00:00',
            },
        },
    };
    const monthlyReading = parseGrok(monthlyResponse);
    assert(monthlyReading !== null && monthlyReading.windows.length === 0,
        'Monthly period must not produce weekly windows');
    assert(assignWindows(monthlyReading.windows).weekly === null,
        'assignWindows must return weekly=null for monthly period');

    // 3b. Missing currentPeriod
    const missingPeriodResponse = {
        config: {
            isUnifiedBillingUser: true,
        },
    };
    const missingPeriodReading = parseGrok(missingPeriodResponse);
    assert(missingPeriodReading !== null && missingPeriodReading.windows.length === 0,
        'Missing currentPeriod must not produce weekly windows');
    assert(assignWindows(missingPeriodReading.windows).weekly === null,
        'assignWindows must return weekly=null when currentPeriod is missing');

    // 3c. Invalid / null / empty config
    assert(parseGrok(null) === null, 'parseGrok(null) must return null');
    assert(parseGrok({}) === null, 'parseGrok({}) must return null');
    assert(parseGrok({config: null}) === null, 'parseGrok({config: null}) must return null');

    // 3d. Unknown period type
    const unknownPeriodResponse = {
        config: {
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_UNKNOWN',
                end: '2026-09-29T08:59:57.482496+00:00',
            },
        },
    };
    const unknownPeriodReading = parseGrok(unknownPeriodResponse);
    assert(unknownPeriodReading !== null && unknownPeriodReading.windows.length === 0,
        'Unknown period type must return empty windows');
    assert(assignWindows(unknownPeriodReading.windows).weekly === null,
        'assignWindows must return weekly=null for unknown period');
}
print('PASS: Malformed or non-Weekly periods remain unavailable and are not masked by default 0.');

print('\nALL GROK PARSER CHECKS PASSED.');
System.exit(0);
