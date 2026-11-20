// Tests d'intégration : authentification réelle (login), boutique,
// produits, scans — et ISOLATION par shop_id.
// Usage : node scripts/test-auth-products-scans.js   (backend démarré)
//
// Aucun jeton n'est fabriqué à la main : tous les jetons proviennent de
// POST /api/auth/login. Crée une 2e boutique de test pour vérifier
// l'isolation et laisse les données en base (comme les autres tests).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

const BASE = process.env.API_BASE || "http://localhost:4000/api";
const SHOP_CODE = process.env.SEED_SHOP_CODE || "SGDEMO01";
const OWNER_PIN = process.env.SEED_OWNER_PIN || "1234";
const CASHIER_PIN = process.env.SEED_CASHIER_PIN || "1234";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS", label); }
  else { fail++; console.log("  FAIL", label); }
}
async function api(token, method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const login = (body) => api(null, "POST", "/auth/login", body);

(async () => {
  console.log("== Authentification (login réel) ==");
  let r = await login({ code: SHOP_CODE, pin: OWNER_PIN, role: "OWNER" });
  ok(r.status === 200 && r.data.user?.role === "OWNER", "OWNER se connecte (code + PIN)");
  const ownerTok = r.data.token;
  const ownerShopId = r.data.shop?.id;

  r = await login({ code: SHOP_CODE, pin: CASHIER_PIN, role: "CASHIER" });
  ok(r.status === 200 && r.data.user?.role === "CASHIER", "CASHIER se connecte (code + PIN)");
  const cashierTok = r.data.token;

  r = await login({ code: SHOP_CODE, pin: "9999", role: "OWNER" });
  ok(r.status === 401, "Mauvais PIN propriétaire refusé (401)");
  r = await login({ code: SHOP_CODE, role: "OWNER" });
  ok(r.status === 400, "PIN manquant refusé (400)");
  r = await login({ code: SHOP_CODE, pin: OWNER_PIN, role: "ADMIN" });
  ok(r.status === 400, "Rôle inconnu refusé (400)");
  r = await login({ code: "ZZZZZZ", pin: CASHIER_PIN, role: "CASHIER" });
  ok(r.status === 401, "Code boutique inconnu refusé (401)");

  console.log("== Boutique ==");
  r = await api(ownerTok, "GET", "/shop/me");
  ok(r.status === 200 && r.data.shop?.code === SHOP_CODE, "GET /shop/me renvoie la boutique du jeton");
  r = await api(null, "GET", "/shop/me");
  ok(r.status === 401, "GET /shop/me sans jeton (401)");

  console.log("== Produits ==");
  r = await api(cashierTok, "GET", "/products");
  ok(r.status === 200 && Array.isArray(r.data.products) && r.data.products.length > 0,
    "CASHIER liste les produits");
  const known = r.data.products[0];
  ok(typeof known?.price === "number", "Le prix est un entier (millimes)");

  r = await api(cashierTok, "GET", `/products/barcode/${known.barcode}`);
  ok(r.status === 200 && r.data.product?.id === known.id, "Recherche produit par code-barres");

  r = await api(cashierTok, "POST", "/products", { name: "Test", price: 100 });
  ok(r.status === 403, "CASHIER ne peut pas créer un produit (403)");

  const newBarcode = "TEST" + crypto.randomInt(1000000, 9999999);
  r = await api(ownerTok, "POST", "/products", { name: "Produit test", price: 1500, barcode: newBarcode, category: "Test", buyPrice: 1000, initialStock: 7 });
  ok(r.status === 201 && r.data.product?.barcode === newBarcode, "OWNER crée un produit");
  const newProductId = r.data.product?.id;

  r = await api(ownerTok, "POST", "/products", { name: "Doublon", price: 100, barcode: newBarcode });
  ok(r.status === 409, "Code-barres déjà utilisé (409)");

  console.log("== Scans ==");
  r = await api(cashierTok, "POST", "/scans", { barcode: known.barcode });
  ok(r.status === 201 && r.data.status === "matched" && r.data.product?.id === known.id,
    "Scan d'un code connu -> matched + produit");
  ok(r.data.scan?.quantity === 1, "Quantité par défaut = 1");

  r = await api(cashierTok, "POST", "/scans", { barcode: "0000000000999" });
  ok(r.status === 201 && r.data.status === "unknown" && r.data.product === null,
    "Scan d'un code inconnu -> unknown, product null");

  r = await api(cashierTok, "POST", "/scans", { barcode: "" });
  ok(r.status === 400, "Code-barres vide refusé (400)");

  r = await api(cashierTok, "GET", "/scans?limit=10");
  ok(r.status === 200 && Array.isArray(r.data.scans) && r.data.scans.length >= 2,
    "GET /scans renvoie l'historique");
  r = await api(cashierTok, "GET", "/scans?status=unknown");
  ok(r.status === 200 && r.data.scans.every((s) => s.status === "unknown"),
    "Filtre par statut (unknown)");

  console.log("== Stock ==");
  r = await api(ownerTok, "GET", "/stock/movements?productId=" + newProductId);
  ok(r.status === 200 && r.data.movements.some((m) => m.type === "INITIAL"),
    "Mouvement INITIAL présent pour le nouveau produit");

  r = await api(cashierTok, "POST", "/stock/adjustment", { productId: newProductId, quantity: -1, reason: "Casse test" });
  ok(r.status === 403, "CASHIER ne peut pas ajuster le stock (403)");
  r = await api(ownerTok, "POST", "/stock/adjustment", { productId: newProductId, quantity: -1, reason: "Casse test" });
  ok(r.status === 201 && r.data.movement?.quantity === -1, "OWNER ajuste le stock (-1)");

  console.log("== Tableau de bord ==");
  r = await api(ownerTok, "GET", "/owner/stats");
  ok(r.status === 200 && typeof r.data.activeProducts === "number", "GET /owner/stats (OWNER)");
  r = await api(cashierTok, "GET", "/owner/stats");
  ok(r.status === 403, "GET /owner/stats refusé au CASHIER (403)");

  console.log("== Isolation par shop_id ==");
  // 2e boutique indépendante + propriétaire, avec PIN hashé.
  const code2 = "TST" + crypto.randomInt(100000, 999999);
  const shop2 = (await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1, $2) RETURNING id`,
    [`Test isolation ${Date.now()}`, code2]
  )).rows[0];
  const email2 = `owner-${Date.now()}@iso.local`;
  await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
     VALUES ($1, 'Owner Iso', 'OWNER', $2, $3)`,
    [shop2.id, email2, await bcrypt.hash("2468", 8)]
  );
  r = await login({ code: code2, pin: "2468", role: "OWNER" });
  ok(r.status === 200, "OWNER de la 2e boutique se connecte (PIN)");
  const isoTok = r.data.token;

  r = await api(isoTok, "GET", "/products");
  ok(r.status === 200 && r.data.products.length === 0, "La 2e boutique ne voit AUCUN produit de la 1re");

  r = await api(isoTok, "GET", `/products/barcode/${known.barcode}`);
  ok(r.status === 404, "Produit de la 1re boutique invisible (404) pour la 2e");

  r = await api(isoTok, "POST", "/scans", { barcode: known.barcode });
  ok(r.status === 201 && r.data.status === "unknown" && r.data.product === null,
    "Scan d'un code d'une autre boutique -> unknown (isolation)");

  r = await api(isoTok, "GET", "/scans");
  ok(r.status === 200 && r.data.scans.length === 1 && r.data.scans[0].barcode === known.barcode,
    "La 2e boutique ne voit QUE ses propres scans");

  r = await api(isoTok, "GET", "/shop/me");
  ok(r.status === 200 && r.data.shop?.id === shop2.id, "Le shop_id vient bien du jeton");

  console.log(`\n=== Résultat : ${pass} PASS, ${fail} FAIL ===`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
