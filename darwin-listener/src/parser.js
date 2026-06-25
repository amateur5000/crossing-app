// ============================================================
// src/parser.js
// Parses Darwin Push Port v18 JSON messages.
// Extracts train schedule and forecast time updates.
// Returns an array of location time records for monitored CRS codes.
// ============================================================

import { isMonitored } from './crossings.js';

// TIPLOC to CRS mapping cache
// Darwin uses TIPLOC codes internally; we need CRS codes to match our crossings.
// We build this mapping as we see it in the data.
const tiplocToCRS = {};

// Known Mortlake TIPLOC -> CRS mapping to seed the cache
// TIPLOC codes are 7-character location identifiers used internally by the railway
tiplocToCRS['MORTLAK'] = 'MTL';  // Mortlake station

export function registerTiploc(tiploc, crs) {
  if (tiploc && crs) {
    tiplocToCRS[tiploc] = crs;
  }
}

export function getCRSFromTiploc(tiploc) {
  return tiplocToCRS[tiploc] || null;
}

// ============================================================
// Main parse function
// Takes the raw bytes string from a Kafka message,
// parses it, and returns relevant train location updates.
// ============================================================

export function parseMessage(bytesString) {
  const results = [];

  try {
    // The bytes field contains an escaped JSON string
    // Unescape and parse it
    let parsed;
    try {
      parsed = JSON.parse(bytesString);
    } catch {
      // Sometimes it arrives as a double-escaped string
      parsed = JSON.parse(JSON.parse(`"${bytesString.replace(/^"|"$/g, '')}"`));
    }

    // Darwin Push Port v18 structure:
    // { ts: timestamp, version: "18.0", uR: { updateOrigin: "...", ... } }
    const uR = parsed?.uR;
    if (!uR) return results; // Not an update message (may be status/failure)

    const updateOrigin = uR.updateOrigin || '';

    // ---- Schedule Records (sR) ----
    // Full schedule records — contain all planned stop/pass times for a train
    if (uR.schedule) {
      const schedules = Array.isArray(uR.schedule) ? uR.schedule : [uR.schedule];
      for (const schedule of schedules) {
        const extracted = extractFromSchedule(schedule, 'scheduled');
        results.push(...extracted);
      }
    }

    // ---- Forecast Updates (uR containing TS elements) ----
    // Real-time prediction updates — Darwin's best estimate of actual times
    if (uR.TS) {
      const updates = Array.isArray(uR.TS) ? uR.TS : [uR.TS];
      for (const update of updates) {
        const extracted = extractFromForecast(update, parsed.ts);
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
    // Log parse errors but don't crash — bad messages happen
    if (process.env.LOG_LEVEL === 'debug') {
      console.warn('[parser] Failed to parse message:', err.message);
    }
  }

  return results;
}

// ============================================================
// Extract timing data from a schedule record (sR)
// These contain the planned timetable times for a train
// ============================================================

function extractFromSchedule(schedule, timeBasis) {
  const results = [];
  if (!schedule) return results;

  const trainId = schedule.rid || schedule['@rid'];
  const operator = schedule.toc || schedule['@toc'];

  // Locations within the schedule
  // OR = origin, IP = intermediate passing point, DT = destination, PP = pass (no stop)
  const locationTypes = ['OR', 'IP', 'DT', 'PP', 'OPOR', 'OPIP', 'OPDT'];
  
  for (const locType of locationTypes) {
    if (!schedule[locType]) continue;
    const locations = Array.isArray(schedule[locType]) ? schedule[locType] : [schedule[locType]];
    
    for (const loc of locations) {
      const tiploc = loc.tpl || loc['@tpl'];
      if (!tiploc) continue;

      const crs = getCRSFromTiploc(tiploc);
      if (!crs || !isMonitored(crs)) continue;

      // Extract planned times
      const pta = loc.pta || loc['@pta'];   // Planned time of arrival
      const ptd = loc.ptd || loc['@ptd'];   // Planned time of departure
      const passt = loc.passt || loc['@passt'] || loc.pass || loc['@pass']; // Pass time

      if (!pta && !ptd && !passt) continue;

      results.push({
        type: 'schedule',
        trainId,
        operator,
        crs,
        tiploc,
        locationType: locType,
        scheduledArrival: pta ? toISO(pta) : null,
        scheduledDeparture: ptd ? toISO(ptd) : null,
        scheduledPass: passt ? toISO(passt) : null,
        timeBasis: 'scheduled'
      });
    }
  }

  return results;
}

// ============================================================
// Extract timing data from a forecast/TS update
// These contain Darwin's real-time predictions
// ============================================================

function extractFromForecast(ts, messageTimestamp) {
  const results = [];
  if (!ts) return results;

  const trainId = ts.rid || ts['@rid'];
  const operator = ts.toc || ts['@toc'];

  const locations = ts.Location;
  if (!locations) return results;

  const locArray = Array.isArray(locations) ? locations : [locations];

  for (const loc of locArray) {
    const tiploc = loc.tpl || loc['@tpl'];
    if (!tiploc) continue;

    const crs = getCRSFromTiploc(tiploc);
    if (!crs || !isMonitored(crs)) continue;

    // Forecast times
    const arr = loc.arr || {};
    const dep = loc.dep || {};
    const pass = loc.pass || {};

    const etaStr = arr.et || arr['@et'];
    const etdStr = dep.et || dep['@et'];
    const etpStr = pass.et || pass['@et'];

    const atStr = arr.at || arr['@at'];   // Actual arrival (train has arrived)
    const atdStr = dep.at || dep['@at'];  // Actual departure
    const atpStr = pass.at || pass['@at']; // Actual pass

    // Determine time basis
    let timeBasis = 'scheduled';
    if (atStr || atdStr || atpStr) {
      timeBasis = 'actual';
    } else if (etaStr || etdStr || etpStr) {
      timeBasis = 'predicted';
    }

    const predictedArrival = atStr ? toISO(atStr) : (etaStr ? toISO(etaStr) : null);
    const predictedDeparture = atdStr ? toISO(atdStr) : (etdStr ? toISO(etdStr) : null);
    const predictedPass = atpStr ? toISO(atpStr) : (etpStr ? toISO(etpStr) : null);

    if (!predictedArrival && !predictedDeparture && !predictedPass) continue;

    results.push({
      type: 'forecast',
      trainId,
      operator,
      crs,
      tiploc,
      predictedArrival,
      predictedDeparture,
      predictedPass,
      timeBasis,
      lastUpdated: messageTimestamp || new Date().toISOString()
    });
  }

  return results;
}

// ============================================================
// Helper: convert HH:MM time string to full ISO timestamp
// Darwin sends times as HH:MM relative to today
// ============================================================

function toISO(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return timeStr; // Already ISO

  // HH:MM format — combine with today's date
  // Handle trains that run past midnight by checking if time is < 03:00
  // (very early times are likely next-day services)
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
