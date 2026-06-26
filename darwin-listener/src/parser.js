// ============================================================
// src/parser.js
// Parses Darwin Push Port v18 JSON messages.
// Darwin uses TIPLOC codes and working times (wta/wtd/wtp).
// ============================================================

import { isTiplocMonitored } from './crossings.js';

// ============================================================
// Main parse function
// Takes the bytes string from a Kafka message and returns
// relevant train location records for monitored TIPLOCs.
// ============================================================

export function parseMessage(bytesField) {
  const results = [];

  try {
    // Parse the bytes field — it arrives as a JSON string
    let parsed;
    if (typeof bytesField === 'string') {
      parsed = JSON.parse(bytesField);
    } else {
      parsed = bytesField;
    }

    // Darwin Push Port v18 structure:
    // { ts: timestamp, version: "18.0", uR: { updateOrigin: "...", TS: {...} } }
    const uR = parsed?.uR;
    if (!uR) return results;

    // ---- Forecast/TS updates (real-time predictions) ----
    if (uR.TS) {
      const updates = Array.isArray(uR.TS) ? uR.TS : [uR.TS];
      for (const ts of updates) {
        const extracted = extractFromTS(ts, parsed.ts);
        results.push(...extracted);
      }
    }

    // ---- Schedule records ----
    if (uR.schedule) {
      const schedules = Array.isArray(uR.schedule) ? uR.schedule : [uR.schedule];
      for (const schedule of schedules) {
        const extracted = extractFromSchedule(schedule);
        results.push(...extracted);
      }
    }

    // ---- Deactivated trains ----
    if (uR.deactivated) {
      const deactivated = Array.isArray(uR.deactivated) ? uR.deactivated : [uR.deactivated];
      for (const d of deactivated) {
        if (d.rid) {
          results.push({ type: 'deactivated', trainId: d.rid });
        }
      }
    }

  } catch (err) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.warn('[parser] Failed to parse message:', err.message);
    }
  }

  return results;
}

// ============================================================
// Extract from TS (Train Status) update messages
// These contain real-time Darwin predictions
// Darwin sends working times: wta, wtd, wtp
// and estimated times: arr.et, dep.et, pass.et
// ============================================================

function extractFromTS(ts, messageTimestamp) {
  const results = [];
  if (!ts) return results;

  const trainId = ts.rid;
  const operator = ts.toc;

  if (!trainId) return results;

  // Location can be a single object or an array
  const locations = ts.Location;
  if (!locations) return results;
  const locArray = Array.isArray(locations) ? locations : [locations];

  for (const loc of locArray) {
    const tiploc = loc.tpl;
    if (!tiploc) continue;

    // Check if this TIPLOC is one we're monitoring
    if (!isTiplocMonitored(tiploc)) continue;

    console.log(`[parser] Found monitored TIPLOC: ${tiploc} for train ${trainId}`);

    // Extract times — Darwin uses these fields:
    // wta/wtd/wtp = working timetable times (scheduled)
    // arr.et / dep.et / pass.et = estimated times (predicted)
    // arr.at / dep.at / pass.at = actual times (confirmed)

    const arr  = loc.arr  || {};
    const dep  = loc.dep  || {};
    const pass = loc.pass || {};

    // Scheduled times (working timetable)
    const wta  = loc.wta  || null;
    const wtd  = loc.wtd  || null;
    const wtp  = loc.wtp  || null;

    // Predicted times
    const eta  = arr.et   || null;
    const etd  = dep.et   || null;
    const etp  = pass.et  || null;

    // Actual times
    const ata  = arr.at   || null;
    const atd  = dep.at   || null;
    const atp  = pass.at  || null;

    // Determine best predicted time (actual > estimated > scheduled)
    // Priority: pass > departure > arrival (for crossing purposes)
    const scheduledTime =
      (wtp ? toISO(wtp) : null) ||
      (wtd ? toISO(wtd) : null) ||
      (wta ? toISO(wta) : null);

    const predictedTime =
      (atp ? toISO(atp) : null) ||
      (etp ? toISO(etp) : null) ||
      (atd ? toISO(atd) : null) ||
      (etd ? toISO(etd) : null) ||
      (ata ? toISO(ata) : null) ||
      (eta ? toISO(eta) : null) ||
      scheduledTime;

    // Determine time basis
    let timeBasis = 'scheduled';
    if (atp || atd || ata) timeBasis = 'actual';
    else if (etp || etd || eta) timeBasis = 'predicted';

    if (!scheduledTime && !predictedTime) continue;

    results.push({
      type: 'forecast',
      trainId,
      operator,
      tiploc,
      scheduledTime,
      predictedTime,
      timeBasis,
      lastUpdated: messageTimestamp || new Date().toISOString()
    });
  }

  return results;
}

// ============================================================
// Extract from schedule records
// These contain the full planned timetable for a train
// ============================================================

function extractFromSchedule(schedule) {
  const results = [];
  if (!schedule) return results;

  const trainId = schedule.rid;
  const operator = schedule.toc;
  if (!trainId) return results;

  // Schedule locations use OR (origin), IP (intermediate), DT (destination), PP (pass)
  const locationTypes = ['OR', 'IP', 'DT', 'PP', 'OPOR', 'OPIP', 'OPDT'];

  for (const locType of locationTypes) {
    if (!schedule[locType]) continue;
    const locations = Array.isArray(schedule[locType]) ? schedule[locType] : [schedule[locType]];

    for (const loc of locations) {
      const tiploc = loc.tpl;
      if (!tiploc || !isTiplocMonitored(tiploc)) continue;

      console.log(`[parser] Schedule: found monitored TIPLOC ${tiploc} for train ${trainId}`);

      // Working timetable times
      const wta = loc.wta || null;
      const wtd = loc.wtd || null;
      const wtp = loc.wtp || null;

      const scheduledTime =
        (wtp ? toISO(wtp) : null) ||
        (wtd ? toISO(wtd) : null) ||
        (wta ? toISO(wta) : null);

      if (!scheduledTime) continue;

      results.push({
        type: 'schedule',
        trainId,
        operator,
        tiploc,
        scheduledTime,
        predictedTime: scheduledTime,
        timeBasis: 'scheduled'
      });
    }
  }

  return results;
}

// ============================================================
// Helper: convert HH:MM time string to full ISO timestamp
// Darwin sends working times as HH:MM relative to today
// ============================================================

function toISO(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return timeStr; // Already ISO

  const now = new Date();
  const [hours, minutes] = timeStr.split(':').map(Number);

  const result = new Date(now);
  result.setHours(hours, minutes, 0, 0);

  // If the time is more than 6 hours in the past, assume it's tomorrow
  if (result < new Date(now.getTime() - 6 * 60 * 60 * 1000)) {
    result.setDate(result.getDate() + 1);
  }

  return result.toISOString();
}
