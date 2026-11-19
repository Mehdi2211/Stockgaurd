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

const kioskRoutes    = require("./routes/kiosk");
const productRoutes  = require("./routes/products");
const salesRoutes    = require("./routes/sales");
const customerRoutes = require("./routes/customers");
const stockRoutes    = require("./routes/stock");
const ownerRoutes    = require("./routes/owner");
const cashRoutes     = require("./routes/cashRegister");
const creditRoutes   = require("./routes/credits");

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
app.use("/api/kiosk",     kioskRoutes);
app.use("/api/products",  productRoutes);
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

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur." });
});

app.listen(PORT, () => console.log(`StockGuard backend : http://localhost:${PORT}`));
