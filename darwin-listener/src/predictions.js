// ============================================================
// src/predictions.js
// Two-table write logic:
//   1. train_locations — raw Darwin data per station
//   2. predictions     — derived crossing closure windows
//
// Crossing closure logic (Option 1 — single station approach):
//   - Inbound train:  use outer station departure + travel time offset
//   - Outbound train: use inner station departure + travel time offset
//   - Mortlake (crossing at station): use same station for both
//
// closes_at = anchor_time - lead_time_seconds
// opens_at  = anchor_time + travel_time + open_buffer_seconds
// ============================================================

import { supabase } from './supabase.js';
import { getCrossingsForTiploc } from './crossings.js';

// Buffer after train clears crossing before it reopens (seconds)
const OPEN_BUFFER_SECONDS = 30;

// Metres per second conversion
function mphToMps(mph) {
  return mph * 0.44704;
}

// ============================================================
// Calculate travel time from station to crossing in seconds
// ============================================================

function travelTimeSeconds(distanceMetres, lineSpeedMph) {
  if (!distanceMetres || distanceMetres === 0) return 0;
  const speedMps = mphToMps(lineSpeedMph || 60);
  return Math.round(distanceMetres / speedMps);
}

// ============================================================
// Determine which crossing station record to use
// based on train direction and station side
// ============================================================

function selectSourceStation(crossings, direction) {
  if (!crossings.length) return null;

  // If only one station record, use it regardless
  if (crossings.length === 1) return crossings[0];

  // For inbound trains (towards London): use outer station
  // (train approaches crossing from the country side)
  if (direction === 'inbound') {
    return crossings.find(c => c.side === 'outer') || crossings[0];
  }

  // For outbound trains (away from London): use inner station
  // (train approaches crossing from the London side)
  if (direction === 'outbound') {
    return crossings.find(c => c.side === 'inner') || crossings[0];
  }

  // Direction unknown — use inner station as default
  return crossings.find(c => c.side === 'inner') || crossings[0];
}

// ============================================================
// Determine the anchor time for closure calculation
// For stopping trains: use departure (train must leave before crossing opens)
// For non-stopping: use pass time
// For closure: use arrival (crossing closes as train approaches)
// ============================================================

function getAnchorTimes(record) {
  if (record.isStopping) {
    return {
      closureAnchor: record.predictedArrival   || record.predictedPass,
      openingAnchor: record.predictedDeparture || record.predictedArrival || record.predictedPass
    };
  } else {
    return {
      closureAnchor: record.predictedPass || record.predictedArrival,
      openingAnchor: record.predictedPass || record.predictedDeparture
    };
  }
}

// ============================================================
// Write raw Darwin data to train_locations table
// ============================================================

async function writeTrainLocation(record) {
  // Determine status
  let status = 'scheduled';
  if (record.timeBasis === 'actual') {
    status = 'actual';
  } else if (record.timeBasis === 'predicted') {
    // Compare predicted vs scheduled
    const scheduledRef = record.scheduledPass || record.scheduledArrival;
    const predictedRef = record.predictedPass || record.predictedArrival;
    if (scheduledRef && predictedRef) {
      const delaySeconds = (new Date(predictedRef) - new Date(scheduledRef)) / 1000;
      status = delaySeconds > 60 ? 'delayed' : 'on_time';
    } else {
      status = 'on_time';
    }
  }

  const { error } = await supabase
    .from('train_locations')
    .upsert({
      train_id:             record.trainId,
      operator:             record.operator            || null,
      direction:            record.direction           || null,
      station_tiploc:       record.tiploc,
      station_crs:          record.stationCrs          || null,
      is_stopping:          record.isStopping          ?? false,
      scheduled_arrival:    record.scheduledArrival    || null,
      scheduled_departure:  record.scheduledDeparture  || null,
      scheduled_pass:       record.scheduledPass       || null,
      predicted_arrival:    record.predictedArrival    || null,
      predicted_departure:  record.predictedDeparture  || null,
      predicted_pass:       record.predictedPass       || null,
      time_basis:           record.timeBasis,
      status,
      last_updated:         new Date().toISOString()
    }, {
      onConflict: 'train_id,station_tiploc',
      ignoreDuplicates: false
    });

  if (error) {
    console.error(`[train_locations] Failed to write train ${record.trainId} at ${record.tiploc}:`, error.message);
    return false;
  }
  return true;
}

// ============================================================
// Calculate and write crossing prediction
// ============================================================

async function writePrediction(record, crossingStation) {
  const { closureAnchor, openingAnchor } = getAnchorTimes(record);
  if (!closureAnchor) return;

  // Calculate travel time offset from station to crossing
  const travelSecs = travelTimeSeconds(
    crossingStation.distance_metres,
    crossingStation.line_speed_mph
  );

  // closes_at: anchor time minus lead time, adjusted for travel time from station
  const closesAt = new Date(
    new Date(closureAnchor).getTime()
    - (crossingStation.lead_time_seconds * 1000)
    + (travelSecs * 1000)
  ).toISOString();

  // opens_at: opening anchor plus travel time plus buffer
  const opensAt = new Date(
    new Date(openingAnchor).getTime()
    + (travelSecs * 1000)
    + (OPEN_BUFFER_SECONDS * 1000)
  ).toISOString();

  // Determine status
  let status = 'scheduled';
  if (record.timeBasis === 'actual') {
    status = 'actual';
  } else if (record.timeBasis === 'predicted') {
    const scheduledRef = record.scheduledPass || record.scheduledArrival;
    if (scheduledRef) {
      const delaySeconds = (new Date(closureAnchor) - new Date(scheduledRef)) / 1000;
      status = delaySeconds > 60 ? 'delayed' : 'on_time';
    } else {
      status = 'on_time';
    }
  }

  const { error } = await supabase
    .from('predictions')
    .upsert({
      crossing_id:    crossingStation.crossing_id,
      train_id:       record.trainId,
      source_tiploc:  record.tiploc,
      source_side:    crossingStation.side || null,
      closes_at:      closesAt,
      opens_at:       opensAt,
      is_stopping:    record.isStopping ?? false,
      direction:      record.direction  || null,
      operator:       record.operator   || null,
      time_basis:     record.timeBasis,
      status,
      last_updated:   new Date().toISOString()
    }, {
      onConflict: 'crossing_id,train_id',
      ignoreDuplicates: false
    });

  if (error) {
    console.error(`[predictions] Failed to write prediction for train ${record.trainId} at crossing ${crossingStation.crossing_name}:`, error.message);
  } else {
    const stopLabel = record.isStopping ? 'stopping'     : 'pass-through';
    const dirLabel  = record.direction  || 'unknown dir';
    console.log(`[predictions] ✓ Train ${record.trainId} at ${crossingStation.crossing_name} — ${stopLabel}, ${dirLabel}, ${record.timeBasis}, closes ${closesAt.substring(11,16)}, opens ${opensAt.substring(11,16)} (${status})`);
  }
}

// ============================================================
// Main process function — called for each parsed record
// ============================================================

export async function processPrediction(record) {
  const allCrossings = getCrossingsForTiploc(record.tiploc);
  if (!allCrossings.length) return;

  // Step 1: Write raw data to train_locations
  const written = await writeTrainLocation(record);
  if (!written) return;

  // Step 2: Group crossings by crossing_id and select source station
  const crossingIds = [...new Set(allCrossings.map(c => c.crossing_id))];

  for (const crossingId of crossingIds) {
    const crossingStations = allCrossings.filter(c => c.crossing_id === crossingId);
    const sourceStation    = selectSourceStation(crossingStations, record.direction);
    if (!sourceStation) continue;

    // Only use this station's data if it's the right source for this direction
    // (skip if this TIPLOC is the wrong side for this train's direction)
    await writePrediction(record, sourceStation);
  }
}

// ============================================================
// Process a deactivated train — mark as cancelled in both tables
// ============================================================

export async function processDeactivated(record) {
  // Only mark as cancelled if the train has not already received actual times
  // Darwin sends deactivation for completed journeys too, not just cancellations
  const { data: existing } = await supabase
    .from('train_locations')
    .select('time_basis')
    .eq('train_id', record.trainId)
    .single();

  // If already marked as actual, the train ran — ignore the deactivation
  if (existing?.time_basis === 'actual') {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[deactivated] Ignoring deactivation for completed train ${record.trainId}`);
    }
    return;
  }

  const now = new Date().toISOString();

  const { error: locError } = await supabase
    .from('train_locations')
    .update({ status: 'cancelled', last_updated: now })
    .eq('train_id', record.trainId);

  const { error: predError } = await supabase
    .from('predictions')
    .update({ status: 'cancelled', time_basis: 'actual', last_updated: now })
    .eq('train_id', record.trainId);

  if (locError)  console.error(`[train_locations] Failed to cancel train ${record.trainId}:`, locError.message);
  if (predError) console.error(`[predictions] Failed to cancel train ${record.trainId}:`, predError.message);
}

// ============================================================
// Nightly cleanup
// ============================================================

export async function runCleanup() {
  console.log('[cleanup] Running nightly data cleanup...');
  const { error } = await supabase.rpc('cleanup_old_data');
  if (error) {
    console.error('[cleanup] Cleanup failed:', error.message);
  } else {
    console.log('[cleanup] Cleanup completed successfully');
  }
}
