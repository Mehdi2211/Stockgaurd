// Reset complet de la base : supprime TOUTES les tables/types du schéma
// public, puis réapplique database/schema.sql (état propre + migrations
// déjà consolidées dans schema.sql).
//
// Usage : node scripts/reset-db.js
// ATTENTION : efface définitivement TOUTES les données de l'application.

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

const useSsl =
  process.env.PGSSL === "require" || DATABASE_URL.includes("supabase");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

// Suppression EXHAUSTIVE : toutes les tables et tous les types enum du
// schéma public (couvre product_scans et tout ancien schéma résiduel).
// Les tables financières sont append-only (triggers) mais DROP TABLE est
// du DDL : les triggers ne s'opposent pas à la suppression.
const DROP_SQL = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;

  FOR r IN
    SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
END $$;
`;

async function main() {
  const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8").replace(/^﻿/, "");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(DROP_SQL);
    console.log("Anciennes tables et types supprimés.");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("schema.sql appliqué.");

    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log("Tables :");
    rows.forEach((r) => console.log(" -", r.table_name));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("ERREUR :", err.message);
  process.exit(1);
});
