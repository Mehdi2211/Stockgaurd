// Charge backend/.env si présent (pas de dépendance dotenv)
const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");

const authRoutes     = require("./routes/auth");
const shopRoutes     = require("./routes/shop");
const kioskRoutes    = require("./routes/kiosk");
const productRoutes  = require("./routes/products");
const scanRoutes     = require("./routes/scans");
const salesRoutes    = require("./routes/sales");
const customerRoutes = require("./routes/customers");
const stockRoutes    = require("./routes/stock");
const ownerRoutes    = require("./routes/owner");
const cashRoutes     = require("./routes/cashRegister");
const creditRoutes   = require("./routes/credits");
const outbox         = require("./services/outbox");
const mailer         = require("./services/mailer");

const app  = express();
const PORT = process.env.PORT || 4000;

// Security
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use("/api/", limiter);

// Routes
app.use("/api/auth",      authRoutes);
app.use("/api/shop",      shopRoutes);
app.use("/api/kiosk",     kioskRoutes);
app.use("/api/products",  productRoutes);
app.use("/api/scans",     scanRoutes);
app.use("/api/sales",     salesRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/stock",     stockRoutes);
app.use("/api/owner",     ownerRoutes);
app.use("/api/cash-register", cashRoutes);
app.use("/api/credits", creditRoutes);

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 404
app.use((_req, res) => res.status(404).json({ error: "Route introuvable." }));

// Gestionnaire d'erreurs centralisé : journal complet côté serveur,
// message générique côté client (jamais de fuite de détails techniques).
app.use((err, _req, res, _next) => {
  console.error("[erreur]", err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: "Erreur interne du serveur." });
});

app.listen(PORT, () => {
  console.log(`StockGuard backend : http://localhost:${PORT}`);
  // Avertissement clair (non bloquant) si le SMTP n'est pas configuré :
  // les notifications de création de profil resteront dans l'outbox.
  if (!mailer.isConfigured()) {
    console.warn(
      "[mail] SMTP non configuré : les emails de notification ne seront pas " +
      "envoyés (définir SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM)."
    );
  }
  // Worker de l'outbox : reprend les notifications en attente/échouées.
  outbox.startWorker();
});
