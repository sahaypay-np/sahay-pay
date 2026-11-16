// Sahay Pay — maintenance-mode kill switch (checklist item 194).
// Flag lives in the settings table (maintenance_mode '1'/'0' + optional
// maintenance_message). The read is cached for 15s per process so the gate
// doesn't add a DB round trip to every API request; setMaintenanceMode()
// invalidates the cache, so the toggle takes effect immediately on the
// instance that served it and within 15s on other warm instances.
'use strict';

const db = require('../db');
const { logAudit } = require('./audit');

const CACHE_TTL_MS = 15 * 1000;
let cache = { value: false, message: '', at: 0 };

function invalidateCache() {
  cache.at = 0;
}

async function isMaintenanceMode() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache;
  let enabled = false;
  let message = '';
  try {
    const mode = await db.getSetting('maintenance_mode');
    enabled = mode === '1';
    if (enabled) {
      message =
        (await db.getSetting('maintenance_message')) ||
        'Sahay Pay is briefly down for maintenance. Please try again soon.';
    }
  } catch {
    // A settings read error must not take the site down — fail open.
    enabled = false;
  }
  cache = { value: enabled, message, at: Date.now() };
  return cache;
}

async function getMaintenanceState() {
  const { value, message } = await isMaintenanceMode();
  return { enabled: value, message };
}

async function setMaintenanceMode(enabled, message) {
  await db.setSetting('maintenance_mode', enabled ? '1' : '0');
  if (typeof message === 'string' && message.trim()) {
    await db.setSetting('maintenance_message', message.trim().slice(0, 500));
  }
  invalidateCache();
  await logAudit('admin', 'owner', enabled ? 'maintenance_on' : 'maintenance_off', 'settings', 'maintenance_mode', {});
  return getMaintenanceState();
}

// Express middleware: when maintenance is on, every /api request except
// /api/health and /api/admin/* gets a 503 JSON (the admin console must stay
// reachable so the owner can switch maintenance back off).
async function maintenanceGate(req, res, next) {
  try {
    if (!req.path.startsWith('/api')) return next();
    if (req.path === '/api/health') return next();
    if (req.path.startsWith('/api/admin')) return next();
    const { value, message } = await isMaintenanceMode();
    if (value) {
      return res.status(503).json({ error: { code: 'MAINTENANCE', message } });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ---- Emergency freeze (Phase 2 item 883) ----
// One-click admin action: hides all bills from the feed and blocks new
// gifts, while leaving the rest of the app (settings, help, admin) up.
// Same settings-table + 15s-cache pattern as maintenance mode.
let freezeCache = { value: false, message: '', at: 0 };

async function isEmergencyFreeze() {
  if (Date.now() - freezeCache.at < CACHE_TTL_MS) return freezeCache;
  let enabled = false;
  let message = '';
  try {
    const mode = await db.getSetting('emergency_freeze');
    enabled = mode === '1';
    if (enabled) {
      message =
        (await db.getSetting('emergency_freeze_message')) ||
        'Helping is paused for a moment while the owner checks something. Please try again soon.';
    }
  } catch {
    enabled = false;
  }
  freezeCache = { value: enabled, message, at: Date.now() };
  return freezeCache;
}

async function getFreezeState() {
  const { value, message } = await isEmergencyFreeze();
  return { enabled: value, message };
}

async function setEmergencyFreeze(enabled, message) {
  await db.setSetting('emergency_freeze', enabled ? '1' : '0');
  if (typeof message === 'string' && message.trim()) {
    await db.setSetting('emergency_freeze_message', message.trim().slice(0, 500));
  }
  freezeCache.at = 0;
  await logAudit('admin', 'owner', enabled ? 'emergency_freeze_on' : 'emergency_freeze_off', 'settings', 'emergency_freeze', {});
  return getFreezeState();
}

// Middleware: while frozen, the feed and gift creation 503 (admin exempt).
async function freezeGate(req, res, next) {
  try {
    if (!req.path.startsWith('/api')) return next();
    if (req.path.startsWith('/api/admin')) return next();
    const isFeed = req.path === '/api/feed' && req.method === 'GET';
    const isGiftCreate = req.path === '/api/gifts' && req.method === 'POST';
    if (!isFeed && !isGiftCreate) return next();
    const { value, message } = await isEmergencyFreeze();
    if (value) {
      return res.status(503).json({ error: { code: 'EMERGENCY_FREEZE', message } });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  isMaintenanceMode, getMaintenanceState, setMaintenanceMode, maintenanceGate, invalidateCache,
  isEmergencyFreeze, getFreezeState, setEmergencyFreeze, freezeGate,
};
