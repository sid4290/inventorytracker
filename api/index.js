const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const databaseFile = process.env.DB_FILE && process.env.DB_FILE.startsWith('/tmp/')
	? process.env.DB_FILE
	: '/tmp/inventory.db';
const db = openDatabase(databaseFile);

module.exports = createApp(db);