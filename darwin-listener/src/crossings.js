// ============================================================
// src/crossings.js
// Loads the list of monitored crossings and their CRS codes
// from Supabase on startup. The listener uses this to filter
// Darwin messages — only trains at these CRS codes are processed.
// ============================================================

import { supabase } from './supabase.js';

// In-memory store of monitored crossings
// Map of CRS code -> array of crossing records
// e.g. { 'MTL': [{ crossing_id: 1, name: 'Mortlake', lead_time_seconds: 180, ... }] }
let monitoredCRS = {};

export async function loadCrossings() {
  console.log('[crossings] Loading monitored crossings from Supabase...');

  const { data, error } = await supabase
    .from('crossing_stations')
    .select(`
      station_crs,
      station_name,
      distance_metres,
      direction,
      crossings (
        id,
        name,
        lead_time_seconds,
        active
      )
    `)
    .eq('crossings.active', true);

  if (error) {
    console.error('[crossings] Failed to load crossings:', error.message);
    throw error;
  }

  // Build the CRS lookup map
  monitoredCRS = {};
  for (const row of data) {
    if (!row.crossings || !row.crossings.active) continue;

    const crs = row.station_crs;
    if (!monitoredCRS[crs]) {
      monitoredCRS[crs] = [];
    }
    monitoredCRS[crs].push({
      crossing_id: row.crossings.id,
      crossing_name: row.crossings.name,
      lead_time_seconds: row.crossings.lead_time_seconds,
      station_crs: crs,
      station_name: row.station_name,
      distance_metres: row.distance_metres,
      direction: row.direction
    });
  }

  const crsCount = Object.keys(monitoredCRS).length;
  const crossingCount = data.length;
  console.log(`[crossings] Loaded ${crossingCount} crossing-station mappings across ${crsCount} CRS codes`);
  console.log(`[crossings] Monitoring CRS codes: ${Object.keys(monitoredCRS).join(', ')}`);

  return monitoredCRS;
}

export function getMonitoredCRS() {
  return monitoredCRS;
}

export function isMonitored(crs) {
  return !!monitoredCRS[crs];
}

export function getCrossingsForCRS(crs) {
  return monitoredCRS[crs] || [];
}
