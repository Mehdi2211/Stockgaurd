const jwt = require("jsonwebtoken");

// Vérifie le JWT (Authorization: Bearer <token>) et expose req.user =
// { userId, shopId, role }. shopId / userId / role viennent UNIQUEMENT
// du jeton vérifié — jamais du body, de la query ou des headers.
function authenticate(req, res, next) {
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

  if (!userId || !shopId || !role) {
    return res.status(401).json({ error: "Jeton incomplet." });
  }

  req.user = { userId, shopId, role };
  next();
}

// Réservé au rôle OWNER (propriétaire).
function requireOwner(req, res, next) {
  if (req.user?.role !== "OWNER") {
    return res.status(403).json({ error: "Accès réservé au propriétaire." });
  }
  next();
}

// OWNER ou CASHIER (personnel de la boutique).
function requireStaff(req, res, next) {
  if (req.user?.role !== "OWNER" && req.user?.role !== "CASHIER") {
    return res.status(403).json({ error: "Accès réservé au personnel de la boutique." });
  }
  next();
}

module.exports = { authenticate, requireOwner, requireStaff };
