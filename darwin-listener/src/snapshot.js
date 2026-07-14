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

    // Step 4: Split into individual XML documents and process each
    // The snapshot file contains multiple concatenated Push Port XML messages
    // Each starts with <?xml or <Pport or <pp:Pport
    const xmlDocs = splitXmlDocuments(xml);
    console.log(`[snapshot] Found ${xmlDocs.length} XML document(s) in snapshot`);

    let totalFound = 0;
    let totalInserted = 0;
    let totalSkipped = 0;

    for (let i = 0; i < xmlDocs.length; i++) {
      const doc = xmlDocs[i];
      if (!doc.trim()) continue;

      try {
        const parsed = await parseStringPromise(doc, {
          explicitArray: false,
          mergeAttrs:    true
        });

        const { found, inserted, skipped } = await processSchedulesFromSnapshot(parsed);
        totalFound    += found;
        totalInserted += inserted;
        totalSkipped  += skipped;
      } catch (docErr) {
        if (process.env.LOG_LEVEL === 'debug') {
          console.warn(`[snapshot] Failed to parse document ${i}:`, docErr.message);
        }
      }
    }

    console.log(`[snapshot] Complete — found ${totalFound} monitored trains, inserted ${totalInserted} new, skipped ${totalSkipped} existing`);

  } catch (err) {
    console.error('[snapshot] Error processing snapshot:', err.message);
  }
}

// ============================================================
// Split concatenated XML documents in snapshot file
// The snapshot contains multiple Push Port messages joined together
// We split on the XML declaration or Pport opening tags
// ============================================================

function splitXmlDocuments(xml) {
  // Split on XML declarations or on closing then opening Pport tags
  // Each document starts with <?xml or <pp:Pport or <Pport
  const parts = xml.split(/(?=<\?xml\s|(?<=<\/(?:pp:)?Pport>)\s*<(?:pp:)?Pport)/);

  // Filter out empty parts and parts that don't contain a Pport element
  return parts.filter(p => p.trim() && (p.includes('Pport') || p.includes('pport')));
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
    if (process.env.LOG_LEVEL === 'debug') {
      console.error('[snapshot] Could not find Pport element. Keys:', Object.keys(parsed).join(', '));
    }
    return { found: 0, inserted: 0, skipped: 0 };
  }

  // Log all keys inside pport to understand the structure
  console.log('[snapshot] pport keys:', Object.keys(pport).join(', '));

  // Snapshot uses sR (Schedule Response) not uR
  // Try both sR and uR for compatibility
  const sRRaw = pport['pp:sR'] || pport['sR'] || pport['pp:uR'] || pport['uR'] || pport['ur'];
  const sRArray = sRRaw ? (Array.isArray(sRRaw) ? sRRaw : [sRRaw]) : [];

  if (sRArray.length === 0) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.error('[snapshot] Could not find sR/uR element. Full pport preview:', JSON.stringify(pport).substring(0, 500));
    }
    return { found: 0, inserted: 0, skipped: 0 };
  }

  // Collect all schedules across all sR/uR blocks
  const allSchedules = [];
  for (const sR of sRArray) {
    const s = sR['pp:schedule'] || sR['schedule'] || sR['Schedule'];
    if (s) {
      const arr = Array.isArray(s) ? s : [s];
      allSchedules.push(...arr);
    }
  }

  const schedules = allSchedules;
  if (!schedules || schedules.length === 0) {
    return { found: 0, inserted: 0, skipped: 0 };
  }

  const scheduleArray = schedules; // Already an array from above
  console.log(`[snapshot] Processing ${scheduleArray.length} schedules from snapshot`);

  // DEBUG: Log the first schedule's keys to understand the structure
  if (scheduleArray.length > 0) {
    const first = scheduleArray[0];
    console.log('[snapshot] First schedule keys:', Object.keys(first).join(', '));
    console.log('[snapshot] First schedule preview:', JSON.stringify(first).substring(0, 500));
  }

  let found    = 0;
  let inserted = 0;
  let skipped  = 0;

  // Try plain, pp: and sm: namespace-prefixed location type keys
  // Darwin snapshot uses sm: namespace for schedule elements
  const locationTypes    = ['OR', 'OPOR', 'IP', 'OPIP', 'PP', 'DT', 'OPDT'];
  const allLocationTypes = [
    ...locationTypes,
    ...locationTypes.map(t => 'pp:' + t),
    ...locationTypes.map(t => 'sm:' + t),
    ...locationTypes.map(t => 'ct:' + t),
  ];

  for (const schedule of scheduleArray) {
    // Attributes may be direct, @-prefixed, or nested under $ (xml2js style)
    const attrs    = schedule.$ || schedule;
    const trainId  = schedule.rid  || schedule['@rid']  || attrs.rid;
    const operator = schedule.toc  || schedule['@toc']  || attrs.toc;
    const ssd      = schedule.ssd  || schedule['@ssd']  || attrs.ssd;

    if (!trainId) continue;

    for (const locType of allLocationTypes) {
      if (!schedule[locType]) continue;

      const locations = Array.isArray(schedule[locType])
        ? schedule[locType]
        : [schedule[locType]];

      for (const loc of locations) {
        const tiploc = loc.tpl || loc['@tpl'] || loc['sm:tpl'] || loc['ct:tpl'];
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

        // Extract times — attributes may be plain, @-prefixed, or namespace-prefixed
        const wta = loc.wta || loc['@wta'] || loc['sm:wta'] || loc['ct:wta'];
        const wtd = loc.wtd || loc['@wtd'] || loc['sm:wtd'] || loc['ct:wtd'];
        const wtp = loc.wtp || loc['@wtp'] || loc['sm:wtp'] || loc['ct:wtp'];

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

  return { found, inserted, skipped };
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
