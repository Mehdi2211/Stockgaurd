const express = require("express");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/shop/me — boutique du jeton courant (jamais de code en dur).
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT id, name, code FROM shops WHERE id = $1`,
      [req.user.shopId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Boutique introuvable." });
    }
    res.json({ shop: rows[0] });
  } catch (err) {
    console.error("[shop] me:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
