// =====================================================================
// Tests v2 du module caisse — section 7 (réinitialisation + breakdown)
// Time travel : les lignes sont insérées en SQL avec created_at explicite
// (dates passées), puis computeExpected(shopId, T) est appelé à un T choisi.
// Les routes HTTP utilisent l'heure réelle du serveur : tous les événements
// sont placés dans le passé (t0 = now - 10h) pour que le serveur les voie.
//
// Boutique de test DÉDIÉE créée à chaque exécution (append-only).
// Usage : node scripts/test-cash-register-v2.js   (backend démarré sur :4000)
// =====================================================================
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'"]|["'"]$/g, "");
  }
}

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const svc = require("../src/services/cashRegister");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Jetons obtenus EXCLUSIVEMENT via POST /api/auth/login (aucun JWT manuel).
const TEST_OWNER_PIN = "1357";
const TEST_PIN = "4321";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
}

async function api(method, p, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api${p}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const H = 3600e3;
const at = (base, hours) => new Date(base.getTime() + hours * H);

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

async function makeShop(tag) {
  const code = `V${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const shop = await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1, $2) RETURNING id`,
    [`Test v2 ${tag} ${code}`, code]);
  const shopId = shop.rows[0].id;
  const ownerHash = await bcrypt.hash(TEST_OWNER_PIN, 8);
  const owner = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash)
     VALUES ($1, 'Owner', 'OWNER', $2, $3) RETURNING id`,
    [shopId, `o-${code.toLowerCase()}@t.local`, ownerHash]);
  const ownerId = owner.rows[0].id;
  const pinHash = await bcrypt.hash(TEST_PIN, 8);
  const cashier = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, pin_hash)
     VALUES ($1, 'Cashier', 'CASHIER', $2) RETURNING id`, [shopId, pinHash]);
  return {
    shopId, ownerId, cashierId: cashier.rows[0].id,
    ownerToken: await loginOwner(shopId),
    cashierToken: await loginCashier(shopId),
  };
}

async function insertInit(shopId, ownerId, amount, ts) {
  await pool.query(
    `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id, created_at, effective_at)
     VALUES ($1, 'INITIALIZATION', $2, 'Fond de caisse', $3, $4, $4)`,
    [shopId, amount, ownerId, ts]);
}
async function insertSale(shopId, cashierId, customerId, total, ts) {
  await pool.query(
    `INSERT INTO sales (shop_id, client_sale_id, cashier_id, customer_id, total, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [shopId, crypto.randomUUID(), cashierId, customerId, total, ts]);
}
async function insertRepayment(shopId, ownerId, customerId, amountNeg, ts) {
  await pool.query(
    `INSERT INTO credits (shop_id, customer_id, sale_id, reverses_id, amount, note, recorded_by, created_at)
     VALUES ($1, $2, NULL, NULL, $3, 'Remboursement test', $4, $5)`,
    [shopId, customerId, amountNeg, ownerId, ts]);
}
async function insertAdjustment(shopId, ownerId, amount, desc, ts) {
  await pool.query(
    `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id, created_at)
     VALUES ($1, 'ADJUSTMENT', $2, $3, $4, $5)`,
    [shopId, amount, desc, ownerId, ts]);
}
async function makeCustomer(shopId, ownerId, { validated }) {
  const phone = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const cin = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const r = await pool.query(
    `INSERT INTO customers (shop_id, first_name, family_name, phone, cin, pin_hash, status, created_by, validated_by, validated_at)
     VALUES ($1, 'Test', 'Client', $2, $3, 'x', $4, $5, $6, $7) RETURNING id`,
    [shopId, phone, cin, validated ? "VALIDATED" : "PENDING", ownerId,
     validated ? ownerId : null, validated ? new Date() : null]);
  return r.rows[0].id;
}

async function main() {
  console.log("\n=== Boutique A : time travel + réinitialisation ===");
  const A = await makeShop("A");
  const t0 = new Date(Date.now() - 10 * H); // tout est dans le passé

  const custP = await makeCustomer(A.shopId, A.ownerId, { validated: false });
  const custV = await makeCustomer(A.shopId, A.ownerId, { validated: true });

  await insertInit(A.shopId, A.ownerId, 200000, t0);
  await insertSale(A.shopId, A.cashierId, null, 3000, at(t0, -1));   // avant init -> exclue
  await insertSale(A.shopId, A.cashierId, null, 15500, at(t0, 1));  // vente espèces
  await insertSale(A.shopId, A.cashierId, custP, 4700, at(t0, 2));  // vente crédit -> exclue
  await insertRepayment(A.shopId, A.ownerId, custP, -30000, at(t0, 3)); // PENDING compte
  await insertRepayment(A.shopId, A.ownerId, custV, -20000, at(t0, 3)); // VALIDATED compte
  await insertAdjustment(A.shopId, A.ownerId, 20000, "Ajustement ajout", at(t0, 2));
  await insertAdjustment(A.shopId, A.ownerId, -10000, "Ajustement retrait", at(t0, 3));

  // --- Test 1 : computeExpected(t0+4h) = 275 500 ---
  const e1 = await svc.computeExpected(pool, A.shopId, at(t0, 4));
  check("T1 attendu = 275.500", e1.expectedAmount === 275500, `got ${e1.expectedAmount}`);
  check("T1 ventes espèces = 15.500 (1 vente)", e1.cashSales === 15500 && e1.salesCount === 1,
    `sales=${e1.cashSales} count=${e1.salesCount}`);
  check("T1 remboursements = 50.000 (2)", e1.cashRepayments === 50000 && e1.repaymentsCount === 2,
    `repay=${e1.cashRepayments} count=${e1.repaymentsCount}`);
  check("T1 argent ajouté = 20.000", e1.moneyAdded === 20000, `got ${e1.moneyAdded}`);
  check("T1 argent retiré = 10.000", e1.moneyRemoved === 10000, `got ${e1.moneyRemoved}`);
  const sum = e1.initialAmount + e1.cashSales + e1.cashRepayments + e1.moneyAdded - e1.moneyRemoved;
  check("T1 les lignes somment au total", sum === e1.expectedAmount, `sum=${sum}`);

  // Ligne postérieure à T jamais comptée (boutique B dédiée).
  console.log("\n=== Boutique B : ligne après T exclue ===");
  const B = await makeShop("B");
  const t0b = new Date(Date.now() - 5 * H);
  await insertInit(B.shopId, B.ownerId, 100000, t0b);
  await insertSale(B.shopId, B.cashierId, null, 5000, at(t0b, 2));
  const eB = await svc.computeExpected(pool, B.shopId, at(t0b, 1));
  check("B : vente après T exclue (attendu = 100.000)", eB.expectedAmount === 100000,
    `got ${eB.expectedAmount}`);

  // --- Test 2 : réinitialisation via la route (heure serveur réelle) ---
  console.log("\n=== Test 2 : POST /reinitialize ===");
  let r = await api("POST", "/cash-register/reinitialize", { token: A.ownerToken, body: { amount: 270000 } });
  check("reinitialize -> 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.data)}`);
  const v = r.data?.verification;
  check("vérification théorique = 275.500", v?.theoreticalBalance === 275500, `got ${v?.theoreticalBalance}`);
  check("vérification réelle = 270.000, écart -5.500, SHORTAGE",
    v?.actualBalance === 270000 && v?.difference === -5500 && v?.status === "SHORTAGE",
    JSON.stringify(v));
  const initCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cash_movements WHERE shop_id=$1 AND type='INITIALIZATION'`, [A.shopId]);
  check("deux lignes INITIALIZATION (ancienne conservée)", initCount.rows[0].n === 2, `n=${initCount.rows[0].n}`);
  const firstInit = await pool.query(
    `SELECT amount FROM cash_movements WHERE shop_id=$1 AND type='INITIALIZATION' ORDER BY created_at LIMIT 1`, [A.shopId]);
  check("ancienne initialisation inchangée (200.000)", Number(firstInit.rows[0].amount) === 200000);

  // Vente APRÈS la réinitialisation : créée dans le futur proche pour
  // vérifier qu'elle n'est pas comptée à T=maintenant mais l'est plus tard.
  const futureSale = new Date(Date.now() + 60e3);
  await insertSale(A.shopId, A.cashierId, null, 10000, futureSale);
  const eNow = await svc.computeExpected(pool, A.shopId, new Date());
  check("après réinit : attendu = 270.000 (tout l'historique ignoré)",
    eNow.expectedAmount === 270000, `got ${eNow.expectedAmount}`);
  const eLater = await svc.computeExpected(pool, A.shopId, new Date(Date.now() + 120e3));
  check("vente post-réinit comptée plus tard : 280.000", eLater.expectedAmount === 280000,
    `got ${eLater.expectedAmount}`);

  // --- Test 3 : 409 sans initialisation ---
  console.log("\n=== Test 3 : 409 non initialisé ===");
  const C = await makeShop("C");
  r = await api("POST", "/cash-register/reinitialize", { token: C.ownerToken, body: { amount: 1000 } });
  check("reinitialize non initialisé -> 409", r.status === 409, `status=${r.status}`);
  r = await api("POST", "/cash-register/adjustments", { token: C.ownerToken, body: { amount: 1000, direction: "ADD" } });
  check("adjustment non initialisé -> 409", r.status === 409, `status=${r.status}`);

  // --- Test 4 : REMOVE > disponible -> 409 ---
  console.log("\n=== Test 4 : REMOVE trop grand -> 409 ===");
  r = await api("POST", "/cash-register/adjustments", {
    token: A.ownerToken, body: { amount: 270001, direction: "REMOVE" },
  });
  check("REMOVE 270.001 > 270.000 -> 409", r.status === 409, `status=${r.status}`);
  const eA2 = await svc.computeExpected(pool, A.shopId, new Date());
  check("montant attendu inchangé (270.000)", eA2.expectedAmount === 270000, `got ${eA2.expectedAmount}`);

  // --- Test 5 : deux REMOVE parallèles ---
  console.log("\n=== Test 5 : REMOVE parallèles ===");
  const [pa, pb] = await Promise.all([
    api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 200000, direction: "REMOVE" } }),
    api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 200000, direction: "REMOVE" } }),
  ]);
  const st = [pa.status, pb.status].sort((x, y) => x - y);
  check("un REMOVE 201, l'autre 409", st[0] === 201 && st[1] === 409, `pa=${pa.status} pb=${pb.status}`);
  const eA3 = await svc.computeExpected(pool, A.shopId, new Date());
  check("solde final = 70.000", eA3.expectedAmount === 70000, `got ${eA3.expectedAmount}`);

  // --- Test 6 : motif par défaut / invalide ---
  console.log("\n=== Test 6 : motifs ===");
  r = await api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 1000, direction: "ADD" } });
  check("ajustement sans motif -> 201", r.status === 201, `status=${r.status}`);
  const movDesc = await pool.query(
    `SELECT description FROM cash_movements WHERE shop_id=$1 AND type='ADJUSTMENT' ORDER BY created_at DESC LIMIT 1`, [A.shopId]);
  check("motif par défaut 'Ajustement sans motif'", movDesc.rows[0]?.description === "Ajustement sans motif",
    `got '${movDesc.rows[0]?.description}'`);
  r = await api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 1000, direction: "ADD", reason: "!!" } });
  check("motif '!!' -> 400", r.status === 400, `status=${r.status}`);
  r = await api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 1000, direction: "ADD", reason: "ab" } });
  check("motif 'ab' (2 car.) -> 400", r.status === 400, `status=${r.status}`);
  r = await api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 0, direction: "ADD" } });
  check("montant 0 -> 400", r.status === 400, `status=${r.status}`);
  r = await api("POST", "/cash-register/adjustments", { token: A.ownerToken, body: { amount: 1000, direction: "SIDEWAYS" } });
  check("direction invalide -> 400", r.status === 400, `status=${r.status}`);

  // --- Test 7 : /expected read-only, dates ignorées, auth, injection ---
  console.log("\n=== Test 7 : lecture seule / auth / injection ===");
  const countRows = async () => {
    const m = await pool.query(`SELECT COUNT(*)::int n FROM cash_movements WHERE shop_id=$1`, [A.shopId]);
    const vv = await pool.query(`SELECT COUNT(*)::int n FROM cash_verifications WHERE shop_id=$1`, [A.shopId]);
    return m.rows[0].n + vv.rows[0].n;
  };
  const before = await countRows();
  await api("GET", "/cash-register/expected", { token: A.ownerToken });
  await api("GET", "/cash-register/expected", { token: A.ownerToken });
  check("GET /expected x2 ne crée aucune ligne", (await countRows()) === before);

  r = await api("POST", "/cash-register/adjustments", {
    token: A.ownerToken,
    body: { amount: 500, direction: "ADD", createdAt: "1999-01-01", effectiveAt: "1999-01-01", shop_id: B.shopId, admin_id: B.ownerId },
  });
  check("adjustment accepte malgré dates/shop forgés", r.status === 201, `status=${r.status}`);
  const forged = await pool.query(
    `SELECT shop_id, admin_id, created_at FROM cash_movements WHERE shop_id=$1 AND type='ADJUSTMENT' ORDER BY created_at DESC LIMIT 1`, [A.shopId]);
  check("mouvement dans la boutique du jeton, admin du jeton, date serveur",
    forged.rows[0]?.shop_id === A.shopId && forged.rows[0]?.admin_id === A.ownerId &&
    Math.abs(Date.now() - new Date(forged.rows[0].created_at).getTime()) < 60000,
    JSON.stringify(forged.rows[0]));

  r = await api("GET", "/cash-register/expected", { token: A.cashierToken });
  check("caissier -> 403", r.status === 403, `status=${r.status}`);
  r = await api("GET", "/cash-register/expected", {});
  check("sans token -> 401", r.status === 401, `status=${r.status}`);
  r = await api("POST", "/cash-register/reinitialize", { token: A.cashierToken, body: { amount: 1 } });
  check("caissier reinitialize -> 403", r.status === 403, `status=${r.status}`);

  // --- Test 8 : UPDATE/DELETE rejetés par la base ---
  console.log("\n=== Test 8 : append-only ===");
  let updErr = null, delErr = null;
  try { await pool.query(`UPDATE cash_movements SET amount=1 WHERE shop_id=$1 LIMIT 1`, [A.shopId]); }
  catch (e) { updErr = e; }
  try { await pool.query(`DELETE FROM cash_movements WHERE shop_id=$1`, [A.shopId]); }
  catch (e) { delErr = e; }
  check("UPDATE cash_movements rejeté", !!updErr, updErr ? "" : "pas d'erreur");
  check("DELETE cash_movements rejeté", !!delErr, delErr ? "" : "pas d'erreur");
  updErr = null; delErr = null;
  try { await pool.query(`UPDATE cash_verifications SET actual_balance=1 WHERE shop_id=$1`, [A.shopId]); }
  catch (e) { updErr = e; }
  try { await pool.query(`DELETE FROM cash_verifications WHERE shop_id=$1`, [A.shopId]); }
  catch (e) { delErr = e; }
  check("UPDATE cash_verifications rejeté", !!updErr);
  check("DELETE cash_verifications rejeté", !!delErr);

  console.log(`\n=== ${passed} PASS, ${failed} FAIL ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERREUR FATALE :", e); process.exit(1); });
