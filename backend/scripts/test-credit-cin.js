// =====================================================================
// Tests crédit + CIN + plafond + outbox (style test-credits.js).
// Usage : node scripts/test-credit-cin.js
//
// Couvre :
//   - validation de création de profil (champs/consentement/fichier) ;
//   - plafond serveur (100 DT accepté, 100,01 refusé) ;
//   - deux dettes simultanées qui dépasseraient le plafond (une seule passe) ;
//   - isolation par shop_id ;
//   - CASHIER ne peut PAS lire la CIN (403), OWNER oui (URL signée) ;
//   - suppression de la CIN (chemin NULL, lignes `credits` intactes) ;
//   - nouvelle dette refusée sans photo ;
//   - vente à crédit : une seule transaction, n'entre pas dans la caisse ;
//   - outbox : notification enregistrée, non consommée sans SMTP.
//
// Les assertions qui exigent Supabase Storage sont SKIP si non configuré.
// Nettoie TOUT ce qu'il crée (boutiques, utilisateurs, fichiers du bucket).
// =====================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

const storage = require("../src/services/storage");
const outbox = require("../src/services/outbox");

const BASE = process.env.API_BASE || "http://localhost:4000/api";
const TEST_OWNER_PIN = "1357";
const TEST_PIN = "4321";
const CREDIT_LIMIT = Number(process.env.CREDIT_LIMIT) > 0 ? Number(process.env.CREDIT_LIMIT) : 100;
const LIMIT_MM = CREDIT_LIMIT * 1000; // millimes

// PNG 1x1 valide (magic bytes corrects) et faux fichier texte.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const NOT_IMAGE = Buffer.from("ceci n'est pas une image", "utf8");

let pass = 0, fail = 0, skip = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS", label); }
  else { fail++; console.log("  FAIL", label); }
}
function skipped(label) { skip++; console.log("  SKIP", label); }

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

// Upload multipart (photo CIN). `file` = { buffer, name, type } ou null.
async function upload(token, method, p, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  if (file) fd.append("cinPhoto", new Blob([file.buffer], { type: file.type }), file.name);
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function login(shopId, pin, role) {
  const { rows } = await pool.query(`SELECT code FROM shops WHERE id = $1`, [shopId]);
  const body = { code: rows[0].code, pin };
  if (role) body.role = role;
  const r = await api(null, "POST", "/auth/login", body);
  if (r.status !== 200) throw new Error(`login ${role || "CASHIER"} échoué (${r.status}) ${JSON.stringify(r.data)}`);
  return r.data.token;
}

// Insère un créditeur directement (photo simulée ou absente).
async function seedCustomer(shopId, userId, { photo = true, status = "VALIDATED" } = {}) {
  const phone = "9" + String(crypto.randomInt(1000000, 9999999));
  const cin = String(crypto.randomInt(10000000, 99999999));
  const { rows } = await pool.query(
    `INSERT INTO customers
       (shop_id, first_name, family_name, phone, cin, cin_photo_path, cin_consent_at,
        status, created_by, validated_by, validated_at)
     VALUES ($1,'Test','Credit',$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      shopId, phone, cin,
      photo ? `${shopId}/seed-${crypto.randomUUID()}.jpg` : null,
      photo ? new Date() : null,
      status, userId,
      status === "VALIDATED" ? userId : null,
      status === "VALIDATED" ? new Date() : null,
    ]
  );
  return rows[0].id;
}

const createdShops = [];

async function cleanup() {
  for (const shopId of createdShops) {
    const q = async (sql, params) => {
      try { await pool.query(sql, params); }
      catch (e) { console.error("  [cleanup]", e.message); }
    };
    await q(`DELETE FROM credits WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE shop_id=$1)`, [shopId]);
    await q(`DELETE FROM stock_movements WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM product_scans WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM sales WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM products WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM notification_outbox WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM customers WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM app_users WHERE shop_id=$1`, [shopId]);
    await q(`DELETE FROM shops WHERE id=$1`, [shopId]);
  }
}

(async () => {
  const stamp = Date.now();
  const hasStorage = storage.isConfigured();

  // ── Boutique 1 : OWNER + CASHIER + produit ──
  const shop = (await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1,$2) RETURNING id`,
    [`Test credit-cin ${stamp}`, `TC${crypto.randomInt(100000, 999999)}`])).rows[0];
  createdShops.push(shop.id);
  const owner = (await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash) VALUES ($1,'Owner TC','OWNER',$2,$3) RETURNING id`,
    [shop.id, `tc-owner-${stamp}@test.local`, await bcrypt.hash(TEST_OWNER_PIN, 8)])).rows[0];
  await pool.query(
    `INSERT INTO app_users (shop_id, name, role, pin_hash) VALUES ($1,'Caissier TC','CASHIER',$2)`,
    [shop.id, await bcrypt.hash(TEST_PIN, 8)]);
  const product = (await pool.query(
    `INSERT INTO products (shop_id, name, price, current_stock, is_active)
     VALUES ($1,'Produit TC',50000,1000,true) RETURNING id`, [shop.id])).rows[0];

  const ownerTok = await login(shop.id, TEST_OWNER_PIN, "OWNER");
  const cashierTok = await login(shop.id, TEST_PIN);

  // ── Boutique 2 : pour l'isolation ──
  const shop2 = (await pool.query(
    `INSERT INTO shops (name, code) VALUES ($1,$2) RETURNING id`,
    [`Test credit-cin B ${stamp}`, `TD${crypto.randomInt(100000, 999999)}`])).rows[0];
  createdShops.push(shop2.id);
  const owner2 = (await pool.query(
    `INSERT INTO app_users (shop_id, name, role, email, pin_hash) VALUES ($1,'Owner TC2','OWNER',$2,$3) RETURNING id`,
    [shop2.id, `tc-owner2-${stamp}@test.local`, await bcrypt.hash(TEST_OWNER_PIN, 8)])).rows[0];
  const owner2Tok = await login(shop2.id, TEST_OWNER_PIN, "OWNER");

  console.log("== Validation création profil (400, sans stockage) ==");
  let r = await upload(cashierTok, "POST", "/credits/customers",
    { familyName: "X", phone: "20123456", cin: "12345678", consent: "true" },
    { buffer: PNG_1x1, name: "c.png", type: "image/png" });
  ok(r.status === 400, "prénom manquant refusé (400)");
  r = await upload(cashierTok, "POST", "/credits/customers",
    { firstName: "A", familyName: "X", phone: "20123456", cin: "12345678" },
    { buffer: PNG_1x1, name: "c.png", type: "image/png" });
  ok(r.status === 400, "consentement manquant refusé (400)");
  r = await upload(cashierTok, "POST", "/credits/customers",
    { firstName: "A", familyName: "X", phone: "123456", cin: "12345678", consent: "true" },
    { buffer: PNG_1x1, name: "c.png", type: "image/png" });
  ok(r.status === 400, "téléphone invalide refusé (400)");
  r = await upload(cashierTok, "POST", "/credits/customers",
    { firstName: "A", familyName: "X", phone: "20123456", cin: "12345678", consent: "true" },
    { buffer: NOT_IMAGE, name: "c.png", type: "image/png" });
  ok(r.status === 400, "type réel non image refusé (400, magic bytes)");
  r = await upload(cashierTok, "POST", "/credits/customers",
    { firstName: "A", familyName: "X", phone: "20123456", cin: "12345678", consent: "true" },
    null);
  ok(r.status === 400, "photo manquante refusée (400)");

  // ── Plafond (dettes manuelles) ──
  console.log("== Plafond de crédit (dettes manuelles) ==");
  const c1 = await seedCustomer(shop.id, owner.id);
  r = await api(ownerTok, "POST", "/credits/debts", { customerId: c1, amount: LIMIT_MM, id: crypto.randomUUID() });
  ok(r.status === 201, `dette de ${CREDIT_LIMIT} DT acceptée (201)`);
  r = await api(ownerTok, "POST", "/credits/debts", { customerId: c1, amount: 1, id: crypto.randomUUID() });
  ok(r.status === 409, `${CREDIT_LIMIT},001 DT refusé (409)`);
  ok(r.data && /Plafond/.test(r.data.error || ""), "message de refus mentionne le plafond");

  console.log("== Concurrence : deux dettes simultanées ==");
  const c2 = await seedCustomer(shop.id, owner.id);
  const half = Math.floor(LIMIT_MM / 2) + 1; // deux fois >> plafond
  const [ra, rb] = await Promise.all([
    api(ownerTok, "POST", "/credits/debts", { customerId: c2, amount: half, id: crypto.randomUUID() }),
    api(ownerTok, "POST", "/credits/debts", { customerId: c2, amount: half, id: crypto.randomUUID() }),
  ]);
  const okCount = [ra.status, rb.status].filter((s) => s === 201).length;
  const conflictCount = [ra.status, rb.status].filter((s) => s === 409).length;
  ok(okCount === 1 && conflictCount === 1, "une seule des deux dettes passe (1×201, 1×409)");
  const { rows: bal2 } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::bigint b FROM credits WHERE customer_id=$1`, [c2]);
  ok(Number(bal2[0].b) <= LIMIT_MM, "solde final ≤ plafond");

  console.log("== Remboursement non limité ==");
  r = await api(cashierTok, "POST", "/credits/repayments", { customerId: c1, amount: LIMIT_MM, id: crypto.randomUUID() });
  ok(r.status === 201, "remboursement du solde complet accepté (201)");

  console.log("== Nouvelle dette refusée sans photo ==");
  const c3 = await seedCustomer(shop.id, owner.id, { photo: false });
  r = await api(ownerTok, "POST", "/credits/debts", { customerId: c3, amount: 1000, id: crypto.randomUUID() });
  ok(r.status === 409 && /CIN/.test(r.data?.error || ""), "dette refusée sans photo de CIN (409)");

  console.log("== Isolation par shop_id ==");
  r = await api(owner2Tok, "GET", "/credits/customers");
  ok(r.status === 200 && !r.data.customers.some((c) => c.id === c1), "boutique 2 ne voit pas les créditeurs de la boutique 1");
  r = await api(owner2Tok, "POST", "/credits/debts", { customerId: c1, amount: 1000, id: crypto.randomUUID() });
  ok(r.status === 404, "dette sur un créditeur d'une autre boutique refusée (404)");

  console.log("== Vente à crédit (une transaction) ==");
  const c4 = await seedCustomer(shop.id, owner.id);
  const saleId = crypto.randomUUID();
  r = await api(cashierTok, "POST", "/sales", {
    id: saleId, customerId: c4, lines: [{ productId: product.id, quantity: 1 }],
  });
  ok(r.status === 201 && r.data.paymentMethod === "CREDIT", "vente à crédit enregistrée (201, CREDIT)");
  const { rows: cl } = await pool.query(
    `SELECT amount, sale_id FROM credits WHERE shop_id=$1 AND customer_id=$2`, [shop.id, c4]);
  // `credits.sale_id` référence sales.id (généré serveur), pas le client_sale_id.
  ok(cl.length === 1 && Number(cl[0].amount) === 50000 && cl[0].sale_id === r.data.sale.id,
    "dette liée au sale_id (50000 millimes)");
  const { rows: cm } = await pool.query(`SELECT COUNT(*)::int n FROM cash_movements WHERE shop_id=$1`, [shop.id]);
  ok(cm[0].n === 0, "la vente à crédit n'ajoute AUCUN mouvement de caisse");

  r = await api(cashierTok, "POST", "/sales", {
    id: crypto.randomUUID(), customerId: c4, lines: [{ productId: product.id, quantity: 2 }],
  });
  ok(r.status === 409, "vente à crédit dépassant le plafond refusée (409)");
  const { rows: sc } = await pool.query(
    `SELECT COUNT(*)::int n FROM sales WHERE shop_id=$1 AND customer_id=$2`, [shop.id, c4]);
  ok(sc[0].n === 1, "aucune vente supplémentaire enregistrée après refus");

  console.log("== CIN : lecture (rôle) ==");
  r = await api(cashierTok, "GET", `/credits/customers/${c1}/cin`);
  ok(r.status === 403, "CASHIER ne peut pas lire la CIN (403)");

  if (hasStorage) {
    console.log("== CIN : création, lecture OWNER, suppression (stockage configuré) ==");
    const phone = "2" + String(crypto.randomInt(1000000, 9999999));
    const cin = String(crypto.randomInt(10000000, 99999999));
    r = await upload(ownerTok, "POST", "/credits/customers",
      { firstName: "Sami", familyName: "Photo", phone, cin, consent: "true" },
      { buffer: PNG_1x1, name: "cin.png", type: "image/png" });
    ok(r.status === 201 && r.data.customer.hasCin === true, "création profil avec photo (201, hasCin)");
    const cid = r.data.customer?.id;

    r = await api(ownerTok, "GET", `/credits/customers/${cid}/cin`);
    ok(r.status === 200 && typeof r.data.url === "string" && r.data.expiresIn === 60,
      "OWNER obtient une URL signée (60 s)");
    r = await api(cashierTok, "GET", `/credits/customers/${cid}/cin`);
    ok(r.status === 403, "CASHIER refuse toujours (403)");

    const { rows: before } = await pool.query(`SELECT COUNT(*)::int n FROM credits WHERE shop_id=$1`, [shop.id]);
    r = await api(ownerTok, "DELETE", `/credits/customers/${cid}/cin`);
    ok(r.status === 200 && r.data.hasCin === false, "suppression CIN (200, hasCin=false)");
    const { rows: after } = await pool.query(
      `SELECT cin_photo_path AS p FROM customers WHERE id=$1`, [cid]);
    ok(after[0].p === null, "chemin CIN mis à NULL");
    const { rows: afterCnt } = await pool.query(`SELECT COUNT(*)::int n FROM credits WHERE shop_id=$1`, [shop.id]);
    ok(afterCnt[0].n === before[0].n, "lignes `credits` intactes après suppression CIN");
    r = await api(ownerTok, "GET", `/credits/customers/${cid}/cin`);
    ok(r.status === 404, "plus de photo : lecture CIN -> 404");

    // Nettoyage best-effort du fichier éventuellement resté dans le bucket.
    r = await api(ownerTok, "DELETE", `/credits/customers/${cid}/cin`);
    ok(r.status === 409 || r.status === 200, "suppression idempotente (409 sans photo)");
  } else {
    skipped("création/lecture OWNER/suppression CIN (SUPABASE_URL + SERVICE_ROLE non configurés)");
  }

  console.log("== Outbox ==");
  const outboxId = await outbox.enqueue(pool, {
    shopId: shop.id, type: "CREDIT_PROFILE_CREATED",
    payload: { firstName: "Test", familyName: "Outbox", phone: "20000000", createdAt: new Date().toISOString(), cashierName: "Caissier" },
  });
  const { rows: ob } = await pool.query(`SELECT status, attempts FROM notification_outbox WHERE id=$1`, [outboxId]);
  ok(ob.length === 1 && ob[0].status === "pending" && ob[0].attempts === 0, "notification enregistrée en 'pending'");
  // Sans SMTP : la tentative n'est pas consommée (repartira une fois configuré).
  const mailer = require("../src/services/mailer");
  if (!mailer.isConfigured()) {
    await outbox.processPending(pool);
    const { rows: ob2 } = await pool.query(`SELECT status, attempts FROM notification_outbox WHERE id=$1`, [outboxId]);
    ok(ob2[0].status === "pending" && ob2[0].attempts === 0, "sans SMTP : reste 'pending', tentatives intactes");
  } else {
    skipped("comportement sans SMTP (SMTP configuré)");
  }

  console.log(`\n=== Résultat : ${pass} PASS, ${fail} FAIL, ${skip} SKIP ===`);
  await cleanup();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
