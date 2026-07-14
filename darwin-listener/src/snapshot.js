// ============================================================
// src/snapshot.js
// Darwin Real Time Train Information Snapshots processor.
// Downloads hourly snapshot files and processes them to find
// any trains at monitored TIPLOCs (particularly VAR services)
// that weren't caught by the Kafka push stream.
// ============================================================

import { createGunzip } from 'zlib';
import { parseStringPromise } from 'xml2js';
import { supabase } from './supabase.js';
import { getCrossingsForTiploc, isTiplocMonitored } from './crossings.js';
import { processPrediction } from './predictions.js';

const SNAPSHOT_API_URL = process.env.SNAPSHOT_API_URL;
const SNAPSHOT_API_KEY = process.env.SNAPSHOT_API_KEY;

// ============================================================
// Main snapshot processing function
// Called once per hour from index.js
// ============================================================

export async function processSnapshot() {
  console.log('[snapshot] Starting hourly snapshot processing...');

  try {
    // Get the most recent completed hour (5+ mins ago for availability)
    const now  = new Date();
    const hour = new Date(now.getTime() - 10 * 60 * 1000); // 10 mins ago to be safe
    const date = hour.toISOString().slice(0, 10);           // YYYY-MM-DD
    const hh   = String(hour.getUTCHours()).padStart(2, '0'); // HH

    console.log(`[snapshot] Requesting snapshot for ${date} hour ${hh} UTC`);

    // Step 1: Request the snapshot URL
    const urlResponse = await fetch(SNAPSHOT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-apikey': SNAPSHOT_API_KEY
      },
      body: JSON.stringify({ date, hour: hh })
    });

    if (!urlResponse.ok) {
      const text = await urlResponse.text();
      console.error(`[snapshot] Failed to get snapshot URL: ${urlResponse.status} ${text}`);
      return;
    }

    // The API returns the download URL as plain text, not JSON
    const responseText = await urlResponse.text();
    const downloadUrl = responseText.trim();

    if (!downloadUrl || !downloadUrl.startsWith('http')) {
      console.error('[snapshot] Unexpected response format:', responseText.substring(0, 200));
      return;
    }

    console.log('[snapshot] Got download URL, fetching gzip file...');

    // Step 2: Download the gzip file
    const fileResponse = await fetch(downloadUrl);
    if (!fileResponse.ok) {
      console.error(`[snapshot] Failed to download snapshot file: ${fileResponse.status}`);
      return;
    }

    // Step 3: Decompress and parse the XML
    const buffer     = await fileResponse.arrayBuffer();
    const compressed = Buffer.from(buffer);
    const xml        = await decompressGzip(compressed);

    console.log(`[snapshot] Downloaded and decompressed snapshot (${Math.round(xml.length / 1024)}KB)`);

    // Step 4: Parse the XML
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs:    true
    });

    // Step 5: Extract and process schedules
    // Log root element keys to help diagnose structure issues
    console.log('[snapshot] Root element keys:', Object.keys(parsed).join(', '));
    await processSchedulesFromSnapshot(parsed);

  } catch (err) {
    console.error('[snapshot] Error processing snapshot:', err.message);
  }
}

// ============================================================
// Decompress gzip buffer to string
// ============================================================

function decompressGzip(buffer) {
  return new Promise((resolve, reject) => {
    const gunzip  = createGunzip();
    const chunks  = [];

    gunzip.on('data',  chunk => chunks.push(chunk));
    gunzip.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
    gunzip.on('error', err   => reject(err));

    gunzip.write(buffer);
    gunzip.end();
  });
}

// ============================================================
// Process schedules from the snapshot XML
// Finds trains at monitored TIPLOCs and inserts missing ones
// ============================================================

async function processSchedulesFromSnapshot(parsed) {
  // Darwin snapshot uses XML namespace prefix pp:
  // Root element is pp:Pport, children use pp: prefix too
  const pport = parsed['pp:Pport'] || parsed['Pport'] || parsed['pport'] ||
    Object.values(parsed).find(v => v && typeof v === 'object');

  if (!pport) {
    console.error('[snapshot] Could not find Pport element. Keys:', Object.keys(parsed).join(', '));
    return;
  }

  // uR element — try namespace-prefixed and plain versions
  const uR = pport['pp:uR'] || pport['uR'] || pport['ur'];
  if (!uR) {
    console.error('[snapshot] Could not find uR element. Keys:', Object.keys(pport).join(', '));
    return;
  }

  // Schedule elements — try namespace-prefixed and plain versions
  const schedules = uR['pp:schedule'] || uR['schedule'] || uR['Schedule'];
  if (!schedules) {
    console.log('[snapshot] No schedules in snapshot');
    return;
  }

  const scheduleArray = Array.isArray(schedules) ? schedules : [schedules];
  console.log(`[snapshot] Processing ${scheduleArray.length} schedules from snapshot`);

  let found   = 0;
  let inserted = 0;
  let skipped  = 0;

  // Try both plain and namespace-prefixed location type keys
  const locationTypes    = ['OR', 'OPOR', 'IP', 'OPIP', 'PP', 'DT', 'OPDT'];
  const allLocationTypes = [...locationTypes, ...locationTypes.map(t => 'pp:' + t)];

  for (const schedule of scheduleArray) {
    // Attributes may be direct or prefixed depending on xml2js config
    const trainId  = schedule.rid  || schedule['@rid'];
    const operator = schedule.toc  || schedule['@toc'];
    const ssd      = schedule.ssd  || schedule['@ssd'];

    if (!trainId) continue;

    for (const locType of allLocationTypes) {
      if (!schedule[locType]) continue;

      const locations = Array.isArray(schedule[locType])
        ? schedule[locType]
        : [schedule[locType]];

      for (const loc of locations) {
        const tiploc = loc.tpl || loc['@tpl'];
        if (!tiploc || !isTiplocMonitored(tiploc)) continue;

        found++;

        // Check if we already have this train in train_locations
        const { data: existing } = await supabase
          .from('train_locations')
          .select('train_id')
          .eq('train_id', trainId)
          .eq('station_tiploc', tiploc)
          .single();

        if (existing) {
          skipped++;
          continue; // Already have this train — push stream got it
        }

        // New train not in our database — insert it
        console.log(`[snapshot] New train found: ${trainId} at ${tiploc} (${locType})`);

        // Extract times — attributes may be plain or @-prefixed
        const wta = loc.wta || loc['@wta'];
        const wtd = loc.wtd || loc['@wtd'];
        const wtp = loc.wtp || loc['@wtp'];

        const scheduledArrival   = wta ? toISO(wta, ssd) : null;
        const scheduledDeparture = wtd ? toISO(wtd, ssd) : null;
        const scheduledPass      = wtp ? toISO(wtp, ssd) : null;

        if (!scheduledArrival && !scheduledDeparture && !scheduledPass) continue;

        const baseType   = locType.replace('pp:', '');
        const isStopping = baseType !== 'PP' && baseType !== 'OPIP' && !scheduledPass;

        // Build a record in the same format as the parser output
        const record = {
          trainId,
          operator,
          tiploc,
          scheduledArrival,
          predictedArrival:   scheduledArrival,
          scheduledDeparture,
          predictedDeparture: scheduledDeparture,
          scheduledPass,
          predictedPass:      scheduledPass,
          isStopping,
          direction:  null, // Will be updated when TS messages arrive
          timeBasis:  'scheduled'
        };

        // Use the existing processPrediction function to write to both tables
        await processPrediction(record);
        inserted++;
      }
    }
  }

  console.log(`[snapshot] Complete — found ${found} monitored trains, inserted ${inserted} new, skipped ${skipped} existing`);
}

// ============================================================
// Helper: convert HH:MM time + service date to ISO timestamp
// The snapshot includes the service start date (ssd) so we
// can construct accurate timestamps for overnight services
// ============================================================

function toISO(timeStr, ssd) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return timeStr;

  const baseDate = ssd ? new Date(ssd + 'T00:00:00Z') : new Date();
  const [hours, minutes] = timeStr.split(':').map(Number);

  const result = new Date(baseDate);
  result.setUTCHours(hours, minutes, 0, 0);

  // Handle services that run past midnight
  if (hours < 2) {
    result.setUTCDate(result.getUTCDate() + 1);
  }

  return result.toISOString();
}
