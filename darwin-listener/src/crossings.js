// ============================================================
// src/crossings.js
// Loads monitored crossings and their station mappings
// from Supabase on startup.
// Builds a TIPLOC-based lookup map for fast filtering.
// ============================================================

import { supabase } from './supabase.js';

// In-memory map of TIPLOC -> array of crossing station records
// e.g. { 'MRTLKE': [{ crossing_id: 1, side: 'inner', ... }] }
let monitoredTiplocs = {};

export async function loadCrossings() {
  console.log('[crossings] Loading monitored crossings from Supabase...');

  const { data, error } = await supabase
    .from('crossing_stations')
    .select(`
      station_crs,
      station_name,
      tiploc,
      distance_metres,
      direction,
      side,
      crossings (
        id,
        name,
        lead_time_seconds,
        line_speed_mph,
        active
      )
    `);

  if (error) {
    console.error('[crossings] Failed to load crossings:', error.message);
    throw error;
  }

  monitoredTiplocs = {};

  for (const row of data) {
    if (!row.crossings || !row.crossings.active) continue;
    if (!row.tiploc) {
      console.warn(`[crossings] Warning: no TIPLOC for ${row.station_name} — skipping`);
      continue;
    }

    const tiploc = row.tiploc;
    if (!monitoredTiplocs[tiploc]) monitoredTiplocs[tiploc] = [];

    monitoredTiplocs[tiploc].push({
      crossing_id:        row.crossings.id,
      crossing_name:      row.crossings.name,
      lead_time_seconds:  row.crossings.lead_time_seconds,
      line_speed_mph:     row.crossings.line_speed_mph || 60,
      station_crs:        row.station_crs,
      station_name:       row.station_name,
      tiploc,
      distance_metres:    row.distance_metres,
      side:               row.side,
      direction:          row.direction
    });
  }

  const tiplocCount   = Object.keys(monitoredTiplocs).length;
  const crossingCount = new Set(
    Object.values(monitoredTiplocs).flat().map(r => r.crossing_id)
  ).size;

  console.log(`[crossings] Loaded ${crossingCount} crossing(s) across ${tiplocCount} TIPLOC(s)`);
  console.log(`[crossings] Monitoring TIPLOCs: ${Object.keys(monitoredTiplocs).join(', ')}`);

  return monitoredTiplocs;
}

export function isTiplocMonitored(tiploc) {
  return !!monitoredTiplocs[tiploc];
}

export function getCrossingsForTiploc(tiploc) {
  return monitoredTiplocs[tiploc] || [];
}
