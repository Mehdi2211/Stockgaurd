const express = require("express");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARCODE_RE = /^[\x20-\x7E]{1,32}$/; // imprimables ASCII (1 à 32)
const STATUSES = new Set(["matched", "unknown", "sold", "cancelled"]);
const MAX_QTY = 999999;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const SCAN_COLS = `ps.id, ps.barcode, ps.quantity, ps.status,
  ps.scanned_at AS "scannedAt", ps.product_id AS "productId",
  ps.sale_id AS "saleId", u.name AS "scannedByName"`;

function toScan(r) {
  return { ...r, quantity: Number(r.quantity) };
}

// ---------------------------------------------------------------------
// POST /api/scans — enregistre un scan (lecteur USB ou saisie manuelle).
// Cherche le produit par (shop_id, barcode) issu du JETON. N'affecte NI
// le stock NI la caisse : c'est un simple journal (status 'matched' si
// le produit existe, 'unknown' sinon). Retourne le produit trouvé.
// Body : { barcode, quantity? } — quantity défaut 1.
// ---------------------------------------------------------------------
router.post("/", requireAuth, async (req, res) => {
  const barcode = typeof req.body?.barcode === "string" ? req.body.barcode.trim() : "";
  if (!BARCODE_RE.test(barcode)) {
    return res.status(400).json({ error: "Code-barres invalide (1 à 32 caractères)." });
  }

  const rawQty = req.body?.quantity ?? 1;
  if (typeof rawQty !== "number" || !Number.isFinite(rawQty) || rawQty <= 0 || rawQty > MAX_QTY) {
    return res.status(400).json({ error: "Quantité invalide." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");

    const { rows: prod } = await client.query(
      `SELECT id, barcode, name, category, price, buy_price AS "buyPrice",
              current_stock AS "currentStock", min_stock AS "minStock",
              is_active AS "isActive"
         FROM products
        WHERE shop_id = $1 AND barcode = $2`,
      [req.user.shopId, barcode]
    );
    const product = prod[0] || null;
    const status = product ? "matched" : "unknown";

    const { rows } = await client.query(
      `INSERT INTO product_scans (shop_id, product_id, barcode, quantity, scanned_by, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, barcode, quantity, status, scanned_at AS "scannedAt", product_id AS "productId"`,
      [req.user.shopId, product ? product.id : null, barcode, rawQty, req.user.userId, status]
    );

    await client.query("COMMIT");
    res.status(201).json({
      scan: toScan(rows[0]),
      product: product
        ? { ...product, price: Number(product.price), buyPrice: product.buyPrice === null ? null : Number(product.buyPrice) }
        : null,
      status,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[scans] POST:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// GET /api/scans — journal paginé, filtré par période, utilisateur,
// statut. Toujours borné à la boutique du jeton.
// ?from= ISO, ?to= ISO, ?userId= uuid, ?status=, ?page=, ?limit=
// ---------------------------------------------------------------------
router.get("/", requireAuth, async (req, res) => {
  const params = [req.user.shopId];
  let where = `ps.shop_id = $1`;

  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  if (from && !Number.isNaN(from.getTime())) {
    params.push(from.toISOString());
    where += ` AND ps.scanned_at >= $${params.length}`;
  }
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if (to && !Number.isNaN(to.getTime())) {
    params.push(to.toISOString());
    where += ` AND ps.scanned_at < $${params.length}`;
  }

  if (typeof req.query.userId === "string" && req.query.userId !== "") {
    if (!UUID_RE.test(req.query.userId)) {
      return res.status(400).json({ error: "Identifiant utilisateur invalide." });
    }
    params.push(req.query.userId);
    where += ` AND ps.scanned_by = $${params.length}`;
  }

  if (typeof req.query.status === "string" && req.query.status !== "") {
    if (!STATUSES.has(req.query.status)) {
      return res.status(400).json({ error: "Statut invalide." });
    }
    params.push(req.query.status);
    where += ` AND ps.status = $${params.length}`;
  }

  const limit = clamp(int(req.query.limit, 100), 1, 500);
  const page = clamp(int(req.query.page, 1), 1, 100000);
  const offset = (page - 1) * limit;

  try {
    const { rows: countRows } = await req.db.query(
      `SELECT COUNT(*)::int AS total FROM product_scans ps WHERE ${where}`,
      params
    );
    const { rows } = await req.db.query(
      `SELECT ${SCAN_COLS}
         FROM product_scans ps
         JOIN app_users u ON u.id = ps.scanned_by
        WHERE ${where}
        ORDER BY ps.scanned_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({
      scans: rows.map(toScan),
      total: countRows[0].total,
      page,
      limit,
    });
  } catch (err) {
    console.error("[scans] GET:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
