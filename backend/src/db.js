const { Pool } = require("pg");

// Supabase exige SSL ; les bases locales n'en ont pas besoin.
const useSsl =
  process.env.PGSSL === "require" ||
  (process.env.DATABASE_URL || "").includes("supabase");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (err) => console.error("Erreur pool PostgreSQL :", err));

module.exports = pool;
