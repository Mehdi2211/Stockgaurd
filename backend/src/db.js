const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// =====================================================================
// Gestionnaire de connexions multi-boutique.
//
// Une boutique = un code = une base de données. Le mapping
// `code -> URL de base` vit dans backend/shops.json (édité à chaque
// vente / ajout de client). Si un code est absent du registre, on
// retombe sur DATABASE_URL (mode mono-boutique, dev et tests).
//
// Format de shops.json (clés en MAJUSCULES) :
//   {
//     "HK221105": { "name": "Kiosque Chez Ali", "databaseUrl": "postgres://..." },
//     "OTHER123": "postgres://..."          // forme courte acceptée
//   }
// =====================================================================

const REGISTRY_PATH =
  process.env.SHOPS_CONFIG || path.join(__dirname, "..", "shops.json");
const DEFAULT_URL = process.env.DATABASE_URL;

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch (err) {
    console.error("[db] shops.json illisible :", err.message);
    return {};
  }
}

const registry = loadRegistry();

// Résout l'URL de la base pour un code boutique donné. Retourne
// DATABASE_URL si le code est absent (aucune exception : la sécurité
// repose sur le PIN, un code inconnu ne donne accès à rien).
function resolveDatabaseUrl(code) {
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  const entry = key ? registry[key] : null;
  if (entry) {
    const url = typeof entry === "string" ? entry : entry.databaseUrl;
    if (url) return url;
  }
  return DEFAULT_URL;
}

// Un pool par URL de base (créé à la demande, réutilisé ensuite).
const pools = new Map();

function createPool(url) {
  const useSsl =
    process.env.PGSSL === "require" || (url || "").includes("supabase");
  const p = new Pool({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX) || 10,      // connexions simultanées
    idleTimeoutMillis: 30_000,                        // libère les inactives
    connectionTimeoutMillis: 10_000,                  // échec rapide si base down
    statement_timeout: 15_000,                        // requête trop longue coupée
  });
  // Une erreur sur un client inactif ne doit jamais faire crasher le process.
  p.on("error", (err) => console.error("Erreur pool PostgreSQL :", err));
  return p;
}

function getPoolByUrl(url) {
  if (!url) {
    throw new Error("Aucune base de données configurée (DATABASE_URL ou shops.json).");
  }
  if (!pools.has(url)) pools.set(url, createPool(url));
  return pools.get(url);
}

// Base par défaut : hors registre (dev, mono-boutique, tests).
function getDefaultPool() {
  return getPoolByUrl(DEFAULT_URL);
}

// Base de la boutique `code` (registre) sinon base par défaut.
function getPoolForCode(code) {
  return getPoolByUrl(resolveDatabaseUrl(code));
}

// Fermeture propre de tous les pools (Ctrl+C / arrêt du process).
async function shutdown() {
  for (const p of pools.values()) {
    try { await p.end(); } catch { /* ignore */ }
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { getPoolForCode, getDefaultPool, resolveDatabaseUrl, registry };
