const express = require("express");
const pool = require("../db");
const { authenticate, requireStaff } = require("../middleware/auth");

const router = express.Router();

// Toutes les routes crédits : OWNER ou CASHIER authentifié.
// shop_id / recorded_by viennent UNIQUEMENT du jeton vérifié.
router.use(authenticate, requireStaff);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 9999999999; // 9 999 999,999 DT en millimes

function isValidUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

// ---------------------------------------------------------------------
// POST /api/credits/repayments — enregistre un remboursement de dette.
// Body : { repaymentId (UUID), customerId (UUID), amount (millimes > 0) }.
//
// Une seule transaction :
//   1. verrou consultatif par boutique (sérialise avec la caisse) ;
//   2. verrou de la ligne client (FOR UPDATE) ;
//   3. vérifications (client de la boutique, dette > 0, montant <= dette) ;
//   4. INSERT credits (id = repaymentId, amount NÉGATIF, sale_id NULL) ;
//   5. audit_log (action 'credits.repayment') ;
//   6. COMMIT.
//
// Idempotent : un retry avec le même repaymentId ne crée rien et
// renvoie 200 avec les données d'origine.
// ---------------------------------------------------------------------
router.post("/repayments", async (req, res) => {
  const body = req.body || {};
  const repaymentId = body.repaymentId;
  const customerId = body.customerId;
  const amount = body.amount;

  // --- Validation d'entrée (400) ---
  if (!isValidUuid(repaymentId)) {
    return res.status(400).json({ error: "Identifiant de remboursement invalide.", field: "repaymentId" });
  }
  if (!isValidUuid(customerId)) {
    return res.status(400).json({ error: "Identifiant client invalide.", field: "customerId" });
  }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return res.status(400).json({ error: "Montant invalide (entier en millimes, > 0).", field: "amount" });
  }
  // Tout autre champ du body (shop_id, recorded_by, created_at, status…)
  // est ignoré : seules les valeurs du jeton sont utilisées.

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [req.user.shopId]);

    // Client de la boutique + verrou de ligne (sérialise les remboursements
    // concurrents sur ce client : le solde ne peut pas passer sous zéro).
    const custQ = await client.query(
      `SELECT id FROM customers WHERE id = $1 AND shop_id = $2 FOR UPDATE`,
      [customerId, req.user.shopId]
    );
    if (!custQ.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Client introuvable dans cette boutique.", field: "customerId" });
    }

    // Solde = somme des crédits du client (dette > 0).
    const balQ = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS balance
         FROM credits WHERE customer_id = $1`,
      [customerId]
    );
    const balance = Number(balQ.rows[0].balance);

    if (balance <= 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ce client n'a aucune dette.", field: "amount" });
    }
    if (amount > balance) {
      await client.query("ROLLBACK");
      const dt = (balance / 1000).toFixed(3).replace(/\.?0+$/, "");
      return res.status(409).json({
        error: `Le montant dépasse la dette du client (${dt} DT).`,
        field: "amount",
      });
    }

    // INSERT idempotent : id = repaymentId (PK). Un retry avec le même id
    // ne crée pas de seconde ligne.
    const insQ = await client.query(
      `INSERT INTO credits (id, shop_id, customer_id, sale_id, reverses_id, amount, note, recorded_by)
       VALUES ($1, $2, $3, NULL, NULL, $4, 'Remboursement de crédit', $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, amount, created_at`,
      [repaymentId, req.user.shopId, customerId, -amount, req.user.userId]
    );

    if (insQ.rows[0]) {
      // Première fois : audit + réponse 201.
      await client.query(
        `INSERT INTO audit_log (shop_id, actor_id, action, entity_type, entity_id, after_data, device_id)
         VALUES ($1, $2, 'credits.repayment', 'credit', $3, $4, $5)`,
        [
          req.user.shopId,
          req.user.userId,
          repaymentId,
          JSON.stringify({ customerId, amount: -amount, newBalance: balance - amount }),
          req.headers["x-device-id"] || null,
        ]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        repaymentId,
        amount,
        newBalance: balance - amount,
        createdAt: insQ.rows[0].created_at,
      });
    }

    // Conflit sur id : le remboursement existe déjà (retry). On vérifie
    // qu'il s'agit bien du MÊME remboursement (même client et montant),
    // sinon on refuse pour ne pas masquer une erreur d'identifiant.
    const existingQ = await client.query(
      `SELECT id, customer_id, amount, created_at FROM credits WHERE id = $1`,
      [repaymentId]
    );
    const existing = existingQ.rows[0];
    if (!existing || existing.customer_id !== customerId || Number(existing.amount) !== -amount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cet identifiant de remboursement est déjà utilisé.", field: "repaymentId" });
    }
    await client.query("COMMIT");
    return res.status(200).json({
      repaymentId,
      amount,
      newBalance: balance, // inchangé : rien n'a été inséré
      createdAt: existing.created_at,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[credits/repayments]", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  } finally {
    client.release();
  }
});

module.exports = router;
