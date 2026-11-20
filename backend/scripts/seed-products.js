// Seed idempotent : insère un catalogue de produits d'exemple (18 articles)
// pour une boutique, avec des codes-barres factices uniques.
// Relançable sans risque : ON CONFLICT (shop_id, barcode) DO NOTHING.
// Un mouvement de stock INITIAL est créé pour chaque produit NOUVELLEMENT
// inséré ayant un stock > 0 (traçabilité), par le propriétaire de la boutique.
//
// Usage : node scripts/seed-products.js [CODE_BOUTIQUE]
//   CODE_BOUTIQUE par défaut : SEED_SHOP_CODE ou "SGDEMO01".
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const SHOP_CODE = (process.argv[2] || process.env.SEED_SHOP_CODE || "SGDEMO01").toUpperCase();

// [barcode, name, category, sellPrice, buyPrice, stock, minStock] — millimes.
const PRODUCTS = [
  ["6191234500011", "Lait demi-écrémé 1 L", "Crèmerie", 1450, 1150, 42, 10],
  ["6191234500028", "Pain baguette", "Boulangerie", 250, 150, 18, 5],
  ["6191234500035", "Huile d'olive 1 L", "Épicerie", 14900, 12000, 10, 3],
  ["6191234500042", "Harissa 380 g", "Épicerie", 2300, 1700, 25, 6],
  ["6191234500059", "Eau minérale 1,5 L", "Boissons", 900, 550, 60, 12],
  ["6191234500066", "Spaghetti 500 g", "Épicerie", 1100, 800, 33, 10],
  ["6191234500073", "Fromage Kiri x8", "Crèmerie", 4200, 3400, 15, 4],
  ["6191234500080", "Tomates 1 kg", "Fruits & légumes", 1800, 1200, 20, 5],
  ["6191234500097", "Sucre 1 kg", "Épicerie", 2100, 1700, 40, 10],
  ["6191234500103", "Café moulu 250 g", "Épicerie", 6500, 5200, 22, 5],
  ["6191234500110", "Riz 1 kg", "Épicerie", 2400, 1900, 30, 8],
  ["6191234500127", "Yaourt nature x4", "Crèmerie", 1600, 1200, 24, 6],
  ["6191234500134", "Jus d'orange 1 L", "Boissons", 2700, 2000, 18, 5],
  ["6191234500141", "Savon de Marseille", "Entretien", 1300, 900, 35, 10],
  ["6191234500158", "Détergent 2 L", "Entretien", 8900, 7100, 12, 3],
  ["6191234500165", "Boîte de thon 160 g", "Épicerie", 2200, 1700, 28, 8],
  ["6191234500172", "Biscuits sablés 200 g", "Épicerie", 1750, 1300, 26, 6],
  ["6191234500189", "Farine 1 kg", "Épicerie", 1500, 1150, 30, 8],
];

const useSsl = process.env.PGSSL === "require" || process.env.DATABASE_URL.includes("supabase");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const client = await pool.connect();
  try {
    const shop = (await client.query(`SELECT id FROM shops WHERE code = $1`, [SHOP_CODE])).rows[0];
    if (!shop) {
      throw new Error(`Boutique "${SHOP_CODE}" introuvable. Lancez d'abord : node scripts/seed-shop.js`);
    }
    const shopId = shop.id;

    const owner = (await client.query(
      `SELECT id FROM app_users WHERE shop_id = $1 AND role = 'OWNER' AND is_active
        ORDER BY created_at LIMIT 1`,
      [shopId]
    )).rows[0];

    let created = 0, skipped = 0;

    await client.query("BEGIN");
    for (const [barcode, name, category, price, buyPrice, stock, minStock] of PRODUCTS) {
      // ON CONFLICT sur l'index partiel (shop_id, barcode).
      const { rows } = await client.query(
        `INSERT INTO products (shop_id, barcode, name, category, price, buy_price, current_stock, min_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (shop_id, barcode) WHERE barcode IS NOT NULL DO NOTHING
         RETURNING id`,
        [shopId, barcode, name, category, price, buyPrice, stock, minStock]
      );

      if (rows.length === 0) { skipped++; continue; }
      created++;

      if (owner && stock > 0) {
        await client.query(
          `INSERT INTO stock_movements (shop_id, product_id, type, quantity, reason, recorded_by)
           VALUES ($1, $2, 'INITIAL', $3, 'Stock initial (seed)', $4)`,
          [shopId, rows[0].id, stock, owner.id]
        );
      }
    }
    await client.query("COMMIT");

    console.log(`Catalogue seedé pour ${SHOP_CODE} : ${created} créé(s), ${skipped} déjà présent(s).`);
    if (!owner && created > 0) {
      console.log("Note : aucun propriétaire actif — mouvements INITIAL non créés.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("ERREUR seed-products :", e.message); process.exit(1); });
