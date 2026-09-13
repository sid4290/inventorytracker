# Inventory Tracker

The system supports BoM management, opening balance capture, stock-in and stock-out transactions, safety stock monitoring, role-based access, and automatic purchase order generation.

Self-contained web application for small-business inventory: Bill-of-Material (BoM) master records, opening-balance capture, stock-in / stock-out transactions, safety-stock monitoring and automatic purchase-order generation, with role-based access across four roles.

Built for the DPMG Group 7 project from BRD v1.1 and SDD v1.0.

**Stack:** Node.js 22 · Express 5 · EJS · SQLite (Node's built-in `node:sqlite`, no native compile) · express-session · bcryptjs.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22.5 or newer | `node -v` |
| npm | 10+ (ships with Node) | `npm -v` |
| Docker (optional, for containerised deploy) | 24+ | `docker -v` |

Install Node from https://nodejs.org (LTS) or with nvm: `nvm install 22 && nvm use 22`.

## 2. Local setup

```bash
# 1. Get the code
unzip inventory-tracker.zip && cd inventory-tracker      # or: git clone <repo> && cd inventory-tracker

# 2. Install dependencies
npm install

# 3. Create your local environment file
cp .env.example .env
# edit .env and set SESSION_SECRET to any long random string, e.g.:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. (Optional) load demo data — 6 BoMs matching the BRD §8 happy path
npm run seed

# 5. Run the test suite
npm test

# 6. Start the app
npm start            # http://localhost:3000
# or with auto-restart while developing:
npm run dev
```

Demo accounts, one per role (change these before real use — see §6):

| Username | Password | Role | Can edit / delete BoMs, review POs |
|---|---|---|---|
| staff | staff123 | Inventory Staff | no |
| manager | manager123 | Inventory Manager | yes |
| owner | owner123 | Business Owner | no |
| admin | admin123 | System Administrator | yes |

## 3. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | Set to `production` to enable secure cookies, proxy trust and generic error pages |
| `SESSION_SECRET` | dev fallback | **Required in production.** Signs session cookies |
| `DB_FILE` | `./data/inventory.db` | SQLite file path (`:memory:` for throwaway runs) |

`server.js` reads `.env` if present; real environment variables take precedence.

## 4. Project structure

```
inventory-tracker/
├── server.js                 # entry point: env loading, HTTP server, graceful shutdown
├── src/
│   ├── db.js                 # schema (User, BoM, StockTransaction, PurchaseOrder), seed users, constants
│   ├── services.js           # business logic: auth, BoM CRUD, stock engine, safety-stock monitor, auto-PO
│   └── app.js                # Express app: sessions, role middleware, routes, error handling
├── views/                    # EJS templates, one per screen
│   ├── partials/header.ejs, footer.ejs
│   ├── login.ejs, dashboard.ejs, bom-list.ejs, bom-form.ejs
│   ├── transaction.ejs, low-stock.ejs, purchase-orders.ejs
│   └── not-found.ejs, error.ejs
├── public/style.css
├── scripts/seed-demo.js      # demo data loader (idempotent)
├── test/services.test.js     # acceptance tests traced to BRD FR IDs + NFR load test
├── Dockerfile, .dockerignore, docker-compose.yml
├── .env.example, .gitignore
└── package.json
```

## 5. npm scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with file watching |
| `npm test` | 12 tests (FR acceptance criteria, NFR-07 boundaries, NFR-10 load: 1,000 BoMs / 10,000 transactions) |
| `npm run seed` | Load demo BoMs and a few stock movements |

## 6. Managing users

Users are seeded once on first start from `SEED_USERS` in `src/db.js`. To add or change accounts on an existing database:

```bash
# add a user (role must be one of the four roles)
node --no-warnings -e "
const {openDatabase}=require('./src/db'); const b=require('bcryptjs');
const db=openDatabase();
db.prepare('INSERT INTO User (username,password_hash,role) VALUES (?,?,?)').run('priya', b.hashSync('S3cure!pass',10), 'Inventory Manager');
console.log('added');"

# change a password
node --no-warnings -e "
const {openDatabase}=require('./src/db'); const b=require('bcryptjs');
openDatabase().prepare('UPDATE User SET password_hash=? WHERE username=?').run(b.hashSync('NewPass!23',10),'admin');
console.log('updated');"
```

Passwords are stored as bcrypt hashes only (NFR-06).

## 7. Deployment

### 7a. Docker (recommended)

```bash
# build and run in one step; data persists in a named volume
echo "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env
docker compose up -d --build

docker compose logs -f app        # follow logs
docker compose exec app node --no-warnings scripts/seed-demo.js   # optional demo data
docker compose down               # stop (data volume is kept)
```

Without compose:

```bash
docker build -t inventory-tracker .
docker run -d --name inventory -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v inventory-data:/app/data \
  inventory-tracker
```

Health check: `curl http://localhost:3000/health` → `{"status":"ok"}`.

### 7b. Plain VPS (Ubuntu) with pm2

```bash
# on the server
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2
git clone <repo> /opt/inventory-tracker && cd /opt/inventory-tracker
npm ci --omit=dev
cp .env.example .env && nano .env      # set NODE_ENV=production and SESSION_SECRET
pm2 start server.js --name inventory --node-args="--no-warnings"
pm2 save && pm2 startup                # restart on reboot
```

Put nginx (or Caddy) in front for HTTPS; the app trusts one proxy hop when `NODE_ENV=production`:

```nginx
server {
  listen 80; server_name inventory.example.com;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
}
```
Then `sudo certbot --nginx -d inventory.example.com`.

### 7c. PaaS (Render / Railway / Fly.io)

- Deploy from the Dockerfile.
- Set env vars `NODE_ENV=production`, `SESSION_SECRET`, `DB_FILE=/app/data/inventory.db`.
- Attach a persistent disk mounted at `/app/data` (SQLite needs a writable, persistent path; ephemeral filesystems lose data on redeploy).
- Health-check path: `/health`.

### 7d. Vercel

Import the GitHub repository into Vercel with the project root set to this directory. Set `NODE_ENV=production` and a strong `SESSION_SECRET` in the Vercel project environment variables, then deploy. Vercel uses `api/index.js` as the Express function.

SQLite data on Vercel is temporary and may be reset when the function is recreated. Use a persistent database service for production data.

### 7e. Backups

The whole database is one file:

```bash
# safe hot copy using SQLite's backup API
node --no-warnings -e "require('./src/db').openDatabase().exec(\"VACUUM INTO 'backup-$(date +%F).db'\")"
```

## 8. Design decisions (v1.0 assumptions from SDD §8C)

- Storage: SQLite. Verified by the load test at 1,000 BoMs / 10,000 transactions.
- Reorder quantity: fixed `FIXED_REORDER_QTY = 100` (`src/db.js`), or the shortfall if larger.
- Purchase-order workflow: review → confirm. One open PO per BoM; a new one is generated only after the previous is reviewed.
- Categories: predefined list `CATEGORIES` in `src/db.js`.
- Low stock: `current_balance <= safety_stock_level`.
- Balances change only via stock transactions; Edit BoM shows balance read-only (NFR-05). Negative balances are blocked in code and by a database CHECK (NFR-07).
- Sessions are in-memory (single-instance, single-user v1.0). Restarting the server logs everyone out. For multiple instances, swap in a persistent session store such as `connect-sqlite3`.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `SESSION_SECRET must be set in production` | Add it to `.env` or the environment |
| `ExperimentalWarning: SQLite` | Harmless on Node 22; scripts pass `--no-warnings` |
| `Cannot find module 'node:sqlite'` | Upgrade Node to 22.5+ |
| Login works but cookie is dropped behind HTTPS proxy | Ensure `NODE_ENV=production` and the proxy sends `X-Forwarded-Proto` |
| Database locked | Only one app instance may write the SQLite file; don't run two containers on the same volume |

## 10. Out of scope (BRD §3)

Online payment/billing, supplier and purchase-order *management*, barcode/hardware integration, bulk data import (deferred per SDD §8A).
