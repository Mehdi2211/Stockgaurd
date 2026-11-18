// Crée une boutique de démo (OWNER + CASHIER + produits) et affiche
// les jetons JWT à coller dans le navigateur pour tester l'interface.
// Usage : node scripts/gen-demo-token.js

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const sign = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const shopCode = `DEMO${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const shop = await client.query(
      `INSERT INTO shops (name, code) VALUES ('Boutique Démo', $1) RETURNING id`,
      [shopCode]
    );
    const shopId = shop.rows[0].id;

    const owner = await client.query(
      `INSERT INTO app_users (shop_id, name, role, email, password_hash)
       VALUES ($1, 'Propriétaire Démo', 'OWNER', $2, 'demo') RETURNING id`,
      [shopId, `owner-${shopCode.toLowerCase()}@demo.local`]
    );
    const ownerId = owner.rows[0].id;

    const cashier = await client.query(
      `INSERT INTO app_users (shop_id, name, role, pin_hash)
       VALUES ($1, 'Caissier Démo', 'CASHIER', 'demo') RETURNING id`,
      [shopId]
    );
    const cashierId = cashier.rows[0].id;

    const products = [
      ["6190000000011", "Lait demi-écrémé 1 L", 1450, 42],
      ["6190000000028", "Pain baguette", 250, 18],
      ["6190000000035", "Huile d'olive 1 L", 14900, 10],
      ["6190000000042", "Harissa 380 g", 2300, 25],
    ];
    for (const [barcode, name, price, stock] of products) {
      await client.query(
        `INSERT INTO products (shop_id, barcode, name, price, current_stock)
         VALUES ($1, $2, $3, $4, $5)`,
        [shopId, barcode, name, price, stock]
      );
    }

    await client.query("COMMIT");

    console.log("\n=== Boutique démo créée ===");
    console.log("shop_id :", shopId);
    console.log("code    :", shopCode);
    console.log("\n=== Jeton OWNER (pour /owner/cash-register) ===");
    console.log(sign({ userId: ownerId, shopId, role: "OWNER" }));
    console.log("\n=== Jeton CASHIER (pour la caisse) ===");
    console.log(sign({ userId: cashierId, shopId, role: "CASHIER" }));
    console.log("\n=== Dans le navigateur (console) ===");
    console.log('localStorage.setItem("sg_token", "<jeton OWNER>");');
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("ERREUR :", e.message); process.exit(1); });
