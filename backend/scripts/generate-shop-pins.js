// =====================================================================
// Génère automatiquement les PIN d'accès (administrateur + caissier) pour
// les boutiques, crée les comptes manquants, et exporte un récapitulatif
// destiné AU DÉVELOPPEUR UNIQUEMENT (fichier non versionné).
//
// Rappel du modèle : une boutique = un code = une base de données.
// Le code boutique détermine la base à interroger (voir src/db.js).
// Le shop_id généré par l'INSERT dans `shops` cloisonne toutes les autres
// tables (produits, ventes, crédits...) — c'est LUI le détermineur.
//
// Les PIN sont hashés (bcrypt) avant insertion dans app_users.pin_hash.
// Le fichier de sortie contient les PIN EN CLAIR : ne JAMAIS le commiter.
//
// Usage :
//   node scripts/generate-shop-pins.js                 # boutiques sans AUCUN compte
//   node scripts/generate-shop-pins.js --all           # toutes les boutiques
//   node scripts/generate-shop-pins.js HK221105 AB1234 # boutiques ciblées par code
//
// Sortie : backend/shop-credentials.csv (code, nom, pin_admin, pin_caissier)
//   - pin_admin   = rôle OWNER   (onglet « Propriétaire »)
//   - pin_caissier= rôle CASHIER (onglet « Caissier »)
// Les comptes déjà existants ne sont PAS modifiés : leur PIN est indiqué
// « (existant) » (un PIN hashé ne peut pas être relu).
// =====================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

// --- Chargement de backend/.env (comme les autres scripts) ---
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;
const OUT_PATH = path.join(__dirname, "..", "shop-credentials.csv");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
});

// PIN à 4 chiffres, sans séquence triviale (0000, 1111, ...).
function randomPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    if (!/^(\d)\1{3}$/.test(pin)) return pin;
  }
}

// Échappe une valeur pour un CSV.
function csv(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Crée le compte du rôle demandé s'il n'existe pas, avec un PIN généré.
// Retourne le PIN en clair (nouveau compte) ou "(existant)".
async function ensureUser(shop, role) {
  const { rows } = await pool.query(
    `SELECT id FROM app_users WHERE shop_id = $1 AND role = $2 LIMIT 1`,
    [shop.id, role]
  );
  if (rows.length > 0) return "(existant)";

  const pin = randomPin();
  const hash = await bcrypt.hash(pin, ROUNDS);

  if (role === "OWNER") {
    // Contrainte 010 : un OWNER doit avoir un email + un identifiant (PIN).
    await pool.query(
      `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
       VALUES ($1, $2, 'OWNER', $3, $4)`,
      [shop.id, "Propriétaire", `owner+${shop.code.toLowerCase()}@stockguard.local`, hash]
    );
  } else {
    await pool.query(
      `INSERT INTO app_users (shop_id, name, role, pin_hash)
       VALUES ($1, $2, 'CASHIER', $3)`,
      [shop.id, "Caissier", hash]
    );
  }
  return pin;
}

(async () => {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const codes = args
    .filter((a) => !a.startsWith("--"))
    .map((c) => c.trim().toUpperCase());

  let shops;
  if (codes.length) {
    shops = (
      await pool.query(
        `SELECT id, name, code FROM shops WHERE code = ANY($1::text[]) ORDER BY code`,
        [codes]
      )
    ).rows;
    const found = new Set(shops.map((s) => s.code));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length) console.log(`⚠ Codes introuvables : ${missing.join(", ")}`);
  } else if (all) {
    shops = (await pool.query(`SELECT id, name, code FROM shops ORDER BY code`)).rows;
  } else {
    // Par défaut : uniquement les boutiques n'ayant AUCUN compte
    // (typiquement une boutique fraîchement créée en SQL).
    shops = (
      await pool.query(
        `SELECT s.id, s.name, s.code FROM shops s
          WHERE NOT EXISTS (SELECT 1 FROM app_users u WHERE u.shop_id = s.id)
          ORDER BY s.code`
      )
    ).rows;
  }

  if (shops.length === 0) {
    console.log("Aucune boutique à traiter. (Ciblez un code ou utilisez --all.)");
    await pool.end();
    return;
  }

  const rows = [];
  for (const shop of shops) {
    const pinAdmin = await ensureUser(shop, "OWNER");
    const pinCashier = await ensureUser(shop, "CASHIER");
    rows.push({ code: shop.code, nom: shop.name, pinAdmin, pinCashier });
    console.log(`${shop.code}  ${shop.name}  admin=${pinAdmin}  caissier=${pinCashier}`);
  }

  const header = "code,nom,pin_admin,pin_caissier";
  const needsHeader = !fs.existsSync(OUT_PATH) || fs.statSync(OUT_PATH).size === 0;
  const lines = rows.map((r) => [r.code, csv(r.nom), r.pinAdmin, r.pinCashier].join(","));
  fs.appendFileSync(
    OUT_PATH,
    (needsHeader ? header + "\n" : "") + lines.join("\n") + "\n"
  );

  console.log(`\n${rows.length} boutique(s) traitée(s).`);
  console.log(`Récapitulatif (À GARDER PRIVÉ) : ${OUT_PATH}`);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
