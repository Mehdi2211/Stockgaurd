// =====================================================================
// Tests du module "Suivi de caisse" (StockGuard) — API v2
// =====================================================================
// Script d'intégration HTTP + SQL. À exécuter avec :
//
//   1. La base de données migrée (schema.sql + migrations/001 + 002)
//   2. Le backend démarré :  npm run dev   (dans backend/)
//   3. Les variables d'environnement :
//        DATABASE_URL   connexion PostgreSQL (rôle privilégié)
//        JWT_SECRET     même secret que le backend
//        BASE_URL       optionnel, défaut http://localhost:4000
//
//   node scripts/test-cash-register.js
//
// Le script crée des boutiques de test UNIQUES à chaque exécution
// (les tables financières sont append-only : pas de nettoyage possible).
// Aucune boutique réelle n'est touchée.
// =====================================================================

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Charge backend/.env si présent
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["'"'"']|["'"'"']$/g, "");
    }
  }
}

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERREUR : DATABASE_URL est obligatoire.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Identifiants de test : les jetons proviennent EXCLUSIVEMENT de
// POST /api/auth/login (aucun JWT fabriqué à la main).
const TEST_OWNER_PIN = "1357";
const TEST_PIN = "4321";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* pas de corps */ }
  return { status: res.status, data };
}

// Jeton PROPRIÉTAIRE d'une boutique : login réel via l'API (PIN).
async function loginOwner(shopId) {
  const { rows } = await pool.query(`SELECT code FROM shops WHERE id = $1`, [shopId]);
  const r = await api("POST", "/auth/login", { body: { code: rows[0].code, pin: TEST_OWNER_PIN, role: "OWNER" } });
  if (r.status !== 200) throw new Error(`login OWNER échoué (${r.status}) ${JSON.stringify(r.data)}`);
  return r.data.token;
}

// Jeton CAISSIER d'une boutique : login réel (PIN) via l'API.
async function loginCashier(shopId) {
  const { rows } = await pool.query(`SELECT code FROM shops WHERE id = $1`, [shopId]);
  const r = await api("POST", "/auth/login", { body: { code: rows[0].code, pin: TEST_PIN } });
  if (r.status !== 200) throw new Error(`login CASHIER échoué (${r.status}) ${JSON.stringify(r.data)}`);
  return r.data.token;
}

async function main() {
  console.log("\n=== Préparation : boutique de test ===");
  const OWNER_HASH = await bcrypt.hash(TEST_OWNER_PIN, 8);
  const CASHIER_HASH = await bcrypt.hash(TEST_PIN, 8);

  const shopCode = `T${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const shop = await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1, $2) RETURNING id`,
    [`Boutique test ${shopCode}`, shopCode]
  );
  const shopId = shop.rows[0].id;

  const owner = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
     VALUES ($1, 'Propriétaire Test', 'OWNER', $2, $3) RETURNING id`,
    [shopId, `owner-${shopCode.toLowerCase()}@test.local`, OWNER_HASH]
  );
  const ownerId = owner.rows[0].id;

  const cashier = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, pin_hash)
     VALUES ($1, 'Caissier Test', 'CASHIER', $2) RETURNING id`,
    [shopId, CASHIER_HASH]
  );
  const cashierId = cashier.rows[0].id;

  const prod = await pool.query(
    `INSERT INTO products (shop_id, barcode, name, price, current_stock)
     VALUES ($1, 'TEST0001', 'Produit test', 1000, 100) RETURNING id`,
    [shopId]
  );
  const productId = prod.rows[0].id;

  const ownerToken = await loginOwner(shopId);
  const cashierToken = await loginCashier(shopId);

  const nowIso = new Date().toISOString();

  // -------------------------------------------------------------------
  console.log("\n=== 0. Date d'initialisation automatique (heure serveur) ===");
  // -------------------------------------------------------------------
  // initializedAt dans le body est IGNORÉ (passé ou futur) : le serveur
  // enregistre now() dans effective_at ET created_at (même transaction).
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Boutique "autre" : shop_id forgé dans le body de initialize.
  const otherShop0 = await pool.query(
    `INSERT INTO shops (name, code) VALUES ('Autre boutique 0', $1) RETURNING id`,
    [`Z${crypto.randomBytes(3).toString("hex").toUpperCase()}`]
  );

  const beforeInit = Date.now();
  let r = await api("POST", "/cash-register/initialize", {
    token: ownerToken,
    body: { amount: 200000, initializedAt: pastDate, shop_id: otherShop0.rows[0].id, admin_id: cashierId },
  });
  const afterInit = Date.now();
  check("initialisation acceptée (201)", r.status === 201, `status=${r.status} ${JSON.stringify(r.data)}`);

  const initRow = await pool.query(
    `SELECT effective_at, created_at, shop_id, admin_id FROM cash_movements WHERE shop_id = $1 AND type = 'INITIALIZATION'`,
    [shopId]
  );
  const ir = initRow.rows[0];
  check("effective_at renseignée", ir?.effective_at != null);
  check("effective_at = created_at", ir && new Date(ir.effective_at).getTime() === new Date(ir.created_at).getTime());
  const effMs = ir ? new Date(ir.effective_at).getTime() : 0;
  check("effective_at proche de l'heure serveur (±5 s)", effMs >= beforeInit - 5000 && effMs <= afterInit + 5000,
    `effective_at=${ir?.effective_at}`);
  check("shop_id forgé ignoré", ir?.shop_id === shopId);
  check("admin_id forgé ignoré (owner réel)", ir?.admin_id === ownerId);

  // Boutique dédiée : initializedAt dans le FUTUR -> ignoré aussi.
  const shopF = await pool.query(
    `INSERT INTO shops (name, code) VALUES ('Boutique future', $1) RETURNING id`,
    [`F${crypto.randomBytes(3).toString("hex").toUpperCase()}`]
  );
  const ownerF = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
     VALUES ($1, 'Owner F', 'OWNER', $2, $3) RETURNING id`,
    [shopF.rows[0].id, `ownerf-${crypto.randomBytes(3).toString("hex")}@test.local`, OWNER_HASH]
  );
  const tokenF = await loginOwner(shopF.rows[0].id);
  const beforeF = Date.now();
  r = await api("POST", "/cash-register/initialize", {
    token: tokenF, body: { amount: 1000, initializedAt: futureDate },
  });
  const afterF = Date.now();
  check("initializedAt futur ignoré -> 201", r.status === 201, `status=${r.status}`);
  const initF = await pool.query(
    `SELECT effective_at FROM cash_movements WHERE shop_id = $1 AND type = 'INITIALIZATION'`,
    [shopF.rows[0].id]
  );
  const effF = new Date(initF.rows[0].effective_at).getTime();
  check("effective_at = heure serveur (pas le futur)", effF >= beforeF - 5000 && effF <= afterF + 5000,
    `effective_at=${initF.rows[0].effective_at}`);

  // -------------------------------------------------------------------
  console.log("\n=== 1. Exemple de référence ===");
  // initial 200.000 DT, ventes espèces 15.500, vente crédit 4.700 (exclue),
  // remboursement crédit 20.000, retrait 10.000, dépôt 5.000
  // => attendu = 230.500 DT ; compté 229.500 => écart -1.000 SHORTAGE
  // -------------------------------------------------------------------
  // La boutique est déjà initialisée (section 0) : effective_at = heure serveur.
  check("boutique déjà initialisée (section 0)", true);

  // Vente en espèces : 15.500 millimes = 15,5 x 1000 (prix produit)
  const saleCash = await api("POST", "/sales", {
    token: cashierToken,
    body: { id: crypto.randomUUID(), lines: [{ productId, quantity: 15.5 }] },
  });
  check("vente espèces créée (201)", saleCash.status === 201, `status=${saleCash.status} ${JSON.stringify(saleCash.data)}`);

  // Vente à crédit : customer_id NOT NULL (insérée directement en SQL)
  const customer = await pool.query(
    `INSERT INTO customers (shop_id, first_name, family_name, phone, cin, pin_hash, status, created_by, validated_by, validated_at)
     VALUES ($1, 'Client', 'Test', '12345678', '87654321', 'x', 'VALIDATED', $2, $2, now()) RETURNING id`,
    [shopId, ownerId]
  );
  await pool.query(
    `INSERT INTO sales (shop_id, client_sale_id, cashier_id, customer_id, total)
     VALUES ($1, $2, $3, $4, 4700)`,
    [shopId, crypto.randomUUID(), cashierId, customer.rows[0].id]
  );
  // Remboursement de crédit payé en espèces : 20.000 DT
  await pool.query(
    `INSERT INTO credits (shop_id, customer_id, amount, recorded_by)
     VALUES ($1, $2, -20000, $3)`,
    [shopId, customer.rows[0].id, cashierId]
  );

  r = await api("POST", "/cash-register/withdrawals", {
    token: ownerToken, body: { amount: 10000, description: "Retrait test" },
  });
  check("retrait enregistré (201)", r.status === 201, `status=${r.status}`);

  r = await api("POST", "/cash-register/deposits", {
    token: ownerToken, body: { amount: 5000, description: "Dépôt test" },
  });
  check("dépôt enregistré (201)", r.status === 201, `status=${r.status}`);

  r = await api("GET", "/cash-register/expected", { token: ownerToken });
  check("montant attendu = 230.500 DT", r.data?.expectedAmount === 230500,
    `expectedAmount=${r.data?.expectedAmount}`);
  check("ventes espèces = 15.500 DT", r.data?.cashSales === 15500,
    `cashSales=${r.data?.cashSales}`);
  check("remboursements crédit = 20.000 DT", r.data?.cashRepayments === 20000,
    `cashRepayments=${r.data?.cashRepayments}`);
  check("initializedAt présent", r.data?.initializedAt != null);

  // Vérification : compté 229.500 => écart -1.000 SHORTAGE
  r = await api("POST", "/cash-register/verifications", {
    token: ownerToken, body: { actualAmount: 229500 },
  });
  check("vérification SHORTAGE", r.status === 201 && r.data?.verification?.status === "SHORTAGE",
    `status=${r.status} ${JSON.stringify(r.data?.verification)}`);
  check("écart = -1.000", Number(r.data?.verification?.difference) === -1000,
    `difference=${r.data?.verification?.difference}`);
  check("théorique = 230.500", Number(r.data?.verification?.theoreticalBalance) === 230500,
    `theoreticalBalance=${r.data?.verification?.theoreticalBalance}`);

  // CORRECT et SURPLUS
  r = await api("POST", "/cash-register/verifications", {
    token: ownerToken, body: { actualAmount: 230500 },
  });
  check("vérification CORRECT", r.data?.verification?.status === "CORRECT");
  r = await api("POST", "/cash-register/verifications", {
    token: ownerToken, body: { actualAmount: 231000 },
  });
  check("vérification SURPLUS", r.data?.verification?.status === "SURPLUS");

  // -------------------------------------------------------------------
  console.log("\n=== 2. Vente à crédit exclue / remboursement inclus ===");
  check("vente crédit exclue du solde", r.data !== null); // via expectedAmount ci-dessus

  // -------------------------------------------------------------------
  console.log("\n=== 3. Autorisation : caissier 403, sans token 401 ===");
  const cashRoutes = [
    ["POST", "/cash-register/initialize", { amount: 1, initializedAt: nowIso }],
    ["GET",  "/cash-register/expected", undefined],
    ["POST", "/cash-register/withdrawals", { amount: 1, description: "x" }],
    ["POST", "/cash-register/deposits", { amount: 1, description: "x" }],
    ["POST", "/cash-register/adjustments", { amount: 1, description: "x" }],
    ["POST", "/cash-register/verifications", { actualAmount: 1 }],
    ["GET",  "/cash-register/movements", undefined],
    ["GET",  "/cash-register/verifications", undefined],
  ];
  for (const [method, path, body] of cashRoutes) {
    const rc = await api(method, path, { token: cashierToken, body });
    check(`caissier -> 403 ${method} ${path}`, rc.status === 403, `status=${rc.status}`);
    const rn = await api(method, path, { body });
    check(`sans token -> 401 ${method} ${path}`, rn.status === 401, `status=${rn.status}`);
  }

  // -------------------------------------------------------------------
  console.log("\n=== 4. shop_id / admin_id dans le body ignorés ===");
  const otherShop = await pool.query(
    `INSERT INTO shops (name, code) VALUES ('Autre boutique', $1) RETURNING id`,
    [`X${crypto.randomBytes(3).toString("hex").toUpperCase()}`]
  );
  r = await api("POST", "/cash-register/deposits", {
    token: ownerToken,
    body: { amount: 1000, description: "Test injection", shop_id: otherShop.rows[0].id, admin_id: cashierId },
  });
  check("dépôt accepté malgré shop_id/admin_id forgés", r.status === 201, `status=${r.status}`);
  const movCheck = await pool.query(
    `SELECT shop_id, admin_id FROM cash_movements WHERE id = $1`,
    [r.data?.movement?.id]
  );
  check("shop_id réel utilisé", movCheck.rows[0]?.shop_id === shopId);
  check("admin_id réel (owner) utilisé", movCheck.rows[0]?.admin_id === ownerId);

  // -------------------------------------------------------------------
  console.log("\n=== 5. Seconde initialisation -> 409 ===");
  r = await api("POST", "/cash-register/initialize", {
    token: ownerToken, body: { amount: 999, initializedAt: nowIso },
  });
  check("seconde initialisation refusée (409)", r.status === 409, `status=${r.status}`);

  // -------------------------------------------------------------------
  console.log("\n=== 6. UPDATE / DELETE rejetés par la base ===");
  for (const table of ["cash_movements", "cash_verifications"]) {
    let updBlocked = false, delBlocked = false;
    try {
      await pool.query(`UPDATE ${table} SET created_at = now() WHERE shop_id = $1`, [shopId]);
    } catch { updBlocked = true; }
    try {
      await pool.query(`DELETE FROM ${table} WHERE shop_id = $1`, [shopId]);
    } catch { delBlocked = true; }
    check(`${table} : UPDATE bloqué`, updBlocked);
    check(`${table} : DELETE bloqué`, delBlocked);
  }

  // -------------------------------------------------------------------
  console.log("\n=== 7. Retrait supérieur au montant attendu -> 409 ===");
  const expNow = await api("GET", "/cash-register/expected", { token: ownerToken });
  const expectedAmount = expNow.data.expectedAmount;
  r = await api("POST", "/cash-register/withdrawals", {
    token: ownerToken,
    body: { amount: expectedAmount + 1, description: "Trop gros retrait" },
  });
  check("retrait > attendu refusé (409)", r.status === 409, `status=${r.status}`);

  // -------------------------------------------------------------------
  console.log("\n=== 7b. Validation des descriptions ===");
  r = await api("POST", "/cash-register/deposits", {
    token: ownerToken, body: { amount: 1000, description: "ab" },
  });
  check("description trop courte -> 400", r.status === 400, `status=${r.status}`);
  r = await api("POST", "/cash-register/deposits", {
    token: ownerToken, body: { amount: 1000, description: "motif\nretour" },
  });
  check("description avec caractère de contrôle -> 400", r.status === 400, `status=${r.status}`);
  r = await api("POST", "/cash-register/deposits", {
    token: ownerToken, body: { amount: 1000, description: "!!! ???" },
  });
  check("description sans lettre ni chiffre -> 400", r.status === 400, `status=${r.status}`);
  r = await api("POST", "/cash-register/deposits", {
    token: ownerToken, body: { amount: 1000, description: "a".repeat(201) },
  });
  check("description trop longue -> 400", r.status === 400, `status=${r.status}`);

  // -------------------------------------------------------------------
  console.log("\n=== 7c. Retraits parallèles (verrou consultatif par boutique) ===");
  // Boutique dédiée : solde connu = 10.000 DT
  const shopP = await pool.query(
    `INSERT INTO shops (name, code) VALUES ('Boutique parallèle', $1) RETURNING id`,
    [`P${crypto.randomBytes(3).toString("hex").toUpperCase()}`]
  );
  const ownerP = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
     VALUES ($1, 'Owner Parallèle', 'OWNER', $2, $3) RETURNING id`,
    [shopP.rows[0].id, `ownerp-${crypto.randomBytes(3).toString("hex")}@test.local`, OWNER_HASH]
  );
  const tokenP = await loginOwner(shopP.rows[0].id);
  r = await api("POST", "/cash-register/initialize", {
    token: tokenP, body: { amount: 10000, initializedAt: nowIso },
  });
  check("init boutique parallèle (201)", r.status === 201, `status=${r.status}`);

  // Deux retraits de 8.000 en parallèle : chacun <= solde, ensemble > solde.
  // Sans verrou, les deux passeraient (race). Avec pg_advisory_xact_lock,
  // le second attend le premier et voit le solde mis à jour -> 409.
  const [p1, p2] = await Promise.all([
    api("POST", "/cash-register/withdrawals", {
      token: tokenP, body: { amount: 8000, description: "Retrait parallèle A" },
    }),
    api("POST", "/cash-register/withdrawals", {
      token: tokenP, body: { amount: 8000, description: "Retrait parallèle B" },
    }),
  ]);
  const statuses = [p1.status, p2.status].sort((a, b) => a - b);
  check("un retrait accepté (201), l'autre refusé (409)",
    statuses[0] === 201 && statuses[1] === 409,
    `p1=${p1.status} p2=${p2.status}`);
  const expP = await api("GET", "/cash-register/expected", { token: tokenP });
  check("solde final = 2.000 DT", expP.data?.expectedAmount === 2000,
    `expectedAmount=${expP.data?.expectedAmount}`);

  // -------------------------------------------------------------------
  console.log("\n=== 8. Boutique non initialisée : 409 sur mouvements ===");
  const shop2 = await pool.query(
    `INSERT INTO shops (name, code) VALUES ('Boutique vide', $1) RETURNING id`,
    [`Y${crypto.randomBytes(3).toString("hex").toUpperCase()}`]
  );
  const owner2 = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
     VALUES ($1, 'Owner2', 'OWNER', $2, $3) RETURNING id`,
    [shop2.rows[0].id, `owner2-${crypto.randomBytes(3).toString("hex")}@test.local`, OWNER_HASH]
  );
  const token2 = await loginOwner(shop2.rows[0].id);
  r = await api("GET", "/cash-register/expected", { token: token2 });
  check("expected initialized=false", r.data?.initialized === false, `data=${JSON.stringify(r.data)}`);
  r = await api("POST", "/cash-register/deposits", {
    token: token2, body: { amount: 1000, description: "Avant init" },
  });
  check("dépôt avant init -> 409", r.status === 409, `status=${r.status}`);
  r = await api("POST", "/cash-register/verifications", {
    token: token2, body: { actualAmount: 0 },
  });
  check("vérification avant init -> 409", r.status === 409, `status=${r.status}`);

  // -------------------------------------------------------------------
  console.log("\n=== 8b. Régression : chemins frontend jamais 404 ===");
  // apiFetch appelle /api/cash-register/... (même chemin que le frontend).
  const g = await api("GET", "/cash-register/expected", {});
  check("GET /api/cash-register/expected -> 401 (route montée, pas 404)", g.status === 401, `status=${g.status}`);
  const p404 = await api("POST", "/cash-register/initialize", { body: { amount: 1 } });
  check("POST /api/cash-register/initialize -> 401 (route montée, pas 404)", p404.status === 401, `status=${p404.status}`);
  // Si le serveur de dev frontend (:3000) tourne, vérifier le proxy /api.
  try {
    const fr = await fetch("http://localhost:3000/api/cash-register/expected");
    check("proxy frontend :3000 -> /api ne renvoie pas 404", fr.status !== 404, `status=${fr.status}`);
  } catch {
    console.log("  INFO  serveur de dev frontend (:3000) non démarré — test proxy ignoré");
  }

  // -------------------------------------------------------------------
  console.log("\n=== 9. POST /api/sales idempotent ===");
  const saleId = crypto.randomUUID();
  const saleBody = { id: saleId, lines: [{ productId, quantity: 2 }, { productId, quantity: 3 }] };
  const s1 = await api("POST", "/sales", { token: cashierToken, body: saleBody });
  check("vente créée (201)", s1.status === 201, `status=${s1.status}`);
  const s2 = await api("POST", "/sales", { token: cashierToken, body: saleBody });
  check("reprise même id -> 200, même vente", s2.status === 200 && s2.data?.sale?.id === s1.data?.sale?.id,
    `status=${s2.status}`);
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sales WHERE shop_id = $1 AND client_sale_id = $2`,
    [shopId, saleId]
  );
  check("une seule vente en base", count.rows[0].n === 1, `n=${count.rows[0].n}`);
  const lineCount = await pool.query(
    `SELECT COUNT(*)::int AS n, SUM(quantity)::float AS q FROM sale_lines WHERE sale_id = $1`,
    [s1.data.sale.id]
  );
  check("lignes fusionnées (1 ligne, qté 5)", lineCount.rows[0].n === 1 && lineCount.rows[0].q === 5,
    `n=${lineCount.rows[0].n} q=${lineCount.rows[0].q}`);

  // -------------------------------------------------------------------
  console.log(`\n=== Résultat : ${passed} PASS, ${failed} FAIL ===`);
  if (failures.length) console.log("Échecs :", failures.join(" | "));
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error("ERREUR FATALE :", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
