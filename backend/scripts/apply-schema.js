// Applique database/schema.sql sur la base configurée dans backend/.env
// Usage : node scripts/apply-schema.js
// Le script est idempotent : il peut être relancé sans risque.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Charge backend/.env sans dépendance externe
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

const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
// Supprime le BOM UTF-8 éventuel (PostgreSQL le rejette : syntax error)
const sql = fs.readFileSync(schemaPath, "utf8").replace(/^﻿/, "");

const useSsl =
  process.env.PGSSL === "require" || DATABASE_URL.includes("supabase");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log("Schéma appliqué. Tables :");
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
