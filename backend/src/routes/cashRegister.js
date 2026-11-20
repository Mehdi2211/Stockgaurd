const express = require("express");
const { authenticate, requireOwner } = require("../middleware/auth");
const svc = require("../services/cashRegister");
const {
  validateAmount,
  validateDescription,
  validateReason,
} = require("../validators/cashRegister");

const router = express.Router();

// Toutes les routes caisse : OWNER authentifié uniquement.
// shop_id / admin_id viennent du jeton vérifié, jamais de la requête.
router.use(authenticate, requireOwner);

// ---------------------------------------------------------------------
// Verrou consultatif par boutique : sérialise les opérations qui lisent
// le montant attendu (retraits, vérifications) pour éviter les races
// (ex. deux retraits parallèles qui dépassent ensemble le solde).
// pg_advisory_xact_lock est libéré automatiquement à la fin de la
// transaction (COMMIT ou ROLLBACK).
// ---------------------------------------------------------------------
async function lockShop(client, shopId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [shopId]);
}

function handleError(res, err, context) {
  console.error(`[cash-register] ${context}:`, err);
  res.status(500).json({ error: "Erreur interne du serveur." });
}

// ---------------------------------------------------------------------
// POST /initialize — une seule fois par boutique
// Body : { amount (millimes) } — la date est l'heure du serveur (automatique).
// ---------------------------------------------------------------------
router.post("/initialize", async (req, res) => {
  const amount = validateAmount(req.body?.amount, { min: 0, allowZero: true });
  if (amount === null) {
    return res.status(400).json({ error: "Montant initial invalide (entier en millimes, >= 0)." });
  }

  // La date d'initialisation est TOUJOURS l'heure du serveur (now()) :
  // effective_at = created_at, dans la même transaction. Toute date
  // fournie dans le body (initializedAt ou autre) est ignorée.
  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    await lockShop(client, req.user.shopId);

    const existing = await svc.getInitialization(client, req.user.shopId);
    if (existing) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "La caisse est déjà initialisée." });
    }

    // created_at et effective_at = now() : même transaction, donc égaux.
    // Le CHECK effective_at <= created_at est respecté (égalité valide).
    const { rows } = await client.query(
      `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id, created_at, effective_at)
       VALUES ($1, 'INITIALIZATION', $2, 'Fond de caisse initial', $3, now(), now())
       RETURNING *`,
      [req.user.shopId, amount, req.user.userId]
    );

    await client.query("COMMIT");
    res.status(201).json({ movement: rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "initialize");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// GET /expected — montant attendu depuis la date d'initialisation
// ---------------------------------------------------------------------
router.get("/expected", async (req, res) => {
  try {
    const expected = await svc.computeExpected(req.db, req.user.shopId, new Date());
    if (!expected.initialized) {
      return res.json({ initialized: false });
    }
    res.json({
      initialized:      true,
      initializedAt:    expected.initializedAt,
      initialAmount:    expected.initialAmount,
      cashSales:        expected.cashSales,
      salesCount:       expected.salesCount,
      cashRepayments:   expected.cashRepayments,
      repaymentsCount:  expected.repaymentsCount,
      deposits:         expected.deposits,
      withdrawals:      expected.withdrawals,
      refunds:          expected.refunds,
      adjustments:      expected.adjustments,
      moneyAdded:       expected.moneyAdded,
      moneyRemoved:     expected.moneyRemoved,
      expectedAmount:   expected.expectedAmount,
      computedAt:       expected.computedAt,
    });
  } catch (err) {
    handleError(res, err, "expected");
  }
});

// ---------------------------------------------------------------------
// Mouvements manuels : retraits, dépôts, ajustements
// ---------------------------------------------------------------------
async function insertMovement(req, res, { type, amount, description }) {
  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    await lockShop(client, req.user.shopId);

    const init = await svc.getInitialization(client, req.user.shopId);
    if (!init) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Initialisez d'abord la caisse." });
    }

    // Un retrait ne peut pas dépasser le montant attendu actuel.
    // (amount est déjà signé : négatif pour WITHDRAWAL)
    // 409 = conflit d'état (solde insuffisant), pas une erreur de saisie.
    if (type === "WITHDRAWAL") {
      const expected = await svc.computeExpected(req.db, req.user.shopId, new Date());
      if (expected.initialized && Math.abs(amount) > expected.expectedAmount) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Le retrait dépasse le montant attendu de caisse.",
        });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.shopId, type, amount, description, req.user.userId]
    );

    await client.query("COMMIT");
    res.status(201).json({ movement: rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, type.toLowerCase());
  } finally {
    client.release();
  }
}

router.post("/withdrawals", async (req, res) => {
  const amount = validateAmount(req.body?.amount, { min: 1 });
  const description = validateDescription(req.body?.description);
  if (amount === null || description === null) {
    return res.status(400).json({ error: "Montant (> 0) et motif (3-200 caractères) obligatoires." });
  }
  await insertMovement(req, res, { type: "WITHDRAWAL", amount: -amount, description });
});

router.post("/deposits", async (req, res) => {
  const amount = validateAmount(req.body?.amount, { min: 1 });
  const description = validateDescription(req.body?.description);
  if (amount === null || description === null) {
    return res.status(400).json({ error: "Montant (> 0) et motif (3-200 caractères) obligatoires." });
  }
  await insertMovement(req, res, { type: "DEPOSIT", amount, description });
});

// POST /adjustments — ajustement manuel (ajout ou retrait d'argent).
// Body : { amount (> 0, millimes), direction: "ADD" | "REMOVE", reason? }
// reason absent/vide -> "Ajustement sans motif" ; fourni -> 3-200
// caractères avec au moins une lettre ou un chiffre.
// REMOVE ne peut pas dépasser le montant attendu (409).
router.post("/adjustments", async (req, res) => {
  const amount = validateAmount(req.body?.amount, { min: 1 });
  const direction = req.body?.direction;
  const reason = validateReason(req.body?.reason);

  if (amount === null || (direction !== "ADD" && direction !== "REMOVE") || reason === null) {
    return res.status(400).json({
      error: "Montant (> 0), direction (ADD ou REMOVE) et motif valide requis.",
    });
  }

  const signed = direction === "ADD" ? amount : -amount;
  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    await lockShop(client, req.user.shopId);

    const init = await svc.getInitialization(client, req.user.shopId);
    if (!init) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Initialisez d'abord la caisse." });
    }

    if (direction === "REMOVE") {
      const expected = await svc.computeExpected(req.db, req.user.shopId, new Date());
      if (expected.initialized && amount > expected.expectedAmount) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Le retrait dépasse le montant attendu de caisse.",
        });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id)
       VALUES ($1, 'ADJUSTMENT', $2, $3, $4)
       RETURNING *`,
      [req.user.shopId, signed, reason || "Ajustement sans motif", req.user.userId]
    );

    await client.query("COMMIT");
    res.status(201).json({ movement: rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "adjustment");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// POST /reinitialize — nouvelle INITIALIZATION après comptage réel.
// Body : { amount (millimes, >= 0) } — date = heure du serveur.
// Enregistre d'abord une cash_verifications (attendu vs réel, écart),
// puis une nouvelle ligne INITIALIZATION. L'ancienne reste en base
// (append-only) ; le calcul repart de la nouvelle date.
// ---------------------------------------------------------------------
router.post("/reinitialize", async (req, res) => {
  const amount = validateAmount(req.body?.amount, { min: 0, allowZero: true });
  if (amount === null) {
    return res.status(400).json({ error: "Montant réel invalide (entier en millimes, >= 0)." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    await lockShop(client, req.user.shopId);

    const init = await svc.getInitialization(client, req.user.shopId);
    if (!init) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Initialisez d'abord la caisse." });
    }

    // Montant attendu recalculé par le serveur au moment de l'enregistrement.
    const expected = await svc.computeExpected(req.db, req.user.shopId, new Date());

    const { rows: verRows } = await client.query(
      `INSERT INTO cash_verifications (shop_id, theoretical_balance, actual_balance, admin_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.shopId, expected.expectedAmount, amount, req.user.userId]
    );

    const { rows: movRows } = await client.query(
      `INSERT INTO cash_movements (shop_id, type, amount, description, admin_id, created_at, effective_at)
       VALUES ($1, 'INITIALIZATION', $2, 'Réinitialisation de caisse', $3, now(), now())
       RETURNING *`,
      [req.user.shopId, amount, req.user.userId]
    );

    await client.query("COMMIT");

    const v = verRows[0];
    res.status(201).json({
      verification: {
        id: v.id,
        theoreticalBalance: Number(v.theoretical_balance),
        actualBalance: Number(v.actual_balance),
        difference: Number(v.difference),
        status: v.status,
        adminId: v.admin_id,
        createdAt: v.created_at,
      },
      movement: movRows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "reinitialize");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// POST /verifications — le serveur recalcule le montant attendu
// ---------------------------------------------------------------------
router.post("/verifications", async (req, res) => {
  const actual = validateAmount(req.body?.actualAmount, { min: 0, allowZero: true });
  if (actual === null) {
    return res.status(400).json({ error: "Montant compté invalide (entier en millimes, >= 0)." });
  }

  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    await lockShop(client, req.user.shopId);

    const init = await svc.getInitialization(client, req.user.shopId);
    if (!init) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Initialisez d'abord la caisse." });
    }

    const expected = await svc.computeExpected(req.db, req.user.shopId, new Date());

    const { rows } = await client.query(
      `INSERT INTO cash_verifications (shop_id, theoretical_balance, actual_balance, admin_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.shopId, expected.expectedAmount, actual, req.user.userId]
    );

    await client.query("COMMIT");

    const v = rows[0];
    res.status(201).json({
      verification: {
        id: v.id,
        theoreticalBalance: Number(v.theoretical_balance),
        actualBalance: Number(v.actual_balance),
        difference: Number(v.difference),
        status: v.status,
        adminId: v.admin_id,
        createdAt: v.created_at,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "verification");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// GET /repayments?from&to — détail des remboursements de crédit avec le
// nom du créditeur (rapport de caisse). OWNER uniquement (router.use).
// ---------------------------------------------------------------------
router.get("/repayments", async (req, res) => {
  const period = parsePeriod(req, res);
  if (!period) return;
  try {
    const repayments = await svc.listRepayments(req.db, req.user.shopId, period.from, period.to);
    res.json({ repayments });
  } catch (err) {
    handleError(res, err, "repayments");
  }
});

// ---------------------------------------------------------------------
// GET /movements?from&to&limit — plus récents d'abord, avec nom admin
// ---------------------------------------------------------------------
router.get("/movements", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const period = parsePeriod(req, res);
  if (!period) return;

  try {
    const { rows } = await req.db.query(
      `SELECT m.id, m.type, m.amount, m.description, m.sale_id,
              m.admin_id, m.created_at, u.name AS admin_name
         FROM cash_movements m
         JOIN app_users u ON u.id = m.admin_id
        WHERE m.shop_id = $1
          AND m.created_at >= $2 AND m.created_at < $3
        ORDER BY m.created_at DESC
        LIMIT $4`,
      [req.user.shopId, period.from, period.to, limit]
    );
    res.json({
      movements: rows.map((m) => ({ ...m, amount: Number(m.amount) })),
    });
  } catch (err) {
    handleError(res, err, "movements");
  }
});

// ---------------------------------------------------------------------
// GET /verifications?limit — plus récentes d'abord, avec nom admin
// ---------------------------------------------------------------------
router.get("/verifications", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

  try {
    const { rows } = await req.db.query(
      `SELECT v.id, v.theoretical_balance, v.actual_balance,
              v.difference, v.status, v.admin_id, v.created_at,
              u.name AS admin_name
         FROM cash_verifications v
         JOIN app_users u ON u.id = v.admin_id
        WHERE v.shop_id = $1
        ORDER BY v.created_at DESC
        LIMIT $2`,
      [req.user.shopId, limit]
    );
    res.json({
      verifications: rows.map((v) => ({
        ...v,
        theoretical_balance: Number(v.theoretical_balance),
        actual_balance: Number(v.actual_balance),
        difference: Number(v.difference),
      })),
    });
  } catch (err) {
    handleError(res, err, "verifications-list");
  }
});

// ---------------------------------------------------------------------
// Helpers période (conservés pour GET /movements)
// ---------------------------------------------------------------------
const TUNIS_OFFSET_MS = 60 * 60 * 1000;

function tunisDayStart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const utcMidnight = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(utcMidnight)) return null;
  return new Date(utcMidnight - TUNIS_OFFSET_MS);
}

function tunisTodayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Tunis" });
}

function addDays(dateStr, n) {
  const d = new Date(Date.parse(`${dateStr}T00:00:00.000Z`) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

function parseDateParam(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return tunisDayStart(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parsePeriod(req, res) {
  const today = tunisTodayStr();
  const from = parseDateParam(req.query.from, tunisDayStart(today));
  const to = parseDateParam(req.query.to, tunisDayStart(addDays(today, 1)));
  if (!from || !to) {
    res.status(400).json({ error: "Période invalide (formats acceptés : AAAA-MM-JJ ou ISO)." });
    return null;
  }
  if (from >= to) {
    res.status(400).json({ error: "La date de début doit être avant la date de fin." });
    return null;
  }
  return { from, to };
}

module.exports = router;
