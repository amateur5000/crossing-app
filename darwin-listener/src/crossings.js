// ============================================================
// src/crossings.js
// Loads monitored crossings from Supabase on startup.
// Builds a TIPLOC-based lookup map for fast filtering.
// ============================================================

import { supabase } from './supabase.js';

// In-memory map of TIPLOC -> array of crossing records
// e.g. { 'MRTLKE': [{ crossing_id: 1, name: 'Mortlake', lead_time_seconds: 180 }] }
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
      crossings (
        id,
        name,
        lead_time_seconds,
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
      console.warn(`[crossings] Warning: no TIPLOC for station ${row.station_name} (${row.station_crs}) — skipping`);
      continue;
    }

    const tiploc = row.tiploc;
    if (!monitoredTiplocs[tiploc]) {
      monitoredTiplocs[tiploc] = [];
    }

    monitoredTiplocs[tiploc].push({
      crossing_id: row.crossings.id,
      crossing_name: row.crossings.name,
      lead_time_seconds: row.crossings.lead_time_seconds,
      station_crs: row.station_crs,
      station_name: row.station_name,
      tiploc,
      distance_metres: row.distance_metres,
      direction: row.direction
    });
  }

  const tiplocCount = Object.keys(monitoredTiplocs).length;
  console.log(`[crossings] Loaded ${data.length} crossing-station mappings across ${tiplocCount} TIPLOCs`);
  console.log(`[crossings] Monitoring TIPLOCs: ${Object.keys(monitoredTiplocs).join(', ')}`);

  return monitoredTiplocs;
}

export function isTiplocMonitored(tiploc) {
  return !!monitoredTiplocs[tiploc];
}

export function getCrossingsForTiploc(tiploc) {
  return monitoredTiplocs[tiploc] || [];
}
