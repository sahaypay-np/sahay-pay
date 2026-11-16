// Sahay Pay — giver tiers, achievements and streaks (Phase 2 §5).
// Tiers (item 410, published thresholds — lifetime confirmed gifts):
//   Bronze ≥1, Silver ≥10, Gold ≥50, Bill Legend ≥150.
// Achievements (item 415): 16 unlockable badges, awarded lazily whenever
// a gift is confirmed or a profile is read (no scheduler on the free
// tier). Streaks (item 418): consecutive ISO weeks with ≥1 confirmed
// gift, with one missed-week freeze per quarter (item 421).

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { nowIso } = require('./audit');
const { createNotification } = require('./notify');

const TIERS = [
  { key: 'bronze', name: 'Bronze Helper', minGifts: 1, icon: '🥉' },
  { key: 'silver', name: 'Silver Helper', minGifts: 10, icon: '🥈' },
  { key: 'gold', name: 'Gold Helper', minGifts: 50, icon: '🥇' },
  { key: 'legend', name: 'Bill Legend', minGifts: 150, icon: '👑' },
];

function tierForCount(count) {
  let tier = null;
  let next = TIERS[0];
  for (const t of TIERS) {
    if (count >= t.minGifts) tier = t;
    else { next = t; break; }
  }
  if (tier === TIERS[TIERS.length - 1]) next = null;
  const prevMin = tier ? tier.minGifts : 0;
  const nextMin = next ? next.minGifts : null;
  const progress = nextMin === null ? 1 : Math.min(1, (count - prevMin) / Math.max(1, nextMin - prevMin));
  return {
    tier: tier ? { key: tier.key, name: tier.name, icon: tier.icon } : null,
    next: next ? { key: next.key, name: next.name, icon: next.icon, minGifts: next.minGifts } : null,
    giftsToNext: nextMin === null ? 0 : nextMin - count,
    progress,
  };
}

// Achievement definitions. `check` receives the user's computed stats and
// returns true when the badge is earned. Keys are stable (stored in the DB).
const ACHIEVEMENT_DEFS = [
  { key: 'first_gift', name: 'First Help', desc: 'Confirmed your first gift.', icon: '🌱' },
  { key: 'tenth_gift', name: 'Ten Helps', desc: 'Confirmed 10 gifts.', icon: '🌿' },
  { key: 'fifty_gifts', name: 'Fifty Helps', desc: 'Confirmed 50 gifts.', icon: '🌳' },
  { key: 'hundred_gifts', name: 'Century Helper', desc: 'Confirmed 100 gifts.', icon: '💯' },
  { key: 'first_fully_paid', name: 'Bill Closer', desc: 'Helped fully pay a bill.', icon: '🎯' },
  { key: 'five_fully_paid', name: 'Five Bills Closed', desc: 'Helped fully pay 5 bills.', icon: '🏆' },
  { key: 'cross_border', name: 'Cross-Border Helper', desc: 'Helped in both Nepal and India.', icon: '🌏' },
  { key: 'streak_4', name: '4-Week Streak', desc: 'Helped 4 weeks in a row.', icon: '🔥' },
  { key: 'streak_12', name: '12-Week Streak', desc: 'Helped 12 weeks in a row.', icon: '🔥' },
  { key: 'streak_26', name: 'Half-Year Streak', desc: 'Helped 26 weeks in a row.', icon: '🔥' },
  { key: 'streak_52', name: 'Year-Long Streak', desc: 'Helped 52 weeks in a row.', icon: '🔥' },
  { key: 'first_thanks', name: 'Thanked', desc: 'Received a public thank-you.', icon: '💛' },
  { key: 'thanked_all', name: 'Grateful Receiver', desc: 'Thanked every giver on a completed bill.', icon: '🙏' },
  { key: 'founding_helper', name: 'Founding Helper', desc: 'Joined in the first 30 days of Sahay Pay.', icon: '⭐' },
  { key: 'streak_keeper', name: 'Streak Keeper', desc: 'Kept a 12-week helping streak.', icon: '🛡️' },
  { key: 'helper_of_month', name: 'Helper of the Month', desc: 'Top giver of a calendar month.', icon: '📅' },
];

function achievementDef(key) {
  return ACHIEVEMENT_DEFS.find((d) => d.key === key) || null;
}

// ISO week key, e.g. "2026-W46".
function weekKeyOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - yearStart) / 86400000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function quarterOf(date) {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

// Monday (UTC) of the ISO week containing `date`.
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

// Consecutive weeks with ≥1 confirmed gift, walking back from the current
// week. One missed week per quarter is forgiven (the freeze, item 421).
// Returns { weeks, freezeUsed, weeksSet }.
async function computeStreak(userId) {
  const { rows } = await db.query(
    `SELECT confirmed_at FROM gifts WHERE supporter_id = $1 AND status = 'confirmed' AND confirmed_at IS NOT NULL`,
    [userId]
  );
  const weeksSet = new Set(rows.map((r) => weekKeyOf(new Date(r.confirmed_at))));
  if (!weeksSet.size) return { weeks: 0, freezeUsed: false, weeksSet };
  let weeks = 0;
  let freezeUsed = false;
  const frozenQuarters = new Set();
  let cursor = mondayOf(new Date());
  // If the current week has no gift yet, the streak counts from last week.
  if (!weeksSet.has(weekKeyOf(cursor))) cursor = new Date(cursor.getTime() - 7 * 86400000);
  for (let guard = 0; guard < 600; guard++) {
    const key = weekKeyOf(cursor);
    if (weeksSet.has(key)) {
      weeks++;
      cursor = new Date(cursor.getTime() - 7 * 86400000);
      continue;
    }
    // Missed week: freeze if this quarter still has one.
    const q = quarterOf(cursor);
    if (!frozenQuarters.has(q)) {
      frozenQuarters.add(q);
      freezeUsed = true;
      weeks++; // the frozen week still counts towards the streak
      cursor = new Date(cursor.getTime() - 7 * 86400000);
      continue;
    }
    break;
  }
  return { weeks, freezeUsed, weeksSet };
}

// All stats needed for tiers/achievements, computed from real data.
async function userGiftStats(userId) {
  const totals = await db.get(
    `SELECT COUNT(*) AS gifts,
            COUNT(DISTINCT bill_id) AS bills_helped,
            COUNT(DISTINCT CASE WHEN b.country = 'NP' THEN 1 END) AS np_bills,
            COUNT(DISTINCT CASE WHEN b.country = 'IN' THEN 1 END) AS in_bills,
            COALESCE(SUM(g.amount_minor), 0) AS total_minor
     FROM gifts g JOIN bills b ON b.id = g.bill_id
     WHERE g.supporter_id = $1 AND g.status = 'confirmed'`,
    [userId]
  );
  const fullyPaid = await db.get(
    `SELECT COUNT(DISTINCT g.bill_id) AS n FROM gifts g JOIN bills b ON b.id = g.bill_id
     WHERE g.supporter_id = $1 AND g.status = 'confirmed' AND b.status = 'completed'`,
    [userId]
  );
  const thanked = await db.get(
    `SELECT COUNT(*) AS n FROM thanks WHERE giver_id = $1 AND status = 'approved'`,
    [userId]
  );
  // Thanked-every-giver: some completed bill of theirs where every
  // confirmed gift has an approved thank-you.
  const thankedAll = await db.get(
    `SELECT COUNT(*) AS n FROM bills b
     WHERE b.user_id = $1 AND b.status = 'completed'
       AND EXISTS (SELECT 1 FROM gifts g WHERE g.bill_id = b.id AND g.status = 'confirmed')
       AND NOT EXISTS (
         SELECT 1 FROM gifts g WHERE g.bill_id = b.id AND g.status = 'confirmed'
         AND NOT EXISTS (SELECT 1 FROM thanks t WHERE t.gift_id = g.id AND t.status = 'approved')
       )`,
    [userId]
  );
  const user = await db.get('SELECT created_at FROM users WHERE id = $1', [userId]);
  const first = await db.get('SELECT MIN(created_at) AS first FROM users');
  const streak = await computeStreak(userId);
  // Most generous single ISO week (item 499): group confirmed gifts by
  // ISO week in JS (portable across Postgres/SQLite, same weekKeyOf as
  // the streak walk). Also records which week it was.
  const weekRows = await db.query(
    `SELECT amount_minor, confirmed_at FROM gifts
     WHERE supporter_id = $1 AND status = 'confirmed' AND confirmed_at IS NOT NULL`,
    [userId]
  );
  const weekTotals = new Map();
  for (const g of weekRows.rows) {
    const wk = weekKeyOf(new Date(g.confirmed_at));
    weekTotals.set(wk, (weekTotals.get(wk) || 0) + Number(g.amount_minor || 0));
  }
  let bestWeekMinor = 0;
  let bestWeekKey = null;
  for (const [wk, total] of weekTotals) {
    if (total > bestWeekMinor) { bestWeekMinor = total; bestWeekKey = wk; }
  }
  return {
    gifts: Number(totals?.gifts || 0),
    billsHelped: Number(totals?.bills_helped || 0),
    totalMinor: Number(totals?.total_minor || 0),
    crossBorder: Number(totals?.np_bills || 0) > 0 && Number(totals?.in_bills || 0) > 0,
    fullyPaid: Number(fullyPaid?.n || 0),
    thankedCount: Number(thanked?.n || 0),
    thankedAll: Number(thankedAll?.n || 0) > 0,
    streakWeeks: streak.weeks,
    freezeUsed: streak.freezeUsed,
    founding:
      user && first && first.first
        ? new Date(user.created_at).getTime() - new Date(first.first).getTime() <= 30 * 86400000
        : false,
    bestWeekMinor,
    bestWeek: bestWeekKey,
  };
}

function earnedKeys(stats) {
  const keys = [];
  if (stats.gifts >= 1) keys.push('first_gift');
  if (stats.gifts >= 10) keys.push('tenth_gift');
  if (stats.gifts >= 50) keys.push('fifty_gifts');
  if (stats.gifts >= 100) keys.push('hundred_gifts');
  if (stats.fullyPaid >= 1) keys.push('first_fully_paid');
  if (stats.fullyPaid >= 5) keys.push('five_fully_paid');
  if (stats.crossBorder) keys.push('cross_border');
  if (stats.streakWeeks >= 4) keys.push('streak_4');
  if (stats.streakWeeks >= 12) keys.push('streak_12', 'streak_keeper');
  if (stats.streakWeeks >= 26) keys.push('streak_26');
  if (stats.streakWeeks >= 52) keys.push('streak_52');
  if (stats.thankedCount >= 1) keys.push('first_thanks');
  if (stats.thankedAll) keys.push('thanked_all');
  if (stats.founding) keys.push('founding_helper');
  return keys;
}

// Award any newly-earned achievements + tier level-ups. Called after a
// gift is confirmed and on profile reads. Returns the newly awarded keys.
async function awardAchievements(userId) {
  const stats = await userGiftStats(userId);
  const earned = earnedKeys(stats);
  const existing = await db.query('SELECT key FROM achievements WHERE user_id = $1', [userId]);
  const have = new Set(existing.rows.map((r) => r.key));
  const fresh = [];
  for (const key of earned) {
    if (have.has(key)) continue;
    const def = achievementDef(key);
    if (!def) continue;
    try {
      await db.run(
        `INSERT INTO achievements (id, user_id, key, awarded_at) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), userId, key, nowIso()]
      );
      fresh.push(key);
      await createNotification(
        userId, 'achievement', `Badge earned: ${def.name}`,
        def.desc, '#/profile/' + (await db.get('SELECT username FROM users WHERE id = $1', [userId]))?.username
      ).catch(() => {});
    } catch { /* already awarded concurrently */ }
  }
  // Tier level-up notification (item 414): compare the tier before this
  // call's gifts with the tier now — tracked via a stored marker in prefs.
  try {
    const row = await db.get('SELECT prefs_json FROM users WHERE id = $1', [userId]);
    let prefs = {};
    try { prefs = JSON.parse(row?.prefs_json || '{}'); } catch { prefs = {}; }
    const currentTier = tierForCount(stats.gifts).tier?.key || null;
    if (currentTier && prefs.lastTierNotified !== currentTier) {
      prefs.lastTierNotified = currentTier;
      await db.run('UPDATE users SET prefs_json = $1 WHERE id = $2', [JSON.stringify(prefs), userId]);
      const def = TIERS.find((t) => t.key === currentTier);
      if (def) {
        await createNotification(
          userId, 'tier_up', `You reached ${def.name}`,
          `Your confirmed gifts earned you the ${def.name} tier. Keep helping.`, '#/leaders'
        );
      }
    }
  } catch { /* notifications are best-effort */ }
  return fresh;
}

// Helper of the month (item 500): the previous calendar month's top giver
// (most confirmed gifts, then highest total). Computed on read — no
// scheduler. Awards the badge + notification when first observed.
async function maybeAwardHelperOfMonth(userId) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const top = await db.get(
    `SELECT supporter_id, COUNT(*) AS gifts, SUM(amount_minor) AS total
     FROM gifts WHERE status = 'confirmed' AND confirmed_at >= $1 AND confirmed_at < $2
     GROUP BY supporter_id ORDER BY gifts DESC, total DESC LIMIT 1`,
    [start.toISOString(), end.toISOString()]
  );
  if (!top || top.supporter_id !== userId) return false;
  const have = await db.get(
    `SELECT id FROM achievements WHERE user_id = $1 AND key = 'helper_of_month'`,
    [userId]
  );
  if (have) return false;
  await db.run(
    `INSERT INTO achievements (id, user_id, key, awarded_at) VALUES ($1, $2, 'helper_of_month', $3)`,
    [crypto.randomUUID(), userId, nowIso()]
  );
  await createNotification(
    userId, 'achievement', 'Badge earned: Helper of the Month',
    'You were the top giver last month.', '#/leaders'
  ).catch(() => {});
  return true;
}

async function listAchievements(userId) {
  const { rows } = await db.query(
    'SELECT key, awarded_at FROM achievements WHERE user_id = $1 ORDER BY awarded_at ASC',
    [userId]
  );
  return rows.map((r) => {
    const def = achievementDef(r.key);
    return { key: r.key, name: def?.name || r.key, desc: def?.desc || '', icon: def?.icon || '🏅', awardedAt: r.awarded_at };
  });
}

module.exports = {
  TIERS,
  tierForCount,
  ACHIEVEMENT_DEFS,
  achievementDef,
  weekKeyOf,
  computeStreak,
  userGiftStats,
  awardAchievements,
  maybeAwardHelperOfMonth,
  listAchievements,
};
