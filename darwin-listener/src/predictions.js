// ============================================================
// src/predictions.js
// Writes train timing data to the Supabase predictions table.
// Called by the main listener for each relevant Darwin message.
// ============================================================

import { supabase } from './supabase.js';
import { getCrossingsForCRS } from './crossings.js';

// ============================================================
// Process a parsed schedule record
// Inserts or updates the scheduled times for a train
// ============================================================

export async function processSchedule(record) {
  const crossings = getCrossingsForCRS(record.crs);
  if (!crossings.length) return;

  for (const crossing of crossings) {
    // The scheduled crossing time is:
    // - The pass time if the train doesn't stop (most common for level crossings)
    // - The departure time if the train stops at the adjacent station
    // - The arrival time as fallback
    const scheduledTime =
      record.scheduledPass ||
      record.scheduledDeparture ||
      record.scheduledArrival;

    if (!scheduledTime) continue;

    // Calculate predicted closure time (scheduled time minus lead time)
    const closesAt = new Date(
      new Date(scheduledTime).getTime() - crossing.lead_time_seconds * 1000
    ).toISOString();

    // Estimate opening time — assume 1 minute after scheduled pass
    // This will be refined once we have real data
    const opensAt = new Date(
      new Date(scheduledTime).getTime() + 60 * 1000
    ).toISOString();

    const { error } = await supabase
      .from('predictions')
      .upsert({
        crossing_id: crossing.crossing_id,
        train_id: record.trainId,
        operator: record.operator,
        scheduled_time: scheduledTime,
        predicted_time: scheduledTime, // Will be updated when forecast arrives
        closes_at: closesAt,
        opens_at: opensAt,
        status: 'scheduled',
        time_basis: 'scheduled',
        last_updated: new Date().toISOString()
      }, {
        onConflict: 'crossing_id,train_id',
        ignoreDuplicates: false  // Always update if we get new schedule data
      });

    if (error) {
      console.error(`[predictions] Failed to upsert schedule for train ${record.trainId} at crossing ${crossing.crossing_name}:`, error.message);
    } else if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[predictions] Schedule: train ${record.trainId} at ${crossing.crossing_name} — scheduled ${scheduledTime}`);
    }
  }
}

// ============================================================
// Process a parsed forecast record
// Updates the predicted times for a train already in the table
// ============================================================

export async function processForecast(record) {
  const crossings = getCrossingsForCRS(record.crs);
  if (!crossings.length) return;

  for (const crossing of crossings) {
    const predictedTime =
      record.predictedPass ||
      record.predictedDeparture ||
      record.predictedArrival;

    if (!predictedTime) continue;

    // Determine status
    let status = 'on_time';
    if (record.timeBasis === 'actual') {
      status = 'actual';
    }

    // Recalculate closure window based on latest prediction
    const closesAt = new Date(
      new Date(predictedTime).getTime() - crossing.lead_time_seconds * 1000
    ).toISOString();

    const opensAt = new Date(
      new Date(predictedTime).getTime() + 60 * 1000
    ).toISOString();

    // Try to update existing record first
    const { data: existing } = await supabase
      .from('predictions')
      .select('id, scheduled_time, status')
      .eq('crossing_id', crossing.crossing_id)
      .eq('train_id', record.trainId)
      .single();

    if (existing) {
      // Check if train is running late
      const scheduledMs = new Date(existing.scheduled_time).getTime();
      const predictedMs = new Date(predictedTime).getTime();
      const delaySeconds = (predictedMs - scheduledMs) / 1000;

      if (delaySeconds > 60) status = 'delayed';
      if (record.timeBasis === 'actual') status = 'actual';

      const { error } = await supabase
        .from('predictions')
        .update({
          predicted_time: predictedTime,
          closes_at: closesAt,
          opens_at: opensAt,
          status,
          time_basis: record.timeBasis,
          last_updated: new Date().toISOString()
        })
        .eq('id', existing.id);

      if (error) {
        console.error(`[predictions] Failed to update forecast for train ${record.trainId}:`, error.message);
      } else {
        console.log(`[predictions] Updated: train ${record.trainId} at ${crossing.crossing_name} — ${record.timeBasis} ${predictedTime} (${status})`);
      }

    } else {
      // No existing schedule record — insert forecast as new row
      // This can happen for trains that were already running when the listener started
      const { error } = await supabase
        .from('predictions')
        .upsert({
          crossing_id: crossing.crossing_id,
          train_id: record.trainId,
          operator: record.operator,
          scheduled_time: predictedTime, // Use predicted as scheduled if we don't have it
          predicted_time: predictedTime,
          closes_at: closesAt,
          opens_at: opensAt,
          status,
          time_basis: record.timeBasis,
          last_updated: new Date().toISOString()
        }, {
          onConflict: 'crossing_id,train_id',
          ignoreDuplicates: false
        });

      if (error) {
        console.error(`[predictions] Failed to insert forecast for train ${record.trainId}:`, error.message);
      } else {
        console.log(`[predictions] Inserted forecast: train ${record.trainId} at ${crossing.crossing_name} — ${predictedTime}`);
      }
    }
  }
}

// ============================================================
// Process a deactivated train
// Marks cancelled trains in the predictions table
// ============================================================

export async function processDeactivated(record) {
  const { error } = await supabase
    .from('predictions')
    .update({ status: 'cancelled', time_basis: 'actual', last_updated: new Date().toISOString() })
    .eq('train_id', record.trainId);

  if (error) {
    console.error(`[predictions] Failed to mark train ${record.trainId} as cancelled:`, error.message);
  } else if (process.env.LOG_LEVEL === 'debug') {
    console.log(`[predictions] Cancelled: train ${record.trainId}`);
  }
}

// ============================================================
// Cleanup job — deletes old predictions and history
// Called once per day
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
