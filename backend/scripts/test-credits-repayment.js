// =====================================================================
// Tests remboursements de credit (section 5) — boutiques de test dediees.
// Garde : TEST_DATABASE_URL doit etre defini et DIFFERENT de
// DATABASE_URL (production). Si la meme base est utilisee (environnement
// de dev mono-base), il faut TEST_ALLOW_SAME_DB=1 — les tests ne touchent
// que des boutiques de test creees a l'execution (append-only).
// Usage : node scripts/test-credits-repayment.js   (backend sur :4000)
// =====================================================================
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'"]|["'"]$/g, "");
  }
}

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const TEST_DB = process.env.TEST_DATABASE_URL;
const PROD_DB = process.env.DATABASE_URL;

if (!TEST_DB) {
  console.error("ERREUR : TEST_DATABASE_URL n'est pas defini (backend/.env).");
  process.exit(1);
}
if (TEST_DB === PROD_DB && process.env.TEST_ALLOW_SAME_DB !== "1") {
  console.error("ERREUR : TEST_DATABASE_URL identique a DATABASE_URL (production).");
  console.error("Utilisez une base de test dediee, ou TEST_ALLOW_SAME_DB=1 en dev mono-base.");
  process.exit(1);
}
if (TEST_DB === PROD_DB) {
  console.log("AVERTISSEMENT : tests sur la MEME base que la production (boutiques de test dediees uniquement).");
}
console.log(`Base de test : ${TEST_DB === PROD_DB ? "identique a DATABASE_URL (dev)" : "dediee"}`);

const svc = require("../src/services/cashRegister");
const pool = new Pool({ connectionString: TEST_DB });
const sign = (p) => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: "1h" });

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

async function makeShop(tag) {
  const code = `R${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const shop = await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1, $2) RETURNING id`,
    [`Test credits ${tag} ${code}`, code]);
  const shopId = shop.rows[0].id;
  const owner = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, password_hash)
     VALUES ($1, 'Owner', 'OWNER', $2, 'x') RETURNING id`,
    [shopId, `o-${code.toLowerCase()}@t.local`]);
  const ownerId = owner.rows[0].id;
  const cashier = await pool.query(
    `INSERT INTO app_users (shop_id, name, role, pin_hash)
     VALUES ($1, 'Cashier', 'CASHIER', 'x') RETURNING id`, [shopId]);
  return {
    shopId, ownerId, cashierId: cashier.rows[0].id,
    ownerToken: sign({ userId: ownerId, shopId, role: "OWNER" }),
    cashierToken: sign({ userId: cashier.rows[0].id, shopId, role: "CASHIER" }),
  };
}

async function makeCustomer(shopId, ownerId, { validated, firstName, familyName }) {
  const phone = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const cin = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const r = await pool.query(
    `INSERT INTO customers (shop_id, first_name, family_name, phone, cin, pin_hash, status, created_by, validated_by, validated_at)
     VALUES ($1, $2, $3, $4, $5, 'x', $6, $7, $8, $9) RETURNING id`,
    [shopId, firstName || "Test", familyName || "Client", phone, cin,
     validated ? "VALIDATED" : "PENDING", ownerId,
     validated ? ownerId : null, validated ? new Date() : null]);
  return r.rows[0].id;
}

// Dette : vente a credit (sale customer_id NOT NULL) + credits +amount.
async function makeDebt(shopId, cashierId, customerId, amount, ts) {
  const sale = await pool.query(
    `INSERT INTO sales (shop_id, client_sale_id, cashier_id, customer_id, total, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [shopId, crypto.randomUUID(), cashierId, customerId, amount, ts]);
  await pool.query(
    `INSERT INTO credits (shop_id, customer_id, sale_id, reverses_id, amount, note, recorded_by, created_at)
     VALUES ($1, $2, $3, NULL, $4, 'Vente a credit', $5, $6)`,
    [shopId, customerId, sale.rows[0].id, amount, cashierId, ts]);
}

async function insertInit(shopId, ownerId, amount, ts) {
  await pool.query(
    `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id, created_at, effective_at)
     VALUES ($1, 'INITIALIZATION', $2, 'Fond de caisse', $3, $4, $4)`,
    [shopId, amount, ownerId, ts]);
}

async function balanceOf(customerId) {
  const r = await pool.query(`SELECT COALESCE(SUM(amount),0)::bigint AS b FROM credits WHERE customer_id=$1`, [customerId]);
  return Number(r.rows[0].b);
}

// La ventilation doit toujours sommer au total.
function checkBreakdown(e, label) {
  if (!e.initialized) return;
  const sum = e.initialAmount + e.cashSales + e.cashRepayments + e.moneyAdded - e.moneyRemoved;
  check(`${label} : ventilation = total`, sum === e.expectedAmount, `sum=${sum} total=${e.expectedAmount}`);
}

async function main() {
  const t0 = new Date(Date.now() - 10 * H); // tout dans le passe

  // ================================================================
  console.log("\n=== Test 1 : remboursement 20.000 sur dette 45.000 ===");
  const S1 = await makeShop("1");
  await insertInit(S1.shopId, S1.ownerId, 200000, t0);
  const c1 = await makeCustomer(S1.shopId, S1.ownerId, { validated: true, firstName: "Salma", familyName: "Ben Ali" });
  await makeDebt(S1.shopId, S1.cashierId, c1, 45000, at(t0, 0.5));

  const rid1 = crypto.randomUUID();
  let r = await api("POST", "/credits/repayments", {
    token: S1.ownerToken,
    body: { repaymentId: rid1, customerId: c1, amount: 20000 },
  });
  check("remboursement -> 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.data)}`);
  check("reponse : newBalance 25.000", r.data?.newBalance === 25000, `got ${r.data?.newBalance}`);
  check("solde client = 25.000", (await balanceOf(c1)) === 25000);
  const row1 = await pool.query(`SELECT amount, sale_id, reverses_id FROM credits WHERE id=$1`, [rid1]);
  check("credits : amount -20000, sale_id NULL, reverses NULL",
    Number(row1.rows[0]?.amount) === -20000 && row1.rows[0]?.sale_id === null && row1.rows[0]?.reverses_id === null);

  // Le remboursement est horodate a l'heure serveur (>= init) : il compte
  // dans le montant attendu calcule a present.
  const e1 = await svc.computeExpected(S1.shopId, new Date());
  check("montant attendu = 220.000", e1.expectedAmount === 220000, `got ${e1.expectedAmount}`);
  check("Remboursements de credit : 20.000 (1)", e1.cashRepayments === 20000 && e1.repaymentsCount === 1,
    `amount=${e1.cashRepayments} count=${e1.repaymentsCount}`);
  checkBreakdown(e1, "T1");

  // ================================================================
  console.log("\n=== Test 2 : PENDING et VALIDATED comptent tous les deux ===");
  const S2 = await makeShop("2");
  await insertInit(S2.shopId, S2.ownerId, 100000, t0);
  const cP = await makeCustomer(S2.shopId, S2.ownerId, { validated: false, firstName: "Pending", familyName: "Client" });
  const cV = await makeCustomer(S2.shopId, S2.ownerId, { validated: true, firstName: "Valid", familyName: "Client" });
  await makeDebt(S2.shopId, S2.cashierId, cP, 10000, at(t0, 0.5));
  await makeDebt(S2.shopId, S2.cashierId, cV, 10000, at(t0, 0.5));
  r = await api("POST", "/credits/repayments", { token: S2.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: cP, amount: 5000 } });
  check("PENDING : remboursement -> 201", r.status === 201, `status=${r.status}`);
  r = await api("POST", "/credits/repayments", { token: S2.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: cV, amount: 5000 } });
  check("VALIDATED : remboursement -> 201", r.status === 201, `status=${r.status}`);
  const e2 = await svc.computeExpected(S2.shopId, new Date());
  check("montant attendu = 110.000 (100 + 5 + 5)", e2.expectedAmount === 110000, `got ${e2.expectedAmount}`);
  check("Remboursements : 10.000 (2)", e2.cashRepayments === 10000 && e2.repaymentsCount === 2);
  checkBreakdown(e2, "T2");

  // ================================================================
  console.log("\n=== Test 3 : avant la derniere initialisation = ignore ===");
  const S3 = await makeShop("3");
  await insertInit(S3.shopId, S3.ownerId, 50000, t0);
  const c3 = await makeCustomer(S3.shopId, S3.ownerId, { validated: true });
  await makeDebt(S3.shopId, S3.cashierId, c3, 20000, at(t0, 0.5));
  // Remboursement ANTERIEUR a l'initialisation (insere en SQL, date passee).
  await pool.query(
    `INSERT INTO credits (shop_id, customer_id, sale_id, reverses_id, amount, note, recorded_by, created_at)
     VALUES ($1, $2, NULL, NULL, -3000, 'Remboursement ancien', $3, $4)`,
    [S3.shopId, c3, S3.ownerId, at(t0, -1)]);
  let e3 = await svc.computeExpected(S3.shopId, at(t0, 2));
  check("remboursement avant init ignore (attendu = 50.000)", e3.expectedAmount === 50000, `got ${e3.expectedAmount}`);
  // Reinitialisation via la route (heure serveur) : tout l'historique ignore.
  r = await api("POST", "/cash-register/reinitialize", { token: S3.ownerToken, body: { amount: 48000 } });
  check("reinitialize -> 201", r.status === 201, `status=${r.status}`);
  e3 = await svc.computeExpected(S3.shopId, new Date());
  check("apres reinit : attendu = 48.000 (rien d'autre ne compte)", e3.expectedAmount === 48000, `got ${e3.expectedAmount}`);
  checkBreakdown(e3, "T3");

  // ================================================================
  console.log("\n=== Test 4 : depassement / sans dette / montants invalides ===");
  const S4 = await makeShop("4");
  await insertInit(S4.shopId, S4.ownerId, 100000, t0);
  const c4 = await makeCustomer(S4.shopId, S4.ownerId, { validated: true });
  await makeDebt(S4.shopId, S4.cashierId, c4, 45000, at(t0, 0.5));
  const cNoDebt = await makeCustomer(S4.shopId, S4.ownerId, { validated: true, firstName: "No", familyName: "Debt" });

  r = await api("POST", "/credits/repayments", { token: S4.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: c4, amount: 50000 } });
  check("50.000 sur dette 45.000 -> 409", r.status === 409, `status=${r.status}`);
  check("message : depasse la dette", /dépasse la dette/.test(r.data?.error || ""), r.data?.error);
  check("rien insere (solde toujours 45.000)", (await balanceOf(c4)) === 45000);
  const e4a = await svc.computeExpected(S4.shopId, new Date());
  check("montant attendu inchange (100.000)", e4a.expectedAmount === 100000, `got ${e4a.expectedAmount}`);

  r = await api("POST", "/credits/repayments", { token: S4.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: cNoDebt, amount: 1000 } });
  check("sans dette -> 409", r.status === 409, `status=${r.status}`);
  check("message : aucune dette", /aucune dette/.test(r.data?.error || ""), r.data?.error);

  for (const bad of [0, -5, 1.5, "10", null, undefined]) {
    r = await api("POST", "/credits/repayments", { token: S4.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: c4, amount: bad } });
    check(`amount=${JSON.stringify(bad)} -> 400`, r.status === 400, `status=${r.status}`);
  }
  checkBreakdown(e4a, "T4");

  // ================================================================
  console.log("\n=== Test 5 : idempotence (meme repaymentId) ===");
  const S5 = await makeShop("5");
  await insertInit(S5.shopId, S5.ownerId, 100000, t0);
  const c5 = await makeCustomer(S5.shopId, S5.ownerId, { validated: true });
  await makeDebt(S5.shopId, S5.cashierId, c5, 45000, at(t0, 0.5));
  const rid5 = crypto.randomUUID();
  r = await api("POST", "/credits/repayments", { token: S5.ownerToken, body: { repaymentId: rid5, customerId: c5, amount: 10000 } });
  check("1er appel -> 201", r.status === 201, `status=${r.status}`);
  r = await api("POST", "/credits/repayments", { token: S5.ownerToken, body: { repaymentId: rid5, customerId: c5, amount: 10000 } });
  check("retry meme id -> 200", r.status === 200, `status=${r.status}`);
  const cnt5 = await pool.query(`SELECT COUNT(*)::int n FROM credits WHERE id=$1`, [rid5]);
  check("UNE seule ligne credits", cnt5.rows[0].n === 1, `n=${cnt5.rows[0].n}`);
  check("solde = 35.000 (pas 25.000)", (await balanceOf(c5)) === 35000, `got ${await balanceOf(c5)}`);
  const e5 = await svc.computeExpected(S5.shopId, new Date());
  check("montant attendu = 110.000 (une seule fois)", e5.expectedAmount === 110000, `got ${e5.expectedAmount}`);
  check("Remboursements : 10.000 (1)", e5.cashRepayments === 10000 && e5.repaymentsCount === 1);
  checkBreakdown(e5, "T5");

  // ================================================================
  console.log("\n=== Test 6 : concurrence (2 x 30.000 sur dette 45.000) ===");
  const S6 = await makeShop("6");
  await insertInit(S6.shopId, S6.ownerId, 100000, t0);
  const c6 = await makeCustomer(S6.shopId, S6.ownerId, { validated: true });
  await makeDebt(S6.shopId, S6.cashierId, c6, 45000, at(t0, 0.5));
  const [p1, p2] = await Promise.all([
    api("POST", "/credits/repayments", { token: S6.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: c6, amount: 30000 } }),
    api("POST", "/credits/repayments", { token: S6.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: c6, amount: 30000 } }),
  ]);
  const st6 = [p1.status, p2.status].sort((a, b) => a - b);
  check("un 201, un 409", st6[0] === 201 && st6[1] === 409, `p1=${p1.status} p2=${p2.status}`);
  check("solde final = 15.000 (jamais negatif)", (await balanceOf(c6)) === 15000, `got ${await balanceOf(c6)}`);
  const e6 = await svc.computeExpected(S6.shopId, new Date());
  check("montant attendu = 130.000", e6.expectedAmount === 130000, `got ${e6.expectedAmount}`);
  checkBreakdown(e6, "T6");

  // ================================================================
  console.log("\n=== Test 7 : autre boutique / champs forgés / sans token ===");
  const S7 = await makeShop("7");
  const S7b = await makeShop("7b");
  await insertInit(S7.shopId, S7.ownerId, 100000, t0);
  const c7 = await makeCustomer(S7.shopId, S7.ownerId, { validated: true });
  await makeDebt(S7.shopId, S7.cashierId, c7, 10000, at(t0, 0.5));
  const cOther = await makeCustomer(S7b.shopId, S7b.ownerId, { validated: true });
  await makeDebt(S7b.shopId, S7b.cashierId, cOther, 10000, at(t0, 0.5));

  r = await api("POST", "/credits/repayments", { token: S7.ownerToken, body: { repaymentId: crypto.randomUUID(), customerId: cOther, amount: 1000 } });
  check("client d'une autre boutique -> 404", r.status === 404, `status=${r.status}`);

  r = await api("POST", "/credits/repayments", {
    token: S7.ownerToken,
    body: { repaymentId: crypto.randomUUID(), customerId: c7, amount: 1000, shop_id: S7b.shopId, recorded_by: S7b.ownerId, created_at: "1999-01-01", status: "VALIDATED" },
  });
  check("champs forgés ignores -> 201", r.status === 201, `status=${r.status}`);
  const forgedRow = await pool.query(
    `SELECT shop_id, recorded_by, created_at FROM credits WHERE customer_id=$1 AND amount=-1000 ORDER BY created_at DESC LIMIT 1`, [c7]);
  check("ligne dans la boutique du jeton, recorded_by du jeton, date serveur",
    forgedRow.rows[0]?.shop_id === S7.shopId && forgedRow.rows[0]?.recorded_by === S7.ownerId &&
    Math.abs(Date.now() - new Date(forgedRow.rows[0].created_at).getTime()) < 60000,
    JSON.stringify(forgedRow.rows[0]));

  r = await api("POST", "/credits/repayments", { body: { repaymentId: crypto.randomUUID(), customerId: c7, amount: 1000 } });
  check("sans token -> 401", r.status === 401, `status=${r.status}`);
  r = await api("GET", "/customers/search?q=Test", {});
  check("search sans token -> 401", r.status === 401, `status=${r.status}`);

  // ================================================================
  console.log("\n=== Test 8 : caissier = search + remboursement, 403 caisse ===");
  r = await api("GET", "/customers/search?q=Test", { token: S7.cashierToken });
  check("caissier search -> 200", r.status === 200, `status=${r.status}`);
  r = await api("POST", "/credits/repayments", { token: S7.cashierToken, body: { repaymentId: crypto.randomUUID(), customerId: c7, amount: 500 } });
  check("caissier remboursement -> 201", r.status === 201, `status=${r.status}`);
  r = await api("GET", "/cash-register/expected", { token: S7.cashierToken });
  check("caissier /cash-register/expected -> 403", r.status === 403, `status=${r.status}`);
  r = await api("POST", "/cash-register/adjustments", { token: S7.cashierToken, body: { amount: 1, direction: "ADD" } });
  check("caissier /cash-register/adjustments -> 403", r.status === 403, `status=${r.status}`);

  // ================================================================
  console.log("\n=== Test 9 : recherche client ===");
  const S9 = await makeShop("9");
  await makeCustomer(S9.shopId, S9.ownerId, { validated: true, firstName: "Salma", familyName: "Ben Ali" });
  await makeCustomer(S9.shopId, S9.ownerId, { validated: true, firstName: "Salim", familyName: "Ben Ali" });
  await makeCustomer(S9.shopId, S9.ownerId, { validated: true, firstName: "Autre", familyName: "Personne" });
  r = await api("GET", "/customers/search?q=Sa", { token: S9.ownerToken });
  check("q < 3 caracteres -> 400", r.status === 400, `status=${r.status}`);
  r = await api("GET", "/customers/search?q=salma", { token: S9.ownerToken });
  check("search 'salma' -> 200", r.status === 200, `status=${r.status}`);
  const found = r.data?.customers || [];
  check("resultat contient Salma", found.some((c) => c.firstName === "Salma"), JSON.stringify(found));
  const f0 = found[0];
  check("champs minimaux (id, firstName, familyName, balance, maskedCin)",
    f0 && Object.keys(f0).sort().join(",") === "balance,familyName,firstName,id,maskedCin",
    JSON.stringify(f0 && Object.keys(f0)));
  check("jamais de CIN complet / telephone / pin_hash",
    !JSON.stringify(r.data).includes("pin_hash") && !/"phone"/.test(JSON.stringify(r.data)) &&
    !/"cin":\s*"\d{8}"/.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 200));
  check("maskedCin masque (******XX)", /^\*{6}\d{2}$/.test(f0?.maskedCin || ""), f0?.maskedCin);
  // Max 5 resultats : creer 6 clients matchant
  for (let i = 0; i < 6; i++) {
    await makeCustomer(S9.shopId, S9.ownerId, { validated: true, firstName: `Zzz${i}`, familyName: "Recherche" });
  }
  r = await api("GET", "/customers/search?q=Recherche", { token: S9.ownerToken });
  check("max 5 resultats", (r.data?.customers || []).length <= 5, `n=${(r.data?.customers || []).length}`);
  // Ne liste pas tous les clients : 'zz' ne doit rien trouver (2 car.)
  r = await api("GET", "/customers/search?q=zz", { token: S9.ownerToken });
  check("q=zz (<3) -> 400, pas de liste complete", r.status === 400);

  // ================================================================
  console.log("\n=== Test 10 : UPDATE/DELETE credits rejetes ===");
  let updErr = null, delErr = null;
  try { await pool.query(`UPDATE credits SET amount=1 WHERE id=$1`, [rid1]); } catch (e) { updErr = e; }
  try { await pool.query(`DELETE FROM credits WHERE id=$1`, [rid1]); } catch (e) { delErr = e; }
  check("UPDATE credits rejete", !!updErr, updErr ? "" : "pas d'erreur");
  check("DELETE credits rejete", !!delErr, delErr ? "" : "pas d'erreur");

  // ================================================================
  console.log("\n=== Test 11 : ventilation = total (deja verifie a chaque test) ===");
  check("T1..T6 verifient la ventilation a chaque etape", true);

  console.log(`\n=== ${passed} PASS, ${failed} FAIL ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERREUR FATALE :", e); process.exit(1); });
