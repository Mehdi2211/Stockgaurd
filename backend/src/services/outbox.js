// =====================================================================
// Outbox des notifications : on enregistre chaque notification puis on
// l'envoie de façon ASYNCHRONE. Un échec (SMTP absent, email manquant)
// ne bloque JAMAIS l'action métier (création du profil créditeur).
//
// - 3 tentatives maximum, délai croissant (30 s * tentative).
// - Sans SMTP configuré : les entrées restent en 'pending' et repartent
//   une fois le SMTP configuré (aucune tentative n'est consommée).
// - Aucune donnée sensible dans `payload` (pas de photo, URL, ni n° CIN).
//
// Multi-boutique : l'outbox vit dans la base de la boutique ; le worker
// balaie toutes les bases connues (registre shops.json + base par défaut).
// =====================================================================

const mailer = require("./mailer");
const { getDefaultPool, getPoolForCode, registry } = require("../db");

const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = Number(process.env.NOTIFY_RETRY_INTERVAL_MS) || 60000;

let workerTimer = null;

// ---------------------------------------------------------------------
// Enregistre une notification (statut initial 'pending').
// ---------------------------------------------------------------------
async function enqueue(db, { shopId, type, payload }) {
  const { rows } = await db.query(
    `INSERT INTO notification_outbox (shop_id, type, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [shopId, type, JSON.stringify(payload || {})]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------
// Rendu de l'email selon le type (valeurs systématiquement échappées).
// ---------------------------------------------------------------------
function renderEmail(row, shop) {
  if (row.type === "CREDIT_PROFILE_CREATED") {
    const p = row.payload || {};
    const esc = mailer.escapeHtml;
    const subject = "StockGuard — Nouveau profil créditeur";
    const date = p.createdAt ? new Date(p.createdAt).toLocaleString("fr-TN", { timeZone: "Africa/Tunis" }) : "";
    const html =
      `<p>Un nouveau profil créditeur a été créé.</p>` +
      `<ul>` +
      `<li><b>Nom</b> : ${esc(p.firstName)} ${esc(p.familyName)}</li>` +
      `<li><b>Téléphone</b> : ${esc(p.phone)}</li>` +
      `<li><b>Date</b> : ${esc(date)}</li>` +
      `<li><b>Caissier</b> : ${esc(p.cashierName)}</li>` +
      `<li><b>Boutique</b> : ${esc(shop.name)}</li>` +
      `</ul>` +
      `<p>Photo de CIN et numéro de CIN volontairement non communiqués.</p>`;
    return { subject, html };
  }
  return null;
}

// ---------------------------------------------------------------------
// Tente d'envoyer une entrée. Ne lève jamais : journalise et met à jour
// le statut. Retourne true si l'envoi a réussi.
// ---------------------------------------------------------------------
async function processRow(db, row) {
  // SMTP absent : on ne consomme aucune tentative (repartira plus tard).
  if (!mailer.isConfigured()) return false;

  const { rows: shops } = await db.query(
    `SELECT name, notification_email FROM shops WHERE id = $1`,
    [row.shop_id]
  );
  const shop = shops[0];
  const to = shop && shop.notification_email;
  if (!to) {
    // Pas d'email de notification : on épuise (échec définitif après 3).
    await db.query(
      `UPDATE notification_outbox
          SET status = 'failed', attempts = attempts + 1, last_error = $2
        WHERE id = $1`,
      [row.id, "notification_email absent"]
    );
    console.warn(`[outbox] #${row.id} : notification_email absent pour la boutique`);
    return false;
  }

  const email = renderEmail(row, shop);
  if (!email) {
    await db.query(
      `UPDATE notification_outbox
          SET status = 'failed', attempts = attempts + 1, last_error = $2
        WHERE id = $1`,
      [row.id, "type de notification inconnu"]
    );
    return false;
  }

  try {
    await mailer.sendMail({ to, subject: email.subject, html: email.html });
    await db.query(
      `UPDATE notification_outbox
          SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = now()
        WHERE id = $1`,
      [row.id]
    );
    return true;
  } catch (err) {
    await db.query(
      `UPDATE notification_outbox
          SET status = 'failed', attempts = attempts + 1, last_error = $2
        WHERE id = $1`,
      [row.id, String(err.message || err).slice(0, 300)]
    );
    console.error(`[outbox] #${row.id} : échec d'envoi :`, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------
// Notification "nouveau profil créditeur" : enregistre + tente l'envoi
// en tâche de fond (NON bloquant).
// ---------------------------------------------------------------------
async function notifyProfileCreated(db, { shopId, firstName, familyName, phone, createdAt, cashierName }) {
  const id = await enqueue(db, {
    shopId,
    type: "CREDIT_PROFILE_CREATED",
    // Données NON sensibles uniquement.
    payload: { firstName, familyName, phone, createdAt, cashierName },
  });
  if (mailer.isConfigured()) {
    setImmediate(() => {
      db.query(`SELECT * FROM notification_outbox WHERE id = $1`, [id])
        .then(({ rows }) => (rows[0] ? processRow(db, rows[0]) : null))
        .catch((e) => console.error("[outbox] envoi immédiat :", e.message));
    });
  }
  return id;
}

// ---------------------------------------------------------------------
// Worker : reprend les entrées en attente/échouées (délai croissant).
// ---------------------------------------------------------------------
async function processPending(db) {
  const { rows } = await db.query(
    `SELECT * FROM notification_outbox
      WHERE status IN ('pending', 'failed')
        AND attempts < $1
        AND created_at <= now() - make_interval(secs => attempts * 30)
      ORDER BY created_at
      LIMIT 20`,
    [MAX_ATTEMPTS]
  );
  for (const row of rows) {
    await processRow(db, row).catch(() => {});
  }
}

// Toutes les bases connues : base par défaut + bases du registre.
function candidatePools() {
  const set = new Set();
  try { set.add(getDefaultPool()); } catch { /* DATABASE_URL absente */ }
  for (const code of Object.keys(registry || {})) {
    try { set.add(getPoolForCode(code)); } catch { /* ignore */ }
  }
  return [...set];
}

async function runOnce() {
  if (!mailer.isConfigured()) return;
  for (const db of candidatePools()) {
    await processPending(db).catch((e) => console.error("[outbox] worker :", e.message));
  }
}

function startWorker() {
  if (!mailer.isConfigured()) {
    console.warn(
      "[outbox] SMTP non configuré : les notifications resteront en attente " +
      "(configurer SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM)."
    );
  }
  if (workerTimer) return;
  workerTimer = setInterval(runOnce, RETRY_INTERVAL_MS);
  if (workerTimer.unref) workerTimer.unref();
}

module.exports = { enqueue, notifyProfileCreated, processPending, startWorker, MAX_ATTEMPTS };
