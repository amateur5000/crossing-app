// ============================================================
// src/index.js
// Darwin Push Port Kafka Listener — main entry point
// Connects to the Darwin feed, filters for monitored crossings,
// and writes predictions to Supabase.
// ============================================================

import 'dotenv/config';
import { Kafka } from 'kafkajs';
import { loadCrossings } from './crossings.js';
import { parseMessage } from './parser.js';
import { processSchedule, processForecast, processDeactivated, runCleanup } from './predictions.js';

// ============================================================
// Kafka client setup
// ============================================================

const kafka = new Kafka({
  clientId: 'level-crossing-listener',
  brokers: [process.env.KAFKA_BROKER],
  ssl: true,
  sasl: {
    mechanism: 'plain',
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD
  },
  // Retry settings — reconnect automatically if connection drops
  retry: {
    initialRetryTime: 3000,
    retries: 10
  }
});

const consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID
});

// ============================================================
// Message counter for logging
// ============================================================

let messageCount = 0;
let relevantCount = 0;
const startTime = new Date();

function logStats() {
  const uptime = Math.round((new Date() - startTime) / 1000);
  console.log(`[stats] Uptime: ${uptime}s | Messages received: ${messageCount} | Relevant: ${relevantCount}`);
}

// ============================================================
// Main listener function
// ============================================================

async function startListener() {
  console.log('============================================================');
  console.log(' Darwin Level Crossing Listener — starting up');
  console.log('============================================================');

  // Step 1: Load monitored crossings from Supabase
  await loadCrossings();

  // Step 2: Connect to Kafka
  console.log(`[kafka] Connecting to ${process.env.KAFKA_BROKER}...`);
  await consumer.connect();
  console.log('[kafka] Connected successfully');

  // Step 3: Subscribe to the Darwin topic
  await consumer.subscribe({
    topic: process.env.KAFKA_TOPIC,
    fromBeginning: false  // Start from latest messages, not from the beginning
  });
  console.log(`[kafka] Subscribed to topic: ${process.env.KAFKA_TOPIC}`);
  console.log('[kafka] Listening for train messages...');
  console.log('============================================================');

  // Step 4: Process messages as they arrive
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      messageCount++;

      // Log progress every 1000 messages
      if (messageCount % 1000 === 0) {
        logStats();
      }

      try {
        // Extract the bytes field from the Kafka message value
        const raw = message.value?.toString();
        if (!raw) return;

        // Parse the outer Kafka wrapper to get the bytes field
        let outerMessage;
        try {
          outerMessage = JSON.parse(raw);
        } catch {
          return; // Skip unparseable messages
        }

        // The actual Darwin data is in the 'bytes' field as an escaped string
        const bytesField = outerMessage?.bytes;
        if (!bytesField) return;

        // Parse the Darwin Push Port message
        const records = parseMessage(bytesField);
        if (!records.length) return;

        relevantCount += records.length;

        // Process each extracted record
        for (const record of records) {
          switch (record.type) {
            case 'schedule':
              await processSchedule(record);
              break;
            case 'forecast':
              await processForecast(record);
              break;
            case 'deactivated':
              await processDeactivated(record);
              break;
          }
        }

      } catch (err) {
        console.error('[listener] Error processing message:', err.message);
        // Don't crash — log and continue
      }
    }
  });
}

// ============================================================
// Nightly cleanup scheduler
// ============================================================

function scheduleCleanup() {
  const intervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24');
  const intervalMs = intervalHours * 60 * 60 * 1000;

  console.log(`[cleanup] Scheduled to run every ${intervalHours} hours`);

  setInterval(async () => {
    await runCleanup();
  }, intervalMs);
}

// ============================================================
// Stats logger — logs every 5 minutes
// ============================================================

setInterval(logStats, 5 * 60 * 1000);

// ============================================================
// Graceful shutdown
// ============================================================

async function shutdown() {
  console.log('\n[listener] Shutting down gracefully...');
  await consumer.disconnect();
  console.log('[listener] Disconnected from Kafka');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============================================================
// Start everything
// ============================================================

scheduleCleanup();

startListener().catch(err => {
  console.error('[listener] Fatal error — could not start:', err.message);
  process.exit(1);
});
