const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../middleware/auth");
const storage = require("../services/storage");
const outbox = require("../services/outbox");
const { CREDIT_CONSENT_TEXT } = require("../constants/privacy");
const { creditLimitMillimes, cinAutoDeleteOnZeroBalance } = require("../constants/credit");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = 999999999; // millimes (~999 999 DT)
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 Mo

// Toutes les routes crédits exigent un jeton valide.
router.use(authenticate);

function isOwner(req) { return req.user?.role === "OWNER"; }
function isStaff(req) { return req.user?.role === "OWNER" || req.user?.role === "CASHIER"; }

function forbidden(res) {
  return res.status(403).json({ error: "Accès réservé au propriétaire." });
}

// Photo CIN : gardée en mémoire (jamais écrite sur disque), 5 Mo max,
// un seul fichier. Le type réel est vérifié par magic bytes avant envoi.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

function uploadCinMiddleware(req, res, next) {
  upload.single("cinPhoto")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Photo trop volumineuse (5 Mo maximum)." });
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: "Champ de fichier inattendu (attendu : cinPhoto)." });
    }
    console.error("[credits] upload:", err.message);
    return res.status(400).json({ error: "Requête multipart invalide." });
  });
}

// Limite la création de profils (photo + données personnelles sensibles).
const createCustomerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de créations de profils. Réessayez plus tard." },
});

// Millimes -> "12,500 DT" (jamais de flottant pour le calcul).
function formatDT(millimes) {
  const n = Number(millimes) || 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  return `${neg ? "-" : ""}${Math.floor(abs / 1000)},${String(abs % 1000).padStart(3, "0")} DT`;
}

// Nom/prénom : non vide, 60 caractères max.
function parseName(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length === 0 || t.length > 60) return null;
  return t;
}

// Téléphone tunisien : 8 chiffres, préfixe +216 / 216 toléré.
function normalizePhone(value) {
  if (typeof value !== "string") return null;
  let digits = value.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits.startsWith("216")) digits = digits.slice(3);
  return /^[0-9]{8}$/.test(digits) ? digits : null;
}

// Numéro de CIN : 8 chiffres.
function normalizeCin(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^0-9]/g, "");
  return /^[0-9]{8}$/.test(digits) ? digits : null;
}

function parseBool(value) {
  return String(value == null ? "" : value).toLowerCase() === "true";
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
// GET /consent-text — OWNER + CASHIER
// Texte de l'avis de confidentialité (CIN), depuis un fichier unique.
// ---------------------------------------------------------------------
router.get("/consent-text", async (req, res) => {
  if (!isStaff(req)) return forbidden(res);
  res.json({ text: CREDIT_CONSENT_TEXT });
});

// ---------------------------------------------------------------------
// GET /customers — OWNER + CASHIER
// Liste paginée des créditeurs de la boutique avec solde dû (somme des
// credits) et disponible restant. NE renvoie NI la photo NI son chemin.
// Query : ?search= &limit= (1..200, défaut 50) &offset= (défaut 0)
// ---------------------------------------------------------------------
router.get("/customers", async (req, res) => {
  if (!isStaff(req)) return forbidden(res);

  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const params = [req.user.shopId];
  let where = `WHERE c.shop_id = $1`;
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const p = `$${params.length}`;
    where += ` AND (lower(c.first_name) LIKE ${p} OR lower(c.family_name) LIKE ${p} OR c.phone LIKE ${p})`;
  }

  try {
    const { rows: total } = await req.db.query(
      `SELECT COUNT(*)::int AS total FROM customers c ${where}`,
      params
    );

    const listParams = [...params, limit, offset];
    const { rows } = await req.db.query(
      `SELECT c.id, c.first_name AS "firstName", c.family_name AS "familyName",
              c.phone, c.cin, c.status,
              (c.cin_photo_path IS NOT NULL) AS "hasCin",
              COALESCE(SUM(cr.amount), 0)::bigint AS balance
         FROM customers c
         LEFT JOIN credits cr ON cr.customer_id = c.id
        ${where}
        GROUP BY c.id
        ORDER BY c.family_name, c.first_name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );

    const limitMillimes = creditLimitMillimes();
    res.json({
      customers: rows.map((r) => {
        const balance = Number(r.balance);
        return {
          ...r,
          balance,
          available: Math.max(0, limitMillimes - balance),
        };
      }),
      total: total[0].total,
      limit,
      offset,
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
              (c.cin_photo_path IS NOT NULL) AS "hasCin",
              c.cin_consent_at AS "cinConsentAt",
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
      customer: {
        ...cust[0],
        balance: Number(cust[0].balance),
        available: Math.max(0, creditLimitMillimes() - Number(cust[0].balance)),
      },
      history: history.map((h) => ({ ...h, amount: Number(h.amount) })),
    });
  } catch (err) {
    handleError(res, err, "customer-detail");
  }
});

// ---------------------------------------------------------------------
// POST /customers — OWNER + CASHIER
// Création d'un profil créditeur. multipart/form-data :
//   firstName, familyName, phone, cin, consent ("true") + cinPhoto (fichier)
// Le profil est créé directement VALIDATED (validated_by = créateur).
// La photo part dans le bucket Supabase PRIVÉ (chemin `shop_id/uuid.ext`).
// Notifie l'owner par email (asynchrone, jamais bloquant).
// ---------------------------------------------------------------------
router.post("/customers", createCustomerLimiter, uploadCinMiddleware, async (req, res) => {
  if (!isStaff(req)) return forbidden(res);

  const firstName = parseName(req.body?.firstName);
  const familyName = parseName(req.body?.familyName);
  const phone = normalizePhone(req.body?.phone);
  const cin = normalizeCin(req.body?.cin);
  const consent = parseBool(req.body?.consent);
  const file = req.file;

  if (!firstName) return res.status(400).json({ error: "Prénom requis (60 caractères max)." });
  if (!familyName) return res.status(400).json({ error: "Nom requis (60 caractères max)." });
  if (phone === null) {
    return res.status(400).json({ error: "Téléphone invalide (8 chiffres, ex. 20123456 ou +21620123456)." });
  }
  if (cin === null) {
    return res.status(400).json({ error: "Numéro de CIN invalide (8 chiffres)." });
  }
  if (!consent) {
    return res.status(400).json({ error: "Le consentement du créditeur est obligatoire." });
  }
  if (!file || !file.buffer) {
    return res.status(400).json({ error: "La photo de la CIN est obligatoire." });
  }

  // Type RÉEL du fichier via magic bytes (jamais l'extension).
  const imgType = storage.detectImageType(file.buffer);
  if (!imgType) {
    return res.status(400).json({ error: "Format d'image non supporté (JPEG, PNG ou WEBP)." });
  }
  if (!storage.isConfigured()) {
    console.error("[credits] stockage CIN non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    return res.status(503).json({ error: "Stockage des photos indisponible. Contactez l'administrateur." });
  }

  // 1) Téléversement dans le bucket privé (avant l'insertion).
  let photoPath;
  try {
    photoPath = await storage.uploadCin(req.user.shopId, file.buffer, imgType.mime);
  } catch (err) {
    console.error("[credits] téléversement CIN:", err.message);
    return res.status(502).json({ error: "Échec du téléversement de la photo." });
  }

  // 2) Insertion en base. Si elle échoue, on retire le fichier orphelin.
  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO customers
         (shop_id, first_name, family_name, phone, cin, cin_photo_path, cin_consent_at,
          status, created_by, validated_by, validated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), 'VALIDATED', $7, $7, now())
       RETURNING id, first_name AS "firstName", family_name AS "familyName",
                 phone, status, created_at AS "createdAt"`,
      [req.user.shopId, firstName, familyName, phone, cin, photoPath, req.user.userId]
    );
    const customer = rows[0];
    const { rows: users } = await client.query(
      `SELECT name FROM app_users WHERE id = $1`,
      [req.user.userId]
    );
    await client.query("COMMIT");

    // 3) Notification owner : asynchrone, une erreur n'annule PAS la création.
    outbox
      .notifyProfileCreated(req.db, {
        shopId: req.user.shopId,
        firstName,
        familyName,
        phone,
        createdAt: customer.createdAt,
        cashierName: (users[0] && users[0].name) || "",
      })
      .catch((e) => console.error("[credits] notification profil:", e.message));

    res.status(201).json({
      customer: { ...customer, hasCin: true, balance: 0, available: creditLimitMillimes() },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await storage.removeCin(photoPath).catch((e) => console.error("[credits] nettoyage CIN:", e.message));
    if (err.code === "23505") {
      return res.status(409).json({ error: "Un créditeur avec ce téléphone ou ce numéro de CIN existe déjà." });
    }
    handleError(res, err, "customer-create");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// GET /customers/:id/cin — OWNER uniquement
// Renvoie une URL SIGNÉE à courte durée (60 s). Le CASHIER n'y a JAMAIS
// accès (403) : il peut prendre la photo mais ne peut pas la relire.
// ---------------------------------------------------------------------
router.get("/customers/:id/cin", async (req, res) => {
  if (!isOwner(req)) return forbidden(res);
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  try {
    const { rows } = await req.db.query(
      `SELECT cin_photo_path AS "path" FROM customers WHERE shop_id = $1 AND id = $2`,
      [req.user.shopId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Client introuvable." });
    const path = rows[0].path;
    if (!path) return res.status(404).json({ error: "Aucune photo de CIN conservée pour ce créditeur." });
    if (!storage.isConfigured()) {
      return res.status(503).json({ error: "Stockage des photos indisponible." });
    }
    const url = await storage.createSignedCinUrl(path, 60);
    res.json({ url, expiresIn: 60 });
  } catch (err) {
    console.error("[credits] URL signée CIN:", err.message);
    res.status(502).json({ error: "Impossible de générer le lien de la photo." });
  }
});

// ---------------------------------------------------------------------
// DELETE /customers/:id/cin — OWNER uniquement
// Supprime le fichier du bucket PUIS met le chemin à NULL. Si la
// suppression du fichier échoue, RIEN n'est mis à NULL (cohérence).
// Ne touche JAMAIS aux lignes de `credits` (append-only).
// ---------------------------------------------------------------------
router.delete("/customers/:id/cin", async (req, res) => {
  if (!isOwner(req)) return forbidden(res);
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  const client = await req.db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT cin_photo_path AS "path" FROM customers
        WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
      [req.user.shopId, id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Client introuvable." });
    }
    const path = rows[0].path;
    if (!path) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Aucune photo de CIN à supprimer pour ce créditeur." });
    }
    if (!storage.isConfigured()) {
      await client.query("ROLLBACK");
      return res.status(503).json({ error: "Stockage des photos indisponible." });
    }

    // 1) Suppression du fichier. En cas d'échec : rien n'est modifié.
    try {
      await storage.removeCin(path);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[credits] suppression CIN (fichier):", err.message);
      return res.status(502).json({ error: "Échec de la suppression du fichier. Aucune modification effectuée." });
    }

    // 2) Mise à NULL du chemin (seulement après suppression réussie).
    await client.query(
      `UPDATE customers SET cin_photo_path = NULL WHERE shop_id = $1 AND id = $2`,
      [req.user.shopId, id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, hasCin: false });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "customer-cin-delete");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// PUT /customers/:id/cin — OWNER + CASHIER
// (Re)capture de la photo de CIN d'un profil EXISTANT (ex. photo supprimée
// après solde à 0 : toute nouvelle dette exige une photo à jour).
// multipart/form-data : cinPhoto + consent ("true").
// ---------------------------------------------------------------------
router.put("/customers/:id/cin", createCustomerLimiter, uploadCinMiddleware, async (req, res) => {
  if (!isStaff(req)) return forbidden(res);
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Identifiant client invalide." });
  }
  const consent = parseBool(req.body?.consent);
  const file = req.file;
  if (!consent) {
    return res.status(400).json({ error: "Le consentement du créditeur est obligatoire." });
  }
  if (!file || !file.buffer) {
    return res.status(400).json({ error: "La photo de la CIN est obligatoire." });
  }
  const imgType = storage.detectImageType(file.buffer);
  if (!imgType) {
    return res.status(400).json({ error: "Format d'image non supporté (JPEG, PNG ou WEBP)." });
  }
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: "Stockage des photos indisponible." });
  }

  // Vérifie l'existence du client (isolation par shop_id) AVANT l'upload.
  const { rows: existing } = await req.db.query(
    `SELECT id, cin_photo_path AS "path" FROM customers WHERE shop_id = $1 AND id = $2`,
    [req.user.shopId, id]
  );
  if (existing.length === 0) return res.status(404).json({ error: "Client introuvable." });

  let photoPath;
  try {
    photoPath = await storage.uploadCin(req.user.shopId, file.buffer, imgType.mime);
  } catch (err) {
    console.error("[credits] téléversement CIN:", err.message);
    return res.status(502).json({ error: "Échec du téléversement de la photo." });
  }

  try {
    await req.db.query(
      `UPDATE customers SET cin_photo_path = $3, cin_consent_at = now()
        WHERE shop_id = $1 AND id = $2`,
      [req.user.shopId, id, photoPath]
    );
    // Ancienne photo (si remplacée) : supprimée best-effort.
    if (existing[0].path) {
      await storage.removeCin(existing[0].path).catch((e) =>
        console.error("[credits] suppression ancienne CIN:", e.message)
      );
    }
    res.json({ ok: true, hasCin: true });
  } catch (err) {
    await storage.removeCin(photoPath).catch((e) => console.error("[credits] nettoyage CIN:", e.message));
    handleError(res, err, "customer-cin-put");
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
// Le client doit être VALIDATED et disposer d'une photo de CIN (toute
// nouvelle dette exige une photo). Le solde ne peut dépasser le plafond.
// Idempotent via credits.id = id client.
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
      `SELECT id, status, cin_photo_path FROM customers
        WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
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
    // Toute nouvelle dette exige une photo de CIN à jour.
    if (!cust[0].cin_photo_path) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Photo de CIN manquante : reprenez la photo du créditeur avant d'ajouter une dette." });
    }

    // Plafond : le solde dû ne peut jamais dépasser CREDIT_LIMIT.
    const { rows: bal } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS balance
         FROM credits WHERE shop_id = $1 AND customer_id = $2`,
      [req.user.shopId, customerId]
    );
    const balance = Number(bal[0].balance);
    const limit = creditLimitMillimes();
    if (balance + amount > limit) {
      await client.query("ROLLBACK");
      const available = Math.max(0, limit - balance);
      return res.status(409).json({
        error: `Plafond de crédit dépassé. Solde actuel : ${formatDT(balance)}, disponible : ${formatDT(available)}.`,
      });
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

    // Conservation : si le solde retombe à 0 et que l'option est activée,
    // on supprime la photo (best-effort, ne remet JAMAIS le remboursement
    // en cause). Les lignes de `credits` restent intactes (append-only).
    if (cinAutoDeleteOnZeroBalance()) {
      await autoDeleteCinIfZeroBalance(req.db, req.user.shopId, customerId).catch((e) =>
        console.error("[credits] auto-suppression CIN:", e.message)
      );
    }

    res.status(201).json({ credit: { ...credit, amount: Number(credit.amount) } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, err, "repayment-create");
  } finally {
    client.release();
  }
});

// Supprime la photo de CIN d'un créditeur si (et seulement si) son solde
// est à 0. Appelé après un remboursement quand l'option est activée.
async function autoDeleteCinIfZeroBalance(db, shopId, customerId) {
  const { rows } = await db.query(
    `SELECT c.cin_photo_path AS "path",
            COALESCE((SELECT SUM(amount) FROM credits
                       WHERE shop_id = $1 AND customer_id = $2), 0)::bigint AS balance
       FROM customers c WHERE c.shop_id = $1 AND c.id = $2`,
    [shopId, customerId]
  );
  if (rows.length === 0) return;
  if (Number(rows[0].balance) !== 0) return;
  const path = rows[0].path;
  if (!path || !storage.isConfigured()) return;
  await storage.removeCin(path);
  await db.query(
    `UPDATE customers SET cin_photo_path = NULL WHERE shop_id = $1 AND id = $2`,
    [shopId, customerId]
  );
}

module.exports = router;
