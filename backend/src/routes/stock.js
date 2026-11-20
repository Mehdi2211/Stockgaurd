const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOVEMENT_TYPES = new Set(["INITIAL", "RESTOCK", "SALE", "ADJUSTMENT"]);
const MAX_QTY = 999999;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// ---------------------------------------------------------------------
// GET /api/stock/movements — journal paginé des mouvements de la boutique.
// ?productId=, ?type=, ?page=, ?limit=
// ---------------------------------------------------------------------
router.get("/movements", requireAuth, async (req, res) => {
  const params = [req.user.shopId];
  let where = `sm.shop_id = $1`;

  if (typeof req.query.productId === "string" && req.query.productId !== "") {
    if (!UUID_RE.test(req.query.productId)) {
      return res.status(400).json({ error: "Identifiant produit invalide." });
    }
    params.push(req.query.productId);
    where += ` AND sm.product_id = $${params.length}`;
  }
  if (typeof req.query.type === "string" && req.query.type !== "") {
    if (!MOVEMENT_TYPES.has(req.query.type)) {
      return res.status(400).json({ error: "Type de mouvement invalide." });
    }
    params.push(req.query.type);
    where += ` AND sm.type = $${params.length}`;
  }

  const limit = clamp(int(req.query.limit, 200), 1, 500);
  const page = clamp(int(req.query.page, 1), 1, 100000);
  const offset = (page - 1) * limit;

  try {
    const { rows: countRows } = await req.db.query(
      `SELECT COUNT(*)::int AS total FROM stock_movements sm WHERE ${where}`,
      params
    );
    const { rows } = await req.db.query(
      `SELECT sm.id, sm.type, sm.quantity, sm.reason,
              sm.created_at AS "createdAt",
              sm.product_id AS "productId", p.name AS "productName",
              s.number AS "saleNumber"
         FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id
         LEFT JOIN sales s ON s.id = sm.sale_id
        WHERE ${where}
        ORDER BY sm.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({
      movements: rows.map((m) => ({ ...m, quantity: Number(m.quantity) })),
      total: countRows[0].total,
      page,
      limit,
    });
  } catch (err) {
    console.error("[stock] movements:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

// ---------------------------------------------------------------------
// POST /api/stock/adjustment — OWNER uniquement.
// Ajustement manuel signé (perte, casse, correction). Écrit un mouvement
// de type ADJUSTMENT et met à jour le stock, dans UNE transaction.
// Body : { productId, quantity (<> 0, +/−), reason (3 à 200 caractères) }
// ---------------------------------------------------------------------
router.post("/adjustment", requireAuth, requireRole("OWNER"), async (req, res) => {
  const productId = req.body?.productId;
  const quantity = req.body?.quantity;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

  if (typeof productId !== "string" || !UUID_RE.test(productId)) {
    return res.status(400).json({ error: "Identifiant produit invalide." });
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > MAX_QTY) {
    return res.status(400).json({ error: "Quantité invalide (nombre non nul)." });
  }
  if (reason.length < 3 || reason.length > 200) {
    return res.status(400).json({ error: "Motif invalide (3 à 200 caractères)." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");

    // Verrouille le produit : sérialise les ajustements concurrents.
    const { rows: prod } = await client.query(
      `SELECT id FROM products WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
      [req.user.shopId, productId]
    );
    if (prod.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Produit introuvable." });
    }

    const { rows } = await client.query(
      `INSERT INTO stock_movements (shop_id, product_id, type, quantity, reason, recorded_by)
       VALUES ($1, $2, 'ADJUSTMENT', $3, $4, $5)
       RETURNING id, type, quantity, reason, created_at AS "createdAt", product_id AS "productId"`,
      [req.user.shopId, productId, quantity, reason, req.user.userId]
    );

    await client.query(
      `UPDATE products SET current_stock = current_stock + $2, updated_at = now()
        WHERE shop_id = $1 AND id = $3`,
      [req.user.shopId, quantity, productId]
    );

    await client.query("COMMIT");
    res.status(201).json({ movement: { ...rows[0], quantity: Number(rows[0].quantity) } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[stock] adjustment:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  } finally {
    client.release();
  }
});

module.exports = router;
