# StockGuard

Application de gestion de boutique (kiosque) : produits, stock, ventes (POS),
caisse et crédits clients.

- **Backend** : Node.js / Express + PostgreSQL (Supabase), JWT.
- **Frontend** : React (Create React App).
- **Monnaie** : montants en **millimes** (`bigint`, 1 DT = 1000), jamais en flottant.

Tout est lu/écrit en base : aucun mock, aucune donnée en dur, aucun JWT fabriqué à la main.

## Structure

```
backend/     API Express (routes, middleware, scripts)
  src/db.js        pools pg (un pool par base de boutique)
  src/routes/      auth, shop, products, scans, sales, customers,
                   stock, owner, cashRegister, credits
  src/middleware/  auth.js (requireAuth, requireRole)
  shops.json             registre multi-boutique code → URL (non versionné)
  shop-credentials.csv   PIN admin/caissier par boutique (non versionné)
frontend/    React (pages, composants, context, hooks, utils)
database/    schema.sql + migrations SQL (001..010)
docs/        documentation fonctionnelle
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

### Variables d'environnement (`backend/.env`)

| Variable | Rôle |
|----------|------|
| `DATABASE_URL` | Chaîne de connexion PostgreSQL (Supabase) ; base par défaut. |
| `PORT` | Port de l'API (défaut `4000`). |
| `FRONTEND_URL` | Origine autorisée (CORS). |
| `BCRYPT_ROUNDS` | Coût bcrypt (défaut `12`). |
| `JWT_SECRET` | **Secret de signature des JWT (jamais en dur).** |
| `JWT_EXPIRES_IN` | Durée de vie des jetons (défaut `12h`). |
| `PGSSL` | `require` pour forcer SSL (Supabase). |
| `SHOPS_CONFIG` | Chemin du registre (défaut `backend/shops.json`). |

## Multi-boutique (un serveur, N bases)

Chaque kiosque a **son code** et **sa base** ; le code saisi au login choisit la base.

- Le mapping `code → URL` vit dans `backend/shops.json` (non versionné) :
  ```json
  { "HK221105": { "name": "Kiosque Chez Ali", "databaseUrl": "postgres://..." } }
  ```
- `src/db.js` résout le code et met en cache **un pool `pg` par base**.
- Le login interroge la base du code ; le JWT porte le `shopCode` ; `requireAuth`
  attache `req.db` et **toutes les routes utilisent `req.db`**.
- Code absent du registre → repli sur `DATABASE_URL` (mode mono-boutique, dev/tests).
- **Isolation logique** : au sein d'une base, chaque table métier filtre par
  `shop_id` (issu du jeton, jamais du client).

## Base de données

```bash
cd backend
node scripts/apply-schema.js
# migrations idempotentes 001, 002, 003, 004, 006, 007, 008, 009, 010
node scripts/apply-migration.js 001_cash_register.sql
node scripts/apply-migration.js 010_owner_pin_and_google.sql
# 005 = revert de 004 (manuel)
```

- `001..006` — caisse + crédits append-only.
- `007` isolation `shop_id` · `008` `product_scans` · `009` `category`/`buy_price` · `010` login owner par PIN.

### Reset (dev)

```bash
node scripts/reset-db.js   # drop exhaustif + schema.sql (transactionnel) — perte totale
```

### Provisionnement d'une boutique

La boutique (code + nom) se crée **directement en base** (table `shops`), puis :

```bash
node scripts/generate-shop-pins.js             # boutiques sans compte
node scripts/generate-shop-pins.js --all       # toutes
node scripts/generate-shop-pins.js CODE1 CODE2 # codes ciblés
```

Crée les comptes **OWNER**/**CASHIER** manquants (PIN aléatoires bcrypt) et exporte
`backend/shop-credentials.csv` (`code,nom,pin_admin,pin_caissier`, non versionné,
privé développeur). Un compte existant apparaît en `(existant)`.

### Seed catalogue

```bash
node scripts/seed-products.js [CODE_BOUTIQUE]   # 18 produits d'exemple, idempotent
```

## Authentification

- `POST /api/auth/login` vérifie les identifiants **dans la base du code** et renvoie
  un JWT. Auth **par PIN uniquement** (bcrypt, `app_users.pin_hash`) :
  `{ code, pin, role }`, `role` = `OWNER` (défaut `CASHIER`).
- L'email ne sert pas au login (réservé aux notifications).
- `requireAuth` expose `req.user = { userId, shopId, role, shopCode }` + `req.db`.
  **`shop_id`, `user_id`, `role`, `shopCode` viennent uniquement du jeton vérifié.**
- Frontend : jeton dans `localStorage["sg_token"]`, `apiFetch` ajoute `Authorization`
  et redirige sur `401`.

## Routes principales

| Domaine | Routes |
|---------|--------|
| Auth | `POST /api/auth/login` |
| Boutique | `GET /api/shop/me` |
| Produits | `GET /api/products` (paginé, `?all=true` OWNER), `GET /:id`, `GET /barcode/:barcode`, `POST`/`PUT :id` (OWNER) |
| Scans | `POST /api/scans`, `GET /api/scans` (journal, n'affecte ni stock ni caisse) |
| Stock | `GET /api/stock/movements`, `POST /api/stock/adjustment` (OWNER) |
| Ventes | `POST /api/sales` (idempotent), `GET /api/sales` |
| Crédits | `/api/credits/*` (clients, dettes, remboursements) |
| Caisse | `GET /api/cash-register/expected`, `POST /initialize`, `/reinitialize` (OWNER) |
| Dashboard | `GET /api/owner/stats` |

Détail caisse/crédits : [docs/cash-register.md](docs/cash-register.md).

## Tests

```bash
cd backend
node scripts/test-validators.js           # validateurs
node scripts/test-frontend-cash.js        # UI caisse (statique)
node scripts/test-cash-register.js        # caisse (backend démarré)
node scripts/test-credits.js              # crédits (backend démarré)
node scripts/test-auth-products-scans.js  # auth, produits, scans, stock, isolation
```

Les tests d'intégration tournent contre le backend **démarré** + une base réelle.
Ils créent des boutiques de test uniques (codes absents de `shops.json` → base
`DATABASE_URL`) et se connectent via le login réel.
