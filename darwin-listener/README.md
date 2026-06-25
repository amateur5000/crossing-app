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
