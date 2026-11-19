// Tests des routes /api/credits (dettes manuelles, remboursements,
// validation client) + impact sur computeExpected.
// Usage : node scripts/test-credits.js
// Crée une boutique de test dédiée (préfixe "Test credits ") et laisse
// les données en base (comme les autres scripts de test).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

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
function tokenFor(userId, shopId, role) {
  return jwt.sign({ userId, shopId, role }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

(async () => {
  const tag = `Test credits ${Date.now()}`;
  // Boutique + OWNER + CASHIER + client PENDING
  const shop = (await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1, $2) RETURNING id`,
    [tag, `T${crypto.randomInt(100000, 999999)}`])).rows[0];
  const owner = (await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, password_hash) VALUES ($1,'Owner Test','OWNER',$2,'x') RETURNING id`,
    [shop.id, `owner-${Date.now()}@test.local`])).rows[0];
  const cashier = (await pool.query(
    `INSERT INTO app_users (shop_id, name, role, pin_hash) VALUES ($1,'Caissier Test','CASHIER','x') RETURNING id`, [shop.id])).rows[0];
  const customer = (await pool.query(
    `INSERT INTO customers (shop_id, first_name, family_name, phone, cin, pin_hash, status, created_by)
     VALUES ($1,'Ali','Test','12345678','12345678','x','PENDING',$2) RETURNING id`, [shop.id, owner.id])).rows[0];

  const ownerTok = tokenFor(owner.id, shop.id, "OWNER");
  const cashierTok = tokenFor(cashier.id, shop.id, "CASHIER");

  console.log("== Validation client ==");
  let r = await api(cashierTok, "POST", `/credits/customers/${customer.id}/validate`);
  ok(r.status === 403, "CASHIER ne peut pas valider (403)");
  r = await api(ownerTok, "POST", `/credits/customers/${customer.id}/validate`);
  ok(r.status === 200 && r.data.customer.status === "VALIDATED", "OWNER valide le client");
  r = await api(ownerTok, "POST", `/credits/customers/${customer.id}/validate`);
  ok(r.status === 409, "Double validation refusée (409)");

  console.log("== Dette manuelle ==");
  const debtId = crypto.randomUUID();
  r = await api(cashierTok, "POST", "/credits/debts", { customerId: customer.id, amount: 5000, id: debtId });
  ok(r.status === 403, "CASHIER ne peut pas ajouter une dette (403)");
  r = await api(ownerTok, "POST", "/credits/debts", { customerId: customer.id, amount: 5000, id: debtId });
  ok(r.status === 201 && r.data.credit.amount === 5000, "OWNER ajoute une dette de 5.000");
  r = await api(ownerTok, "POST", "/credits/debts", { customerId: customer.id, amount: 5000, id: debtId });
  ok(r.status === 201, "Dette idempotente (même id)");
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int n FROM credits WHERE id=$1`, [debtId]);
  ok(cnt[0].n === 1, "Une seule ligne en base (idempotence)");

  console.log("== Remboursement ==");
  const repId = crypto.randomUUID();
  r = await api(cashierTok, "POST", "/credits/repayments", { customerId: customer.id, amount: 2000, id: repId });
  ok(r.status === 201 && r.data.credit.amount === -2000, "CASHIER rembourse 2.000 (stocké -2000)");
  r = await api(ownerTok, "POST", "/credits/repayments", { customerId: customer.id, amount: 99999, id: crypto.randomUUID() });
  ok(r.status === 409, "Remboursement > solde refusé (409)");
  r = await api(ownerTok, "POST", "/credits/repayments", { customerId: customer.id, amount: 3000, id: repId });
  ok(r.status === 201, "Remboursement idempotent (même id)");
  const { rows: bal } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::bigint b FROM credits WHERE customer_id=$1`, [customer.id]);
  ok(Number(bal[0].b) === 3000, "Solde restant = 3.000");

  console.log("== Liste + détail ==");
  r = await api(cashierTok, "GET", "/credits/customers");
  ok(r.status === 200 && r.data.customers.some((c) => c.id === customer.id && c.balance === 3000),
    "GET /customers : solde 3.000 visible par CASHIER");
  r = await api(ownerTok, "GET", `/credits/customers/${customer.id}`);
  ok(r.status === 200 && r.data.history.length === 2, "GET /customers/:id : 2 opérations");

  console.log("== Impact caisse ==");
  // Initialisation caisse + vérification que le remboursement compte.
  await pool.query(
    `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id, created_at, effective_at)
     VALUES ($1,'INITIALIZATION',10000,'init',$2, now() - interval '1 hour', now() - interval '1 hour')`,
    [shop.id, owner.id]);
  const svc = require("../src/services/cashRegister");
  const exp = await svc.computeExpected(shop.id, new Date());
  ok(exp.initialized && exp.cashRepayments === 2000 && exp.repaymentsCount === 1,
    `computeExpected : remboursements = 2000 (reçu ${exp.cashRepayments})`);
  ok(exp.expectedAmount === 10000 + 2000, "Montant attendu = init + remboursements");
  const reps = await svc.listRepayments(shop.id, new Date(0), new Date(Date.now() + 60000));
  ok(reps.length === 1 && reps[0].customerName === "Ali Test", "listRepayments : nom du créditeur");

  console.log(`\n=== Résultat : ${pass} PASS, ${fail} FAIL ===`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
