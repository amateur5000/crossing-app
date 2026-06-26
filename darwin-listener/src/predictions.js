// ============================================================
// src/predictions.js
// Writes train timing data to the Supabase predictions table.
// Captures arrival, departure, pass times and direction.
// ============================================================

import { supabase } from './supabase.js';
import { getCrossingsForTiploc } from './crossings.js';

// ============================================================
// Process a schedule or forecast record
// ============================================================

export async function processPrediction(record) {
  const crossings = getCrossingsForTiploc(record.tiploc);
  if (!crossings.length) return;

  for (const crossing of crossings) {
    if (!record.predictedTime && !record.scheduledTime) continue;

    const predictedTime = record.predictedTime || record.scheduledTime;
    const scheduledTime = record.scheduledTime || record.predictedTime;

    // Calculate crossing closure window
    const closesAt = new Date(
      new Date(predictedTime).getTime() - crossing.lead_time_seconds * 1000
    ).toISOString();

    // Estimate opening — 1 minute after predicted pass (to be refined)
    const opensAt = new Date(
      new Date(predictedTime).getTime() + 60 * 1000
    ).toISOString();

    // Determine status
    let status = 'scheduled';
    if (record.timeBasis === 'actual') {
      status = 'actual';
    } else if (record.timeBasis === 'predicted') {
      const scheduledMs = new Date(scheduledTime).getTime();
      const predictedMs = new Date(predictedTime).getTime();
      const delaySeconds = (predictedMs - scheduledMs) / 1000;
      status = delaySeconds > 60 ? 'delayed' : 'on_time';
    }

    const { error } = await supabase
      .from('predictions')
      .upsert({
        crossing_id:      crossing.crossing_id,
        train_id:         record.trainId,
        operator:         record.operator || null,
        scheduled_time:   scheduledTime,
        predicted_time:   predictedTime,
        arrival_time:     record.arrivalTime   || null,
        departure_time:   record.departureTime || null,
        pass_time:        record.passTime      || null,
        is_stopping:      record.isStopping    ?? false,
        direction:        record.direction     || null,
        closes_at:        closesAt,
        opens_at:         opensAt,
        status,
        time_basis:       record.timeBasis,
        last_updated:     new Date().toISOString()
      }, {
        onConflict: 'crossing_id,train_id',
        ignoreDuplicates: false
      });

    if (error) {
      console.error(`[predictions] Failed to upsert train ${record.trainId} at ${crossing.crossing_name}:`, error.message);
    } else {
      const stopLabel = record.isStopping ? 'stopping' : 'pass-through';
      const dirLabel  = record.direction  || 'unknown direction';
      console.log(`[predictions] ✓ Train ${record.trainId} at ${crossing.crossing_name} — ${stopLabel}, ${dirLabel}, ${record.timeBasis} ${predictedTime} (${status})`);
    }
  }
}

// ============================================================
// Process a deactivated train — mark as cancelled
// ============================================================

export async function processDeactivated(record) {
  const { error } = await supabase
    .from('predictions')
    .update({
      status:       'cancelled',
      time_basis:   'actual',
      last_updated: new Date().toISOString()
    })
    .eq('train_id', record.trainId);

  if (error) {
    console.error(`[predictions] Failed to cancel train ${record.trainId}:`, error.message);
  }
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
