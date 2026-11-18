const express = require("express");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const { authenticate, requireStaff } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------
// GET /api/customers/search?q=... — recherche client pour remboursement.
// OWNER et CASHIER. q : 3 caractères min, nom / prénom / téléphone / CIN
// (insensible à la casse, contient). Max 5 résultats, champs minimaux :
// jamais le CIN complet, le téléphone ni le hash PIN.
// Rate-limit : 30 requêtes / minute / utilisateur.
// ---------------------------------------------------------------------
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: "Trop de recherches. Réessayez dans une minute." },
});

router.get("/search", authenticate, requireStaff, searchLimiter, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 3) {
    return res.status(400).json({ error: "La recherche doit contenir au moins 3 caractères." });
  }
  if (q.length > 100) {
    return res.status(400).json({ error: "Recherche trop longue." });
  }

  // Echappe les jokers ILIKE (% et _) pour une recherche litterale.
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.first_name, c.family_name, c.cin,
              COALESCE(SUM(cr.amount), 0)::bigint AS balance
         FROM customers c
         LEFT JOIN credits cr ON cr.customer_id = c.id
        WHERE c.shop_id = $1
          AND (lower(c.first_name)  LIKE lower($2) ESCAPE '\\'
            OR lower(c.family_name) LIKE lower($2) ESCAPE '\\'
            OR c.phone LIKE $2 ESCAPE '\\'
            OR c.cin   LIKE $2 ESCAPE '\\')
        GROUP BY c.id
        ORDER BY c.family_name, c.first_name
        LIMIT 5`,
      [req.user.shopId, pattern]
    );

    res.json({
      customers: rows.map((r) => ({
        id: r.id,
        firstName: r.first_name,
        familyName: r.family_name,
        balance: Number(r.balance),
        maskedCin: `******${String(r.cin).slice(-2)}`,
      })),
    });
  } catch (err) {
    console.error("[customers/search]", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
