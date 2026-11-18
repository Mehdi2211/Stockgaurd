// Applique une migration SQL idempotente sur la base.
// Usage : node scripts/apply-migration.js <nom-du-fichier.sql>
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["'"'"']|["'"'"']$/g, "");
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERREUR : DATABASE_URL manquant dans backend/.env");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/apply-migration.js <fichier.sql>");
  process.exit(1);
}
const sqlPath = path.join(__dirname, "..", "..", "database", "migrations", file);
if (!fs.existsSync(sqlPath)) {
  console.error("Fichier introuvable :", sqlPath);
  process.exit(1);
}

const useSsl = process.env.PGSSL === "require" || DATABASE_URL.includes("supabase");
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const client = await pool.connect();
  try {
    const sql = fs.readFileSync(sqlPath, "utf8").replace(/^﻿/, "");
    await client.query(sql);
    console.log("Migration appliquee :", file);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error("ERREUR migration :", e.message);
  process.exit(1);
});
