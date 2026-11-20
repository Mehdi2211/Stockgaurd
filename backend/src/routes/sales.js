const express = require("express");
const { authenticate } = require("../middleware/auth");
const { creditLimitMillimes } = require("../constants/credit");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatDT(millimes) {
  const n = Number(millimes) || 0;
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 1000)},${String(abs % 1000).padStart(3, "0")} DT`;
}

// ---------------------------------------------------------------------
// POST /api/sales — OWNER ou CASHIER
// Body : { id: uuid (client_sale_id), lines: [{ productId, quantity }],
//          customerId?: uuid }
// Le serveur recalcule les prix et le total depuis la base ; tout prix
// ou total envoyé par le client est ignoré. Idempotent via
// (shop_id, client_sale_id) : une reprise avec le même id ne crée pas
// de seconde vente. Les mouvements de stock sont insérés dans la même
// transaction (pas de trigger en base pour l'instant).
//   - customerId absent  => vente en espèces (customer_id NULL).
//   - customerId présent => vente à CRÉDIT : la vente ET la ligne
//     `credits` liée au sale_id sont créées dans UNE SEULE transaction.
//     Le solde du créditeur ne peut dépasser CREDIT_LIMIT : sinon 409 et
//     RIEN n'est enregistré (ni vente, ni stock, ni crédit).
// ---------------------------------------------------------------------
router.post("/", authenticate, async (req, res) => {
  const clientSaleId = req.body?.id;
  const rawLines = req.body?.lines;
  const customerId = req.body?.customerId;

  if (typeof clientSaleId !== "string" || !UUID_RE.test(clientSaleId)) {
    return res.status(400).json({ error: "Identifiant de vente invalide (UUID attendu)." });
  }
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > 200) {
    return res.status(400).json({ error: "Le panier doit contenir entre 1 et 200 lignes." });
  }
  if (customerId != null && (typeof customerId !== "string" || !UUID_RE.test(customerId))) {
    return res.status(400).json({ error: "Identifiant créditeur invalide." });
  }

  // Fusionne les produits répétés et valide les quantités.
  const merged = new Map();
  for (const l of rawLines) {
    const productId = l?.productId;
    const qty = l?.quantity;
    if (typeof productId !== "string" || !UUID_RE.test(productId)) {
      return res.status(400).json({ error: "Identifiant produit invalide." });
    }
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0 || qty > 999999) {
      return res.status(400).json({ error: "Quantité invalide." });
    }
    merged.set(productId, (merged.get(productId) || 0) + qty);
  }

  const productIds = [...merged.keys()];
  const client = await req.db.connect();
  try {
    await client.query("BEGIN");

    // Verrouille les produits pour éviter les ventes concurrentes.
    const { rows: products } = await client.query(
      `SELECT id, price FROM products
        WHERE shop_id = $1 AND id = ANY($2::uuid[]) AND is_active
        FOR UPDATE`,
      [req.user.shopId, productIds]
    );

    if (products.length !== productIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Un ou plusieurs produits sont inconnus ou inactifs." });
    }

    const priceById = new Map(products.map((p) => [p.id, Number(p.price)]));

    // Prix et total calculés par le serveur (millimes, entiers).
    const lines = productIds.map((productId) => {
      const quantity = merged.get(productId);
      const unitPrice = priceById.get(productId);
      return { productId, quantity, unitPrice, lineTotal: Math.round(quantity * unitPrice) };
    });
    const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);

    if (total <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Le total de la vente doit être positif." });
    }

    // Vente à crédit : contrôle du créditeur et du plafond AVANT toute
    // écriture. Le verrou sérialise deux ventes simultanées du même
    // créditeur (le total des deux ne peut pas dépasser le plafond).
    if (customerId) {
      const { rows: cust } = await client.query(
        `SELECT id, status, cin_photo_path FROM customers
          WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
        [req.user.shopId, customerId]
      );
      if (cust.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Créditeur introuvable." });
      }
      if (cust[0].status !== "VALIDATED") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Ce créditeur doit être validé avant une vente à crédit." });
      }
      if (!cust[0].cin_photo_path) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Photo de CIN manquante : reprenez la photo du créditeur avant une vente à crédit." });
      }

      const { rows: bal } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::bigint AS balance
           FROM credits WHERE shop_id = $1 AND customer_id = $2`,
        [req.user.shopId, customerId]
      );
      const balance = Number(bal[0].balance);
      const limit = creditLimitMillimes();
      if (balance + total > limit) {
        await client.query("ROLLBACK");
        const available = Math.max(0, limit - balance);
        return res.status(409).json({
          error: `Plafond de crédit dépassé. Solde actuel : ${formatDT(balance)}, disponible : ${formatDT(available)}.`,
        });
      }
    }

    // Insert idempotent : en cas de conflit, on renvoie la vente existante.
    const { rows: inserted } = await client.query(
      `INSERT INTO sales (shop_id, client_sale_id, cashier_id, customer_id, total)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop_id, client_sale_id) DO NOTHING
       RETURNING *`,
      [req.user.shopId, clientSaleId, req.user.userId, customerId || null, total]
    );

    let sale = inserted[0];
    if (!sale) {
      const { rows } = await client.query(
        `SELECT * FROM sales WHERE shop_id = $1 AND client_sale_id = $2`,
        [req.user.shopId, clientSaleId]
      );
      sale = rows[0];
      await client.query("COMMIT");
      return res.status(200).json({ sale, lines: await fetchLines(client, sale.id) });
    }

    for (const l of lines) {
      await client.query(
        `INSERT INTO sale_lines (sale_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [sale.id, l.productId, l.quantity, l.unitPrice]
      );

      // Mouvement de stock (quantité négative) + décrément du stock.
      await client.query(
        `INSERT INTO stock_movements (shop_id, product_id, type, quantity, reason, sale_id, recorded_by)
         VALUES ($1, $2, 'SALE', $3, 'Vente caisse', $4, $5)`,
        [req.user.shopId, l.productId, -l.quantity, sale.id, req.user.userId]
      );

      await client.query(
        `UPDATE products SET current_stock = current_stock - $2 WHERE id = $1`,
        [l.productId, l.quantity]
      );
    }

    // Vente à crédit : dette liée à la vente (sale_id) dans la MÊME
    // transaction. Une vente à crédit n'entre PAS dans le montant attendu
    // de caisse (seuls les remboursements y entrent).
    if (customerId) {
      await client.query(
        `INSERT INTO credits (shop_id, customer_id, sale_id, amount, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.shopId, customerId, sale.id, total, "Vente à crédit", req.user.userId]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({
      sale,
      paymentMethod: customerId ? "CREDIT" : "CASH",
      lines: await fetchLines(client, sale.id),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[sales] POST:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  } finally {
    client.release();
  }
});

async function fetchLines(client, saleId) {
  const { rows } = await client.query(
    `SELECT sl.id, sl.product_id AS "productId", sl.quantity,
            sl.unit_price AS "unitPrice", sl.line_total AS "lineTotal",
            p.name AS "productName"
       FROM sale_lines sl
       JOIN products p ON p.id = sl.product_id
      WHERE sl.sale_id = $1
      ORDER BY sl.id`,
    [saleId]
  );
  return rows;
}

// ---------------------------------------------------------------------
// GET /api/sales — historique avec mode de paiement dérivé et caissier
// payment_method : 'CASH' si customer_id IS NULL, sinon 'CREDIT'.
// ---------------------------------------------------------------------
router.get("/", authenticate, async (req, res) => {
  try {
    const { rows: sales } = await req.db.query(
      `SELECT s.id, s.number AS "saleNumber", s.total,
              s.created_at AS "createdAt",
              CASE WHEN s.customer_id IS NULL THEN 'CASH' ELSE 'CREDIT' END AS "paymentMethod",
              u.name AS "cashierName"
         FROM sales s
         JOIN app_users u ON u.id = s.cashier_id
        WHERE s.shop_id = $1
        ORDER BY s.created_at DESC
        LIMIT 200`,
      [req.user.shopId]
    );

    if (sales.length === 0) return res.json({ sales: [] });

    const ids = sales.map((s) => s.id);
    const { rows: lines } = await req.db.query(
      `SELECT sl.sale_id, sl.id, sl.product_id AS "productId", sl.quantity,
              sl.unit_price AS "unitPrice", sl.line_total AS "lineTotal",
              p.name AS "productName"
         FROM sale_lines sl
         JOIN products p ON p.id = sl.product_id
        WHERE sl.sale_id = ANY($1::uuid[])
        ORDER BY sl.id`,
      [ids]
    );

    const bySale = new Map();
    for (const l of lines) {
      if (!bySale.has(l.sale_id)) bySale.set(l.sale_id, []);
      bySale.get(l.sale_id).push({
        id: l.id,
        productId: l.productId,
        productName: l.productName,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        lineTotal: Number(l.lineTotal),
      });
    }

    res.json({
      sales: sales.map((s) => ({
        ...s,
        total: Number(s.total),
        lines: bySale.get(s.id) || [],
      })),
    });
  } catch (err) {
    console.error("[sales] GET:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
