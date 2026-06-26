// ============================================================
// src/parser.js
// Parses Darwin Push Port v18 JSON messages.
// Extracts arrival, departure and pass times separately.
// Determines direction of travel from schedule origin/destination.
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
// ============================================================

function extractFromTS(ts, messageTimestamp) {
  const results = [];
  if (!ts) return results;

  const trainId = ts.rid;
  const operator = ts.toc;
  if (!trainId) return results;

  const locations = ts.Location;
  if (!locations) return results;
  const locArray = Array.isArray(locations) ? locations : [locations];

  // Determine direction from the full location sequence
  // We look at the first and last TIPLOCs in the message to infer direction
  const direction = inferDirection(locArray);

  for (const loc of locArray) {
    const tiploc = loc.tpl;
    if (!tiploc || !isTiplocMonitored(tiploc)) continue;

    console.log(`[parser] Found monitored TIPLOC: ${tiploc} for train ${trainId}`);

    // ---- Arrival times ----
    const arr = loc.arr || {};
    const arrivalTime =
      (arr.at ? toISO(arr.at) : null) ||   // Actual arrival
      (arr.et ? toISO(arr.et) : null) ||   // Estimated arrival
      (loc.wta ? toISO(loc.wta) : null);   // Working timetable arrival

    // ---- Departure times ----
    const dep = loc.dep || {};
    const departureTime =
      (dep.at ? toISO(dep.at) : null) ||   // Actual departure
      (dep.et ? toISO(dep.et) : null) ||   // Estimated departure
      (loc.wtd ? toISO(loc.wtd) : null);   // Working timetable departure

    // ---- Pass times (non-stopping trains) ----
    const pass = loc.pass || {};
    const passTime =
      (pass.at ? toISO(pass.at) : null) || // Actual pass
      (pass.et ? toISO(pass.et) : null) || // Estimated pass
      (loc.wtp ? toISO(loc.wtp) : null);   // Working timetable pass

    // ---- Determine if train stops here ----
    // A train stops if it has arrival AND departure times (not just a pass)
    const isStopping = !!(arrivalTime && departureTime) || (!passTime && !!(arrivalTime || departureTime));

    // ---- Scheduled time (working timetable) ----
    const scheduledTime =
      (loc.wtp ? toISO(loc.wtp) : null) ||
      (loc.wtd ? toISO(loc.wtd) : null) ||
      (loc.wta ? toISO(loc.wta) : null);

    // ---- Best predicted time for crossing closure calculation ----
    // For crossing: pass time for non-stopping, arrival time for stopping
    // (crossing goes down before train arrives, not when it departs)
    const predictedTime =
      passTime ||
      arrivalTime ||
      departureTime ||
      scheduledTime;

    // ---- Time basis ----
    let timeBasis = 'scheduled';
    if (pass.at || dep.at || arr.at) timeBasis = 'actual';
    else if (pass.et || dep.et || arr.et) timeBasis = 'predicted';

    if (!predictedTime) continue;

    results.push({
      type: 'forecast',
      trainId,
      operator,
      tiploc,
      scheduledTime,
      predictedTime,
      arrivalTime,
      departureTime,
      passTime,
      isStopping,
      direction,
      timeBasis,
      lastUpdated: messageTimestamp || new Date().toISOString()
    });
  }

  return results;
}

// ============================================================
// Extract from schedule records
// ============================================================

function extractFromSchedule(schedule) {
  const results = [];
  if (!schedule) return results;

  const trainId = schedule.rid;
  const operator = schedule.toc;
  if (!trainId) return results;

  // Get all locations in sequence to infer direction
  const allLocations = [];
  const locationTypes = ['OR', 'OPOR', 'IP', 'OPIP', 'PP', 'DT', 'OPDT'];
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

      const arrivalTime   = loc.wta ? toISO(loc.wta) : null;
      const departureTime = loc.wtd ? toISO(loc.wtd) : null;
      const passTime      = loc.wtp ? toISO(loc.wtp) : null;

      // PP = passing point (non-stopping)
      const isStopping = locType !== 'PP' && locType !== 'OPIP';

      const scheduledTime =
        passTime || departureTime || arrivalTime;

      const predictedTime =
        passTime || arrivalTime || departureTime || scheduledTime;

      if (!scheduledTime) continue;

      results.push({
        type: 'schedule',
        trainId,
        operator,
        tiploc,
        scheduledTime,
        predictedTime,
        arrivalTime,
        departureTime,
        passTime,
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
// London terminus TIPLOCs are used as reference points.
// If the train's first location is a London terminus, it's outbound.
// If the last location is a London terminus, it's inbound.
// ============================================================

// Key London terminus and inner TIPLOCs on the South Western Main Line
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

  return null; // Direction unknown
}

// ============================================================
// Helper: convert HH:MM time string to full ISO timestamp
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
// Note: targeted debug added below in extractFromTS
