const pool = require("../db");

// =====================================================================
// Suivi de caisse — calcul du montant attendu.
//
// Le montant attendu à l'instant T est calculé depuis la DATE
// D'INITIALISATION choisie par le propriétaire (effective_at, sinon
// created_at pour les anciennes lignes) :
//
//   montant initial
//   + ventes en espèces   (sales.total WHERE customer_id IS NULL)
//   + remboursements crédit payés en espèces (- credits.amount WHERE amount < 0)
//   + dépôts              (cash_movements DEPOSIT, montant > 0)
//   - retraits            (cash_movements WITHDRAWAL, montant < 0)
//   - remboursements      (cash_movements CASH_REFUND, montant < 0)
//   +/- ajustements       (cash_movements ADJUSTMENT, signé)
//
// Seules les écritures postérieures à la date d'initialisation et
// strictement antérieures à T comptent. Les ventes à crédit
// (customer_id NOT NULL) et les dettes ne rapportent aucun espèces :
// exclus.
//
// UNE SEULE fonction calcule le montant attendu (computeExpected) :
// le endpoint /expected et la vérification l'utilisent tous les deux.
// =====================================================================

// La PLUS RÉCENTE initialisation fait foi (réinitialisation = nouvelle
// ligne INITIALIZATION, l'ancienne reste en base, append-only).
async function getInitialization(client, shopId) {
  const { rows } = await client.query(
    `SELECT id, amount, created_at, effective_at
       FROM cash_movements
      WHERE shop_id = $1 AND type = 'INITIALIZATION'
      ORDER BY created_at DESC
      LIMIT 1`,
    [shopId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  // Date d'initialisation = effective_at si présente, sinon created_at
  // (compatibilité avec les lignes INITIALIZATION antérieures à la
  // migration 002, qui n'ont pas de effective_at).
  const initializedAt = r.effective_at || r.created_at;
  return {
    id: r.id,
    amount: Number(r.amount),
    createdAt: r.created_at,
    effectiveAt: r.effective_at,
    initializedAt,
  };
}

// Sommes des composantes dans [from, to) — ventes et crédits limités à
// ts >= from (rien ne compte avant la date d'initialisation).
async function aggregatePeriod(client, shopId, from, to) {
  const params = [shopId, from, to];

  const salesQ = await client.query(
    `SELECT COALESCE(SUM(total), 0)::bigint AS cash_sales,
            COUNT(*)::int AS sales_count
       FROM sales
      WHERE shop_id = $1 AND customer_id IS NULL
        AND created_at >= $2 AND created_at < $3`,
    params
  );

  const creditsQ = await client.query(
    `SELECT COALESCE(-SUM(amount), 0)::bigint AS cash_repayments,
            COUNT(*)::int AS repayments_count
       FROM credits
      WHERE shop_id = $1 AND amount < 0
        AND created_at >= $2 AND created_at < $3`,
    params
  );

  const movQ = await client.query(
    `SELECT type, COALESCE(SUM(amount), 0)::bigint AS total
       FROM cash_movements
      WHERE shop_id = $1 AND type <> 'INITIALIZATION'
        AND created_at >= $2 AND created_at < $3
      GROUP BY type`,
    params
  );

  // Ajustements séparés par signe : "Argent ajouté" / "Argent retiré"
  // doivent distinguer un ajustement +20.000 d'un -10.000 (le net
  // +10.000 ne suffit pas pour la ventilation).
  const adjQ = await client.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::bigint AS adj_added,
            COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0)::bigint AS adj_removed
       FROM cash_movements
      WHERE shop_id = $1 AND type = 'ADJUSTMENT'
        AND created_at >= $2 AND created_at < $3`,
    params
  );

  const byType = {};
  for (const r of movQ.rows) byType[r.type] = Number(r.total);

  const adjAdded = Number(adjQ.rows[0].adj_added);
  const adjRemoved = Number(adjQ.rows[0].adj_removed);

  return {
    cashSales:        Number(salesQ.rows[0].cash_sales),
    salesCount:       salesQ.rows[0].sales_count,
    cashRepayments:   Number(creditsQ.rows[0].cash_repayments),
    repaymentsCount:  creditsQ.rows[0].repayments_count,
    deposits:         byType.DEPOSIT || 0,
    withdrawals:      -(byType.WITHDRAWAL || 0),   // montant positif
    refunds:          -(byType.CASH_REFUND || 0),  // montant positif
    adjustments:      adjAdded - adjRemoved,       // signé (net)
    adjustmentsAdded:   adjAdded,
    adjustmentsRemoved: adjRemoved,
  };
}

// Montant attendu à l'instant `at` (défaut : maintenant), calculé depuis
// la date d'initialisation. Retourne { initialized: false } si la caisse
// n'est pas initialisée.
async function computeExpected(shopId, at = new Date()) {
  const client = await pool.connect();
  try {
    const init = await getInitialization(client, shopId);
    if (!init) return { initialized: false };

    const initTs = new Date(init.initializedAt);
    const period = await aggregatePeriod(client, shopId, initTs, at);

    const expectedAmount =
      init.amount +
      period.cashSales +
      period.cashRepayments +
      period.deposits -
      period.withdrawals -
      period.refunds +
      period.adjustments;

    // Ventilation "Argent ajouté" / "Argent retiré" pour l'affichage :
    // dépôts + ajustements positifs d'un côté, retraits + remboursements
    // + ajustements négatifs de l'autre. Les lignes somment au total.
    const moneyAdded = period.deposits + period.adjustmentsAdded;
    const moneyRemoved =
      period.withdrawals + period.refunds + period.adjustmentsRemoved;

    return {
      initialized:      true,
      initializedAt:    init.initializedAt,
      initialAmount:    init.amount,
      cashSales:        period.cashSales,
      salesCount:       period.salesCount,
      cashRepayments:   period.cashRepayments,
      repaymentsCount:  period.repaymentsCount,
      deposits:         period.deposits,
      withdrawals:      period.withdrawals,
      refunds:          period.refunds,
      adjustments:      period.adjustments,
      adjustmentsAdded:   period.adjustmentsAdded,
      adjustmentsRemoved: period.adjustmentsRemoved,
      moneyAdded,
      moneyRemoved,
      expectedAmount,
      computedAt:       at,
    };
  } finally {
    client.release();
  }
}

// Détail des remboursements de crédit sur [from, to) avec le nom du
// créditeur et de l'enregistreur — pour le rapport de caisse.
async function listRepayments(shopId, from, to) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT cr.id, cr.amount, cr.note, cr.created_at AS "createdAt",
              c.first_name || ' ' || c.family_name AS "customerName",
              u.name AS "recordedByName"
         FROM credits cr
         JOIN customers c ON c.id = cr.customer_id
         JOIN app_users u ON u.id = cr.recorded_by
        WHERE cr.shop_id = $1 AND cr.amount < 0
          AND cr.created_at >= $2 AND cr.created_at < $3
        ORDER BY cr.created_at DESC
        LIMIT 500`,
      [shopId, from, to]
    );
    return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  } finally {
    client.release();
  }
}

module.exports = { computeExpected, getInitialization, listRepayments };
