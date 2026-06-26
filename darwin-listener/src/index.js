// ============================================================
// src/index.js
// Darwin Push Port Kafka Listener — main entry point
// ============================================================

import 'dotenv/config';
import { Kafka } from 'kafkajs';
import { loadCrossings } from './crossings.js';
import { parseMessage } from './parser.js';
import { processPrediction, processDeactivated, runCleanup } from './predictions.js';

const kafka = new Kafka({
  clientId: 'level-crossing-listener',
  brokers: [process.env.KAFKA_BROKER],
  ssl: true,
  sasl: {
    mechanism: 'plain',
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD
  },
  retry: {
    initialRetryTime: 3000,
    retries: 10
  }
});

const consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID
});

let messageCount = 0;
let relevantCount = 0;
const startTime = new Date();

function logStats() {
  const uptime = Math.round((new Date() - startTime) / 1000);
  console.log(`[stats] Uptime: ${uptime}s | Messages received: ${messageCount} | Relevant: ${relevantCount}`);
}

async function startListener() {
  console.log('============================================================');
  console.log(' Darwin Level Crossing Listener — starting up');
  console.log('============================================================');

  await loadCrossings();

  console.log(`[kafka] Connecting to ${process.env.KAFKA_BROKER}...`);
  await consumer.connect();
  console.log('[kafka] Connected successfully');

  await consumer.subscribe({
    topic: process.env.KAFKA_TOPIC,
    fromBeginning: false
  });
  console.log(`[kafka] Subscribed to topic: ${process.env.KAFKA_TOPIC}`);
  console.log('[kafka] Listening for train messages...');
  console.log('============================================================');

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      messageCount++;

      if (messageCount % 1000 === 0) {
        logStats();
      }

      try {
        const raw = message.value?.toString();
        if (!raw) return;

        let outerMessage;
        try {
          outerMessage = JSON.parse(raw);
        } catch {
          return;
        }

        const bytesField = outerMessage?.bytes;
        if (!bytesField) return;

        const records = parseMessage(bytesField);
        if (!records.length) return;

        relevantCount += records.length;

        for (const record of records) {
          if (record.type === 'deactivated') {
            await processDeactivated(record);
          } else {
            await processPrediction(record);
          }
        }

      } catch (err) {
        console.error('[listener] Error processing message:', err.message);
      }
    }
  });
}

function scheduleCleanup() {
  const intervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24');
  const intervalMs = intervalHours * 60 * 60 * 1000;
  console.log(`[cleanup] Scheduled to run every ${intervalHours} hours`);
  setInterval(async () => {
    await runCleanup();
  }, intervalMs);
}

setInterval(logStats, 5 * 60 * 1000);

async function shutdown() {
  console.log('\n[listener] Shutting down gracefully...');
  await consumer.disconnect();
  console.log('[listener] Disconnected from Kafka');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

scheduleCleanup();

startListener().catch(err => {
  console.error('[listener] Fatal error — could not start:', err.message);
  process.exit(1);
});
