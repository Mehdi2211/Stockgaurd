const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------
// GET /api/owner/stats — OWNER. Indicateurs du tableau de bord, calculés
// en UNE requête (sous-requêtes scalaires, pas de N+1). "Aujourd'hui" =
// jour courant du serveur (date_trunc).
// ---------------------------------------------------------------------
router.get("/stats", requireAuth, requireRole("OWNER"), async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
         (SELECT COALESCE(SUM(total), 0)::bigint FROM sales
           WHERE shop_id = $1 AND created_at >= date_trunc('day', now())) AS "salesToday",
         (SELECT COUNT(*)::int FROM sales
           WHERE shop_id = $1 AND created_at >= date_trunc('day', now())) AS "countToday",
         (SELECT COALESCE(SUM(bal), 0)::bigint FROM (
             SELECT SUM(amount) AS bal FROM credits
              WHERE shop_id = $1 GROUP BY customer_id
           ) t WHERE bal > 0) AS "totalCredit",
         (SELECT COUNT(*)::int FROM customers WHERE shop_id = $1 AND status = 'VALIDATED') AS "activeCustomers",
         (SELECT COUNT(*)::int FROM products  WHERE shop_id = $1 AND is_active)           AS "activeProducts",
         (SELECT COUNT(*)::int FROM customers WHERE shop_id = $1 AND status = 'PENDING')   AS "pendingCustomers"`,
      [req.user.shopId]
    );
    const s = rows[0];
    res.json({
      salesToday: Number(s.salesToday),
      countToday: s.countToday,
      totalCredit: Number(s.totalCredit),
      activeCustomers: s.activeCustomers,
      activeProducts: s.activeProducts,
      pendingCustomers: s.pendingCustomers,
    });
  } catch (err) {
    console.error("[owner] stats:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
