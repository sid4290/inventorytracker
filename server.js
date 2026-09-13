// Load .env without a dependency (values already in the environment win)
try { require("node:fs").readFileSync(".env","utf8").split("\n").forEach((l)=>{const m=l.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];}); } catch {}

const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');

const databaseFile = process.env.VERCEL
  ? '/tmp/inventory.db'
  : process.env.DB_FILE;
const db = openDatabase(databaseFile);
const port = Number(process.env.PORT) || 3000;
const server = createApp(db).listen(port, () => console.log(`Inventory Tracker running at http://localhost:${port}`));

// Graceful shutdown so SQLite closes cleanly under Docker / PaaS restarts
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection', err); });
