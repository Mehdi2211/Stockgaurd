const jwt = require("jsonwebtoken");
const { getPoolForCode, getDefaultPool } = require("../db");

// Vérifie le JWT (Authorization: Bearer <token>) et expose req.user =
// { userId, shopId, role, shopCode } ainsi que req.db (le pool de la
// base de la boutique). shopId / userId / role / shopCode viennent
// UNIQUEMENT du jeton vérifié — jamais du body, de la query ou des
// headers. Une boutique = un code = une base (voir shops.json).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: "Authentification requise." });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Jeton invalide ou expiré." });
  }

  const userId = payload.userId || payload.sub;
  const { shopId, role } = payload;
  const shopCode = typeof payload.shopCode === "string" ? payload.shopCode : "";

  if (!userId || !shopId || !role) {
    return res.status(401).json({ error: "Jeton incomplet." });
  }

  req.user = { userId, shopId, role, shopCode };

  // La base est choisie par le code boutique du jeton (registre
  // shops.json). Sans code, on retombe sur DATABASE_URL (dev / tests).
  try {
    req.db = shopCode ? getPoolForCode(shopCode) : getDefaultPool();
  } catch (err) {
    console.error("[auth] résolution de la base :", err.message);
    return res.status(500).json({ error: "Erreur interne du serveur." });
  }
  next();
}

// Restreint l'accès à une liste de rôles. Usage : requireRole("OWNER").
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Accès réservé au propriétaire." });
    }
    next();
  };
}

// Alias historiques (routes caisse / produits / crédits).
const authenticate = requireAuth;
function requireOwner(req, res, next) {
  return requireRole("OWNER")(req, res, next);
}

module.exports = { requireAuth, requireRole, authenticate, requireOwner };
