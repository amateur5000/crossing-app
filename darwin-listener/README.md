# Darwin Level Crossing Listener

A Node.js service that connects to the Darwin Push Port Kafka feed,
filters for trains passing monitored level crossings, and writes
predictions to Supabase.

## Files

```
darwin-listener/
├── src/
│   ├── index.js        — Main entry point, Kafka connection
│   ├── parser.js       — Parses Darwin Push Port v18 messages
│   ├── crossings.js    — Loads monitored crossings from Supabase
│   ├── predictions.js  — Writes predictions to Supabase
│   └── supabase.js     — Supabase client
├── package.json
├── .env.example        — Copy to .env for local testing
└── .gitignore
```

## How to add these files to GitHub

1. Go to your `crossing-app` repository on github.com
2. Create a new folder called `darwin-listener` by clicking
   **Add file → Create new file** and typing `darwin-listener/package.json`
3. Paste the contents of each file and commit
4. Repeat for each file, keeping the same folder structure

## How to deploy to Render.com

1. Go to render.com and sign up using your GitHub account
2. Click **New** and select **Background Worker** (not Web Service — the listener runs continuously without serving web requests)
3. Select your **crossing-app** GitHub repository
4. Configure the service:
   - **Name:** darwin-listener
   - **Root Directory:** darwin-listener
   - **Runtime:** Node
   - **Build Command:** npm install
   - **Start Command:** npm start
5. Click **Add Environment Variable** and add each of the following:

```
KAFKA_BROKER=pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092
KAFKA_USERNAME=4ATNMQ3EQLZLPV3L
KAFKA_PASSWORD=cfltMUIDZlyHZnJ3SOk7JAc7lpN+Hbxc/83E++XBfBFPWvn5RluNt5pPJy6Iv/8Q
KAFKA_TOPIC=prod-1010-Darwin-Train-Information-Push-Port-IIII2_0_JSON
KAFKA_GROUP_ID=SC-2d2fea06-7789-411e-9f93-f36c4effce5d
SUPABASE_URL=https://wkilfbehissmcsmkqxrt.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndraWxmYmVoaXNzbWNzbWtxeHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzOTc0MTAsImV4cCI6MjA5Nzk3MzQxMH0.46zZRWiIXJ3NuQObQabMBXSZjKy_kZ0OtKwqkqbAy_c
CLEANUP_INTERVAL_HOURS=24
LOG_LEVEL=info
```

6. Click **Create Background Worker** — Render will build and deploy automatically
7. Watch the logs — you should see:
   - "Loaded 1 crossing-station mappings across 1 CRS codes"
   - "Monitoring CRS codes: MTL"
   - "Connected successfully"
   - "Listening for train messages..."
   - Then prediction updates appearing as trains are detected

Note: Render's background worker plan is ~$7/month. It runs continuously and restarts automatically if the service crashes.

## What to expect in the logs

Normal operation looks like:
```
[crossings] Loaded 1 crossing-station mappings across 1 CRS codes
[crossings] Monitoring CRS codes: MTL
[kafka] Connecting to pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092...
[kafka] Connected successfully
[kafka] Subscribed to topic: prod-1010-Darwin-Train-Information-Push-Port-IIII2_0_JSON
[kafka] Listening for train messages...
[predictions] Schedule: train 202506250012345 at Mortlake — scheduled 2026-06-25T08:15:00.000Z
[predictions] Updated: train 202506250012345 at Mortlake — predicted 2026-06-25T08:16:30.000Z (delayed)
[stats] Uptime: 300s | Messages received: 4821 | Relevant: 12
```

## Checking the data in Supabase

Once running, go to your Supabase dashboard → Table Editor → predictions
You should start seeing rows appearing within a few minutes.

## Important notes

- The listener runs continuously — Render.com keeps it alive automatically
- If it crashes, Render.com restarts it automatically
- The `.env` file should NEVER be committed to GitHub (it's in .gitignore)
- All secrets are stored as Render.com environment variables instead
