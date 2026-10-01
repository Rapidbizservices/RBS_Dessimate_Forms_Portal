// Grandfather-father-son retention: keep the newest `daily` backups, plus the
// newest backup of each of the last `weekly` ISO weeks and `monthly` calendar
// months. "Daily" counts backups, not calendar days, so a missed night never
// shrinks the window. Dates are 'YYYY-MM-DD' (UTC).

export const DEFAULT_RETENTION = { daily: 14, weekly: 8, monthly: 12 };

export function isoWeek(date) {
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday decides the ISO year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

export function selectRetained(dates, policy = DEFAULT_RETENTION) {
  const newestFirst = [...new Set(dates)].sort().reverse();
  const keep = new Set(newestFirst.slice(0, policy.daily));
  const newestPerBucket = (bucketOf, limit) => {
    const seen = new Set();
    for (const d of newestFirst) {
      const bucket = bucketOf(d);
      if (seen.has(bucket)) continue;
      if (seen.size === limit) break;
      seen.add(bucket);
      keep.add(d);
    }
  };
  newestPerBucket(isoWeek, policy.weekly);
  newestPerBucket(d => d.slice(0, 7), policy.monthly);
  return keep;
}

// Pulls the date out of our own dated filenames; anything else in the folder
// returns null and is never touched by pruning.
export function dateFromName(name, prefix, ext) {
  const m = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d{4}-\\d{2}-\\d{2})' + ext.replace('.', '\\.') + '$').exec(name);
  return m ? m[1] : null;
}
