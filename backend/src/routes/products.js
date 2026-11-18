const express = require("express");
const pool = require("../db");
const { authenticate, requireOwner } = require("../middleware/auth");

const router = express.Router();

// GET /api/products — produits actifs de la boutique (caissier + owner).
// ?all=true (owner uniquement) inclut les produits inactifs.
router.get("/", authenticate, async (req, res) => {
  const wantAll = req.query.all === "true";
  if (wantAll && req.user.role !== "OWNER") {
    return res.status(403).json({ error: "Accès réservé au propriétaire." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, barcode, name, price, current_stock AS "currentStock", is_active AS "isActive"
         FROM products
        WHERE shop_id = $1 ${wantAll ? "" : "AND is_active"}
        ORDER BY name`,
      [req.user.shopId]
    );
    res.json({
      products: rows.map((p) => ({ ...p, price: Number(p.price) })),
    });
  } catch (err) {
    console.error("[products] GET:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
