// Supprime toutes les tables/types de l'app (ancien schéma incompatible)
// puis applique database/schema.sql. Usage : node scripts/reset-db.js
// ATTENTION : efface toutes les données des tables listées.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERREUR : DATABASE_URL manquant dans backend/.env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DROP_SQL = `
DROP TABLE IF EXISTS
  cash_verifications, cash_movements, audit_log, credits,
  stock_movements, sale_lines, sales, customers, products,
  app_users, shops
CASCADE;
DROP TYPE IF EXISTS
  cash_movement_type, movement_type, customer_status, user_role
CASCADE;
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(DROP_SQL);
    console.log("Anciennes tables et types supprimés.");

    const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8").replace(/^﻿/, "");
    await client.query(sql);
    console.log("schema.sql appliqué.");

    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log("Tables :");
    rows.forEach((r) => console.log(" -", r.table_name));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("ERREUR :", err.message);
  process.exit(1);
});
