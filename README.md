# StockGuard

Application de gestion de boutique (kiosque) : produits, stock, ventes
(POS), suivi de caisse et gestion des crédits clients.

- **Backend** : Node.js / Express + PostgreSQL (Supabase), JWT.
- **Frontend** : React (Create React App).
- **Monnaie** : montants stockés en **millimes** (`bigint`, 1 DT = 1000),
  jamais en flottant.

## Structure

```
backend/     API Express (routes, services, middleware, scripts)
  src/routes/      kiosk, products, sales, customers, stock, owner,
                   cashRegister, credits
frontend/    React (pages, composants, context, utils)
database/    schema.sql + migrations SQL (001..006)
docs/        documentation fonctionnelle (voir docs/cash-register.md)
.kiro/       specs Kiro (cash-register-monitoring)
```

## Démarrage

```bash
# Backend
cd backend
cp .env.example .env      # renseigner DATABASE_URL, JWT_SECRET, ...
npm install
npm run dev               # http://localhost:4000

# Frontend
cd frontend
npm install
npm start                 # http://localhost:3000 (proxy -> :4000)
```

## Base de données

Appliquer le schéma puis les migrations (idempotentes) :

```bash
cd backend
node scripts/apply-schema.js
node scripts/apply-migration.js 001_cash_register.sql
node scripts/apply-migration.js 002_cash_register_init_date.sql
node scripts/apply-migration.js 003_cash_register_reinit.sql
node scripts/apply-migration.js 004_credits_repayments.sql
node scripts/apply-migration.js 006_manual_credits.sql
# 005 = revert de 004 (à lancer manuellement, non exécuté par défaut)
```

## Tests

```bash
cd backend
node scripts/test-validators.js      # validateurs
node scripts/test-frontend-cash.js   # UI caisse (statique)
node scripts/test-cash-register.js   # intégration caisse (backend démarré)
node scripts/test-credits.js         # intégration crédits (backend démarré)
```

## Documentation

Voir [docs/cash-register.md](docs/cash-register.md) pour le détail du suivi
de caisse et de l'intégration des remboursements de crédit dans le montant
attendu en caisse.
