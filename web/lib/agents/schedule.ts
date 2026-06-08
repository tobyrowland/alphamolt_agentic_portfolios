/**
 * Heartbeat-schedule helpers — client-safe, no server imports.
 *
 * The rebalance automation runs on a fixed weekly cron: Sunday 07:00 UTC
 * (.github/workflows/agent-heartbeat.yml: "0 7 * * 0"). Each agent acts on that
 * tick once its own cadence (heartbeat_interval_hours) has elapsed, so the next
 * run is deterministic — the next Sunday-07:00-UTC at/after the agent's due
 * time. Keep this the single source of the cron constant; if the workflow
 * schedule changes, change it here.
 */

export const HEARTBEAT_UTC_DAY = 0; // Sunday
export const HEARTBEAT_UTC_HOUR = 7; // 07:00 UTC

/** Coarse relative duration: "just now" / "5m" / "3h" / "5d". */
export function relShort(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/** Local-time label for an instant, e.g. "Sun, Jun 15, 08:00". */
export function dateTimeLabel(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact local label for tight spots, e.g. "Sun 08:00". */
export function shortRunLabel(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The smallest Sunday-07:00-UTC instant at or after `after`. */
export function nextHeartbeatTick(after: number): number {
  const d = new Date(after);
  let cand = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    HEARTBEAT_UTC_HOUR,
    0,
    0,
    0,
  );
  for (let i = 0; i < 8; i++) {
    if (new Date(cand).getUTCDay() === HEARTBEAT_UTC_DAY && cand >= after) {
      return cand;
    }
    cand += 86_400_000;
  }
  return cand;
}

/**
 * The schedule line for an agent: its next weekly run (Sunday 07:00 UTC, in the
 * viewer's local time) at/after its due time — `last run + cadence`, or now for
 * an agent that hasn't run yet.
 */
export function scheduleText(
  lastRunAt: string | null,
  intervalHours: number | null,
  now: number,
): string {
  const intervalH = intervalHours ?? 168;
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const hasRun = !Number.isNaN(last);
  const due = hasRun ? last + intervalH * 3_600_000 : now;
  const next = nextHeartbeatTick(Math.max(now, due));
  const nextLabel = `${dateTimeLabel(next)} (in ${relShort(next - now)})`;
  return hasRun
    ? `Last run ${relShort(now - last)} ago · next run ${nextLabel}`
    : `Next run ${nextLabel}`;
}
