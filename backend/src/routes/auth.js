const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getPoolForCode } = require("../db");

const router = express.Router();

const CODE_RE = /^[A-Z0-9]{6,12}$/;
const PIN_RE = /^[0-9]{4,8}$/;
const TOKEN_TTL = process.env.JWT_EXPIRES_IN || "12h";

const normalizeCode = (v) => (typeof v === "string" ? v.trim().toUpperCase() : "");
const str = (v) => (typeof v === "string" ? v.trim() : "");

// Message générique : ne révèle pas si la boutique/compte existe.
const refuse = (res) => res.status(401).json({ error: "Identifiants invalides." });

// ---------------------------------------------------------------------
// POST /api/auth/login
//   { code, pin, role }  — role = "OWNER" | "CASHIER"
// L'authentification repose UNIQUEMENT sur le PIN (hashé bcrypt en base,
// `app_users.pin_hash`). L'email n'intervient pas dans le login (il servira
// aux notifications). Le jeton est signé ici (JWT_SECRET) — jamais ailleurs.
//   - Propriétaire : code boutique + PIN admin.
//   - Caissier     : code boutique + PIN caissier.
// `role` est facultatif et vaut CASHIER par défaut (compatibilité).
// ---------------------------------------------------------------------
router.post("/login", async (req, res) => {
  if (!process.env.JWT_SECRET) {
    console.error("[auth] JWT_SECRET manquant");
    return res.status(500).json({ error: "Configuration serveur incomplète." });
  }

  const code = normalizeCode(req.body?.code);
  const pin = str(req.body?.pin);
  const role = str(req.body?.role).toUpperCase();

  if (!CODE_RE.test(code)) {
    return res.status(400).json({ error: "Code boutique invalide (6 à 12 caractères A-Z/0-9)." });
  }
  if (role && role !== "OWNER" && role !== "CASHIER") {
    return res.status(400).json({ error: "Rôle invalide." });
  }
  if (!PIN_RE.test(pin)) {
    return res.status(400).json({ error: "PIN invalide (4 à 8 chiffres)." });
  }
  const wantedRole = role === "OWNER" ? "OWNER" : "CASHIER";

  // Le code boutique détermine la base à interroger (registre shops.json ;
  // DATABASE_URL par défaut si le code n'y figure pas).
  const db = getPoolForCode(code);

  try {
    const { rows: shops } = await db.query(
      `SELECT id, name, code FROM shops WHERE code = $1`,
      [code]
    );
    if (shops.length === 0) return refuse(res);
    const shop = shops[0];

    // On compare le PIN à chaque hash actif du rôle demandé (jamais de
    // hash exposé, jamais de concaténation SQL).
    const { rows: users } = await db.query(
      `SELECT id, name, role, pin_hash FROM app_users
        WHERE shop_id = $1 AND role = $2 AND is_active AND pin_hash IS NOT NULL`,
      [shop.id, wantedRole]
    );
    let user = null;
    for (const u of users) {
      if (await bcrypt.compare(pin, u.pin_hash)) { user = u; break; }
    }
    if (!user) return refuse(res);

    const token = jwt.sign(
      { userId: user.id, shopId: shop.id, role: user.role, shopCode: shop.code },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role },
      shop: { id: shop.id, code: shop.code, name: shop.name },
    });
  } catch (err) {
    console.error("[auth] login:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

module.exports = router;
