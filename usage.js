// Provider-independent usage model. Percentages always mean used, never remaining.
export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10080;

export function usageWindow(usedPercent, windowMinutes, resetsAt, label = null) {
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
        !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
    return {
        usedPercent,
        windowMinutes,
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
        ...(typeof label === 'string' ? {label: label.slice(0, 120)} : {}),
    };
}

export function assignWindows(windows) {
    // Unknown periods must never masquerade as a weekly or five-hour allowance.
    return {
        fiveHour: windows.find(w => w.windowMinutes === FIVE_HOUR_WINDOW_MINUTES) ?? null,
        weekly: windows.find(w => w.windowMinutes === WEEKLY_WINDOW_MINUTES) ?? null,
    };
}

export function parseCodex(result) {
    const limits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
    if (!limits || typeof limits !== 'object') return null;
    if (limits.limitId && limits.limitId !== 'codex') return null;
    const windows = ['primary', 'secondary'].map(key => {
        const w = limits[key];
        return w ? usageWindow(w.usedPercent, w.windowDurationMins, w.resetsAt) : null;
    }).filter(Boolean);
    return {windows};
}

export function parseGrok(result) {
    const config = result?.config;
    if (!config || typeof config !== 'object') return null;
    const period = config.currentPeriod;
    // Monthly billing is not weekly usage, even if it reports a percentage.
    const weekly = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
        ? usageWindow(config.creditUsagePercent ?? 0, WEEKLY_WINDOW_MINUTES,
            Date.parse(period.end) / 1000) : null;
    return {windows: weekly ? [weekly] : []};
}
