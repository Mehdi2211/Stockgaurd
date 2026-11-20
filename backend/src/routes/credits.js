const express = require("express");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 999999999; // millimes (~999 999 DT)

// Toutes les routes crédits exigent un jeton valide.
router.use(authenticate);

function isOwner(req) { return req.user?.role === "OWNER"; }
function isStaff(req) { return req.user?.role === "OWNER" || req.user?.role === "CASHIER"; }

function forbidden(res) {
  return res.status(403).json({ error: "Accès réservé au propriétaire." });
}

// Montant en millimes : entier strict, > 0, borné. Jamais de flottant.
function parseAmount(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value <= 0 || value > MAX_AMOUNT) return null;
  return value;
}

function parseNote(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length > 200) return null;
  return t;
}

function handleError(res, err, context) {
  console.error(`[credits] ${context}:`, err);
  res.status(500).json({ error: "Erreur interne du serveur." });
}

// ---------------------------------------------------------------------
// GET /customers — OWNER + CASHIER
// Liste des clients de la boutique avec solde dû (somme des credits).
// ---------------------------------------------------------------------
router.get("/customers", async (req, res) => {
  if (!isStaff(req)) return forbidden(res);
  try {
    const { rows } = await req.db.query(
      `SELECT c.id, c.first_name AS "firstName", c.family_name AS "familyName",
              c.phone, c.cin, c.status,
              COALESCE(SUM(cr.amount), 0)::bigint AS balance
         FROM customers c
         LEFT JOIN credits cr ON cr.customer_id = c.id
        WHERE c.shop_id = $1
        GROUP BY c.id
        ORDER BY c.family_name, c.first_name`,
      [req.user.shopId]
    );
    res.json({
      customers: rows.map((r) => ({ ...r, balance: Number(r.balance) })),
    });
  } catch (err) {
    handleError(res, err, "customers-list");
  }
});

// ---------------------------------------------------------------------
// GET /customers/:id — OWNER + CASHIER
// Détail client + historique des crédits (dette, remboursement, annulation).
// ---------------------------------------------------------------------
router.get("/customers/:id", async (req, res) => {
  if (!isStaff(req)) return forbidden(res);
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  try {
    const { rows: cust } = await req.db.query(
      `SELECT c.id, c.first_name AS "firstName", c.family_name AS "familyName",
              c.phone, c.cin, c.status,
              COALESCE(SUM(cr.amount), 0)::bigint AS balance
         FROM customers c
         LEFT JOIN credits cr ON cr.customer_id = c.id
        WHERE c.shop_id = $1 AND c.id = $2
        GROUP BY c.id`,
      [req.user.shopId, id]
    );
    if (cust.length === 0) return res.status(404).json({ error: "Client introuvable." });

    const { rows: history } = await req.db.query(
      `SELECT cr.id, cr.amount, cr.note, cr.sale_id, cr.reverses_id,
              cr.created_at AS "createdAt", u.name AS "recordedByName"
         FROM credits cr
         JOIN app_users u ON u.id = cr.recorded_by
        WHERE cr.shop_id = $1 AND cr.customer_id = $2
        ORDER BY cr.created_at DESC
        LIMIT 200`,
      [req.user.shopId, id]
    );

    res.json({
      customer: { ...cust[0], balance: Number(cust[0].balance) },
      history: history.map((h) => ({ ...h, amount: Number(h.amount) })),
    });
  } catch (err) {
    handleError(res, err, "customer-detail");
  }
});

// ---------------------------------------------------------------------
// POST /customers/:id/validate — OWNER uniquement
// PENDING -> VALIDATED (validated_by = utilisateur connecté).
// ---------------------------------------------------------------------
router.post("/customers/:id/validate", async (req, res) => {
  if (!isOwner(req)) return forbidden(res);
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  try {
    const { rows } = await req.db.query(
      `UPDATE customers
          SET status = 'VALIDATED', validated_by = $3, validated_at = now()
        WHERE shop_id = $1 AND id = $2 AND status = 'PENDING'
        RETURNING id, status, validated_at AS "validatedAt"`,
      [req.user.shopId, id, req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: "Client introuvable ou déjà validé." });
    }
    res.json({ customer: rows[0] });
  } catch (err) {
    handleError(res, err, "customer-validate");
  }
});

// ---------------------------------------------------------------------
// POST /debts — OWNER uniquement
// Dette manuelle SANS vente : amount > 0, sale_id NULL, reverses_id NULL.
// Body : { customerId, amount (millimes), note?, id (uuid idempotence) }
// Le client doit être VALIDATED. Idempotent via credits.id = id client.
// ---------------------------------------------------------------------
router.post("/debts", async (req, res) => {
  if (!isOwner(req)) return forbidden(res);

  const customerId = req.body?.customerId;
  const amount = parseAmount(req.body?.amount);
  const note = parseNote(req.body?.note);
  const debtId = req.body?.id;

  if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  if (amount === null) {
    return res.status(400).json({ error: "Montant invalide (entier en millimes, > 0)." });
  }
  if (note === null) {
    return res.status(400).json({ error: "Note invalide (200 caractères max)." });
  }
  if (typeof debtId !== "string" || !UUID_RE.test(debtId)) {
    return res.status(400).json({ error: "Identifiant de dette invalide (UUID attendu)." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");

    // Verrouille le client : sérialise dettes et remboursements concurrents.
    const { rows: cust } = await client.query(
      `SELECT id, status FROM customers WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
      [req.user.shopId, customerId]
    );
    if (cust.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Client introuvable." });
    }
    if (cust[0].status !== "VALIDATED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Le client doit être validé avant d'ajouter une dette." });
    }

    const { rows } = await client.query(
      `INSERT INTO credits (id, shop_id, customer_id, sale_id, reverses_id, amount, note, recorded_by)
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, amount, note, created_at AS "createdAt"`,
      [debtId, req.user.shopId, customerId, amount, note || null, req.user.userId]
    );

    let credit = rows[0];
    if (!credit) {
      // Idempotence : la dette existe déjà, on la renvoie.
      const { rows: existing } = await client.query(
        `SELECT id, amount, note, created_at AS "createdAt" FROM credits WHERE id = $1`,
        [debtId]
      );
      credit = existing[0];
    }

    await client.query("COMMIT");
    res.status(201).json({ credit: { ...credit, amount: Number(credit.amount) } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "debt-create");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// POST /repayments — OWNER + CASHIER
// Remboursement : amount > 0 côté requête, stocké NÉGATIF dans credits
// (sale_id NULL, reverses_id NULL). Entre immédiatement dans le montant
// attendu de caisse (computeExpected somme credits.amount < 0).
// Body : { customerId, amount (millimes), note?, id (uuid idempotence) }
// Le remboursement ne peut pas dépasser le solde dû (409).
// ---------------------------------------------------------------------
router.post("/repayments", async (req, res) => {
  if (!isStaff(req)) return forbidden(res);

  const customerId = req.body?.customerId;
  const amount = parseAmount(req.body?.amount);
  const note = parseNote(req.body?.note);
  const repaymentId = req.body?.id;

  if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  if (amount === null) {
    return res.status(400).json({ error: "Montant invalide (entier en millimes, > 0)." });
  }
  if (note === null) {
    return res.status(400).json({ error: "Note invalide (200 caractères max)." });
  }
  if (typeof repaymentId !== "string" || !UUID_RE.test(repaymentId)) {
    return res.status(400).json({ error: "Identifiant de remboursement invalide (UUID attendu)." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");

    // Verrouille le client : sérialise dettes et remboursements concurrents.
    const { rows: cust } = await client.query(
      `SELECT id FROM customers WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
      [req.user.shopId, customerId]
    );
    if (cust.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Client introuvable." });
    }

    const { rows: bal } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS balance
         FROM credits WHERE shop_id = $1 AND customer_id = $2`,
      [req.user.shopId, customerId]
    );
    const balance = Number(bal[0].balance);
    if (balance <= 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ce client n'a aucun solde à rembourser." });
    }
    if (amount > balance) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Le remboursement dépasse le solde dû." });
    }

    const { rows } = await client.query(
      `INSERT INTO credits (id, shop_id, customer_id, sale_id, reverses_id, amount, note, recorded_by)
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, amount, note, created_at AS "createdAt"`,
      [repaymentId, req.user.shopId, customerId, -amount, note || null, req.user.userId]
    );

    let credit = rows[0];
    if (!credit) {
      const { rows: existing } = await client.query(
        `SELECT id, amount, note, created_at AS "createdAt" FROM credits WHERE id = $1`,
        [repaymentId]
      );
      credit = existing[0];
    }

    await client.query("COMMIT");
    res.status(201).json({ credit: { ...credit, amount: Number(credit.amount) } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "repayment-create");
  } finally {
    client.release();
  }
});

module.exports = router;
