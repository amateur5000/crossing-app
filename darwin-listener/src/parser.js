// ============================================================
// src/parser.js
// Parses Darwin Push Port v18 JSON messages.
// Extracts separate scheduled and predicted times for
// arrival, departure and pass events.
// ============================================================

import { isTiplocMonitored } from './crossings.js';

// ============================================================
// Main parse function
// ============================================================

export function parseMessage(bytesField) {
  const results = [];

  try {
    let parsed;
    if (typeof bytesField === 'string') {
      parsed = JSON.parse(bytesField);
    } else {
      parsed = bytesField;
    }

    const uR = parsed?.uR;
    if (!uR) return results;

    // ---- Forecast/TS updates (real-time predictions) ----
    if (uR.TS) {
      const updates = Array.isArray(uR.TS) ? uR.TS : [uR.TS];
      for (const ts of updates) {
        results.push(...extractFromTS(ts, parsed.ts));
      }
    }

    // ---- Schedule records ----
    if (uR.schedule) {
      const schedules = Array.isArray(uR.schedule) ? uR.schedule : [uR.schedule];
      for (const schedule of schedules) {
        results.push(...extractFromSchedule(schedule));
      }
    }

    // ---- Deactivated trains ----
    if (uR.deactivated) {
      const deactivated = Array.isArray(uR.deactivated) ? uR.deactivated : [uR.deactivated];
      for (const d of deactivated) {
        if (d.rid) results.push({ type: 'deactivated', trainId: d.rid });
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
// Extract from TS (Train Status) forecast update messages
// These contain Darwin's real-time predictions and actuals
// ============================================================

function extractFromTS(ts, messageTimestamp) {
  const results = [];
  if (!ts) return results;

  const trainId  = ts.rid;
  const operator = ts.toc;
  if (!trainId) return results;

  const locations = ts.Location;
  if (!locations) return results;
  const locArray = Array.isArray(locations) ? locations : [locations];

  const direction = inferDirection(locArray);

  for (const loc of locArray) {
    const tiploc = loc.tpl;
    if (!tiploc || !isTiplocMonitored(tiploc)) continue;

    console.log(`[parser] Found monitored TIPLOC: ${tiploc} for train ${trainId}`);

    const arr  = loc.arr  || {};
    const dep  = loc.dep  || {};
    const pass = loc.pass || {};

    // ---- Scheduled times (working timetable) ----
    const scheduledArrival   = loc.wta ? toISO(loc.wta) : null;
    const scheduledDeparture = loc.wtd ? toISO(loc.wtd) : null;
    const scheduledPass      = loc.wtp ? toISO(loc.wtp) : null;

    // ---- Predicted/actual times from Darwin ----
    // Actual (at) takes priority over estimated (et)
    const predictedArrival   = toISO(arr.at  || arr.et)  || scheduledArrival;
    const predictedDeparture = toISO(dep.at  || dep.et)  || scheduledDeparture;
    const predictedPass      = toISO(pass.at || pass.et) || scheduledPass;

    // ---- Is this train stopping here? ----
    // Stopping = has arrival AND departure (not just a pass)
    const isStopping = !!(scheduledArrival || predictedArrival) &&
                       !!(scheduledDeparture || predictedDeparture) &&
                       !(scheduledPass || predictedPass);

    // ---- Time basis ----
    let timeBasis = 'scheduled';
    if (pass.at || dep.at || arr.at) timeBasis = 'actual';
    else if (pass.et || dep.et || arr.et) timeBasis = 'predicted';

    // Must have at least one time to be useful
    if (!scheduledArrival && !scheduledDeparture && !scheduledPass &&
        !predictedArrival && !predictedDeparture && !predictedPass) continue;

    results.push({
      type: 'forecast',
      trainId,
      operator,
      tiploc,
      scheduledArrival,
      predictedArrival,
      scheduledDeparture,
      predictedDeparture,
      scheduledPass,
      predictedPass,
      isStopping,
      direction,
      timeBasis,
      lastUpdated: messageTimestamp || new Date().toISOString()
    });
  }

  return results;
}

// ============================================================
// Extract from schedule records (timetable data)
// ============================================================

function extractFromSchedule(schedule) {
  const results = [];
  if (!schedule) return results;

  const trainId  = schedule.rid;
  const operator = schedule.toc;
  if (!trainId) return results;

  const locationTypes = ['OR', 'OPOR', 'IP', 'OPIP', 'PP', 'DT', 'OPDT'];

  // Collect all locations for direction inference
  const allLocations = [];
  for (const locType of locationTypes) {
    if (!schedule[locType]) continue;
    const locs = Array.isArray(schedule[locType]) ? schedule[locType] : [schedule[locType]];
    allLocations.push(...locs);
  }
  const direction = inferDirection(allLocations);

  for (const locType of locationTypes) {
    if (!schedule[locType]) continue;
    const locations = Array.isArray(schedule[locType]) ? schedule[locType] : [schedule[locType]];

    for (const loc of locations) {
      const tiploc = loc.tpl;
      if (!tiploc || !isTiplocMonitored(tiploc)) continue;

      console.log(`[parser] Schedule: found monitored TIPLOC ${tiploc} for train ${trainId}`);

      // Scheduled times from timetable
      const scheduledArrival   = loc.wta ? toISO(loc.wta) : null;
      const scheduledDeparture = loc.wtd ? toISO(loc.wtd) : null;
      const scheduledPass      = loc.wtp ? toISO(loc.wtp) : null;

      // For schedule records, predicted = scheduled (no live data yet)
      const predictedArrival   = scheduledArrival;
      const predictedDeparture = scheduledDeparture;
      const predictedPass      = scheduledPass;

      // PP = passing point (non-stopping)
      const isStopping = locType !== 'PP' && locType !== 'OPIP' && !scheduledPass;

      if (!scheduledArrival && !scheduledDeparture && !scheduledPass) continue;

      results.push({
        type: 'schedule',
        trainId,
        operator,
        tiploc,
        scheduledArrival,
        predictedArrival,
        scheduledDeparture,
        predictedDeparture,
        scheduledPass,
        predictedPass,
        isStopping,
        direction,
        timeBasis: 'scheduled'
      });
    }
  }

  return results;
}

// ============================================================
// Infer direction from location sequence
// If first location is a London terminus → outbound
// If last location is a London terminus → inbound
// ============================================================

const LONDON_TIPLOCS = new Set([
  'WTRLOO',   // London Waterloo
  'CLPHMJC',  // Clapham Junction
  'CLPHMJM',  // Clapham Junction (main)
  'CLPHMJW',  // Clapham Junction (Windsor lines)
  'VAUXHLM',  // Vauxhall
]);

function inferDirection(locations) {
  if (!locations || locations.length === 0) return null;
  const firstTiploc = locations[0]?.tpl;
  const lastTiploc  = locations[locations.length - 1]?.tpl;
  if (firstTiploc && LONDON_TIPLOCS.has(firstTiploc)) return 'outbound';
  if (lastTiploc  && LONDON_TIPLOCS.has(lastTiploc))  return 'inbound';
  return null;
}

// ============================================================
// Helper: convert HH:MM or ISO string to full ISO timestamp
// ============================================================

function toISO(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return timeStr;

  const now = new Date();
  const [hours, minutes] = timeStr.split(':').map(Number);
  const result = new Date(now);
  result.setHours(hours, minutes, 0, 0);

  // If more than 6 hours in the past, assume next day
  if (result < new Date(now.getTime() - 6 * 60 * 60 * 1000)) {
    result.setDate(result.getDate() + 1);
  }

  return result.toISOString();
}
