const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARCODE_RE = /^[\x20-\x7E]{4,32}$/; // caractères imprimables ASCII
const MAX_PRICE = 999999999;   // millimes (~999 999 DT)
const MAX_STOCK = 9999999;

const PRODUCT_COLS = `id, barcode, name, category, price,
  buy_price AS "buyPrice", current_stock AS "currentStock",
  min_stock AS "minStock", is_active AS "isActive",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function parseName(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || t.length > 120) return null;
  return t;
}
function parseCategory(v) {
  if (v === undefined || v === null || v === "") return null; // facultatif
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || t.length > 60) return null;
  return t;
}
function parsePrice(v) {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < 0 || v > MAX_PRICE) return null;
  return v;
}
// Prix d'achat : facultatif, entier en millimes >= 0.
function parseBuyPrice(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) return NaN; // signal invalide
  if (v < 0 || v > MAX_PRICE) return NaN;
  return v;
}
function parseStock(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > MAX_STOCK) return null;
  return v;
}
function parseBarcode(v) {
  if (v === undefined || v === null || v === "") return null; // facultatif
  if (typeof v !== "string" || !BARCODE_RE.test(v.trim())) return null;
  return v.trim();
}

// Sérialisation : bigint -> number pour les montants (millimes).
function toProduct(p) {
  return {
    ...p,
    price: Number(p.price),
    buyPrice: p.buyPrice === null ? null : Number(p.buyPrice),
  };
}

// ---------------------------------------------------------------------
// GET /api/products — liste paginée + recherche.
// ?q= (nom ou code-barres), ?page=, ?limit=, ?all=true (OWNER, inactifs).
// Contrat conservé : réponse { products: [...] }.
// ---------------------------------------------------------------------
router.get("/", requireAuth, async (req, res) => {
  const wantAll = req.query.all === "true";
  if (wantAll && req.user.role !== "OWNER") {
    return res.status(403).json({ error: "Accès réservé au propriétaire." });
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limit = clamp(int(req.query.limit, 500), 1, 1000);
  const page = clamp(int(req.query.page, 1), 1, 100000);
  const offset = (page - 1) * limit;

  const params = [req.user.shopId];
  let where = `shop_id = $1 ${wantAll ? "" : "AND is_active"}`;
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR barcode LIKE $${params.length})`;
  }

  try {
    const { rows: countRows } = await req.db.query(
      `SELECT COUNT(*)::int AS total FROM products WHERE ${where}`,
      params
    );
    const { rows } = await req.db.query(
      `SELECT ${PRODUCT_COLS} FROM products
        WHERE ${where}
        ORDER BY name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({
      products: rows.map(toProduct),
      total: countRows[0].total,
      page,
      limit,
    });
  } catch (err) {
    console.error("[products] GET:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

// GET /api/products/barcode/:barcode — recherche par code-barres (scan).
router.get("/barcode/:barcode", requireAuth, async (req, res) => {
  const barcode = req.params.barcode.trim();
  if (!BARCODE_RE.test(barcode)) {
    return res.status(400).json({ error: "Code-barres invalide." });
  }
  try {
    const { rows } = await req.db.query(
      `SELECT ${PRODUCT_COLS} FROM products
        WHERE shop_id = $1 AND barcode = $2`,
      [req.user.shopId, barcode]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Produit introuvable." });
    }
    res.json({ product: toProduct(rows[0]) });
  } catch (err) {
    console.error("[products] barcode:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

// GET /api/products/:id — détail.
router.get("/:id", requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: "Identifiant produit invalide." });
  }
  try {
    const { rows } = await req.db.query(
      `SELECT ${PRODUCT_COLS} FROM products WHERE shop_id = $1 AND id = $2`,
      [req.user.shopId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Produit introuvable." });
    res.json({ product: toProduct(rows[0]) });
  } catch (err) {
    console.error("[products] detail:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

// ---------------------------------------------------------------------
// POST /api/products — OWNER. Crée un produit (+ mouvement INITIAL si
// stock initial > 0). Le prix est en millimes entiers.
// ---------------------------------------------------------------------
router.post("/", requireAuth, requireRole("OWNER"), async (req, res) => {
  const name = parseName(req.body?.name);
  const price = parsePrice(req.body?.price);
  const barcode = parseBarcode(req.body?.barcode);
  const category = parseCategory(req.body?.category);
  const buyPrice = parseBuyPrice(req.body?.buyPrice);
  const initialStock = parseStock(req.body?.initialStock ?? 0);
  const minStock = parseStock(req.body?.minStock ?? 0);

  if (name === null) return res.status(400).json({ error: "Nom invalide (1 à 120 caractères)." });
  if (price === null) return res.status(400).json({ error: "Prix invalide (entier en millimes, >= 0)." });
  if (req.body?.barcode && barcode === null) {
    return res.status(400).json({ error: "Code-barres invalide (4 à 32 caractères imprimables)." });
  }
  if (req.body?.category && category === null) {
    return res.status(400).json({ error: "Catégorie invalide (60 caractères max)." });
  }
  if (Number.isNaN(buyPrice)) {
    return res.status(400).json({ error: "Prix d'achat invalide (entier en millimes, >= 0)." });
  }
  if (initialStock === null || minStock === null) {
    return res.status(400).json({ error: "Stock invalide." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO products (shop_id, barcode, name, category, price, buy_price, current_stock, min_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PRODUCT_COLS}`,
      [req.user.shopId, barcode, name, category, price, buyPrice, initialStock, minStock]
    );
    const product = rows[0];

    if (initialStock > 0) {
      await client.query(
        `INSERT INTO stock_movements (shop_id, product_id, type, quantity, reason, recorded_by)
         VALUES ($1, $2, 'INITIAL', $3, 'Stock initial', $4)`,
        [req.user.shopId, product.id, initialStock, req.user.userId]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ product: toProduct(product) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") {
      return res.status(409).json({ error: "Ce code-barres existe déjà dans la boutique." });
    }
    console.error("[products] POST:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// PUT /api/products/:id — OWNER. Met à jour les champs modifiables.
// ---------------------------------------------------------------------
router.put("/:id", requireAuth, requireRole("OWNER"), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: "Identifiant produit invalide." });
  }
  const name = parseName(req.body?.name);
  const price = parsePrice(req.body?.price);
  const barcode = parseBarcode(req.body?.barcode);
  const category = parseCategory(req.body?.category);
  const buyPrice = parseBuyPrice(req.body?.buyPrice);
  const minStock = parseStock(req.body?.minStock ?? 0);
  const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : null;

  if (name === null) return res.status(400).json({ error: "Nom invalide (1 à 120 caractères)." });
  if (price === null) return res.status(400).json({ error: "Prix invalide (entier en millimes, >= 0)." });
  if (req.body?.barcode && barcode === null) {
    return res.status(400).json({ error: "Code-barres invalide (4 à 32 caractères imprimables)." });
  }
  if (req.body?.category && category === null) {
    return res.status(400).json({ error: "Catégorie invalide (60 caractères max)." });
  }
  if (Number.isNaN(buyPrice)) {
    return res.status(400).json({ error: "Prix d'achat invalide (entier en millimes, >= 0)." });
  }
  if (minStock === null) return res.status(400).json({ error: "Stock minimum invalide." });

  try {
    const { rows } = await req.db.query(
      `UPDATE products
          SET name = $3, price = $4, barcode = $5, min_stock = $6,
              category = $7, buy_price = $8,
              is_active = COALESCE($9, is_active), updated_at = now()
        WHERE shop_id = $1 AND id = $2
        RETURNING ${PRODUCT_COLS}`,
      [req.user.shopId, req.params.id, name, price, barcode, minStock, category, buyPrice, isActive]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Produit introuvable." });
    res.json({ product: toProduct(rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Ce code-barres existe déjà dans la boutique." });
    }
    console.error("[products] PUT:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
