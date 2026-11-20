const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Validation du format email (identique à la contrainte CHECK de shops.notification_email).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// GET /api/shop/me — boutique du jeton courant (jamais de code en dur).
// `notificationEmail` sert aux notifications ; ce n'est PAS un email de
// connexion (le login reste par PIN).
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT id, name, code, notification_email AS "notificationEmail"
         FROM shops WHERE id = $1`,
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

// PUT /api/shop/notification-email — OWNER uniquement.
// Body : { notificationEmail } (chaîne vide => efface l'email).
router.put("/notification-email", requireAuth, requireRole("OWNER"), async (req, res) => {
  const raw = req.body?.notificationEmail;
  const email = typeof raw === "string" ? raw.trim() : "";
  if (email !== "" && (email.length > 254 || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: "Adresse email invalide." });
  }
  try {
    const { rows } = await req.db.query(
      `UPDATE shops SET notification_email = $2
        WHERE id = $1
        RETURNING id, notification_email AS "notificationEmail"`,
      [req.user.shopId, email || null]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Boutique introuvable." });
    }
    res.json({ shop: rows[0] });
  } catch (err) {
    if (err.code === "23514") {
      return res.status(400).json({ error: "Adresse email invalide." });
    }
    console.error("[shop] notification-email:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
