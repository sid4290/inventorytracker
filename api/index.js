const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const db = openDatabase(process.env.DB_FILE || '/tmp/inventory.db');

module.exports = createApp(db);