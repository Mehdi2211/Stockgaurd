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
  src/services/    cashRegister, storage (CIN Supabase), mailer, outbox
  src/middleware/  auth.js (requireAuth, requireRole)
  shops.json             registre multi-boutique code → URL (non versionné)
  shop-credentials.csv   PIN admin/caissier par boutique (non versionné)
frontend/    React (pages, composants, context, hooks, utils)
database/    schema.sql + migrations SQL (001..013)
docs/        documentation fonctionnelle (caisse, crédits/CIN)
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
| `CREDIT_LIMIT` | Plafond de crédit par créditeur en DT (défaut `100`). |
| `CIN_AUTO_DELETE_ON_ZERO_BALANCE` | `true` : supprime la photo CIN au solde 0 (défaut `false`). |
| `SUPABASE_URL` | URL du projet Supabase (stockage des photos de CIN). |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé **service_role** (secrète) pour le bucket privé. |
| `SUPABASE_CIN_BUCKET` | Nom du bucket privé (défaut `cin-photos`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP (notifications). |
| `MAIL_FROM` | Expéditeur des emails de notification. |
| `NOTIFY_RETRY_INTERVAL_MS` | Intervalle de reprise des notifications (défaut `60000`). |

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
# migrations idempotentes 001, 002, 003, 004, 006, 007, 008, 009, 010, 011, 012, 013
node scripts/apply-migration.js 001_cash_register.sql
node scripts/apply-migration.js 013_notification_outbox.sql
# 005 = revert de 004 (manuel)
```

- `001..006` — caisse + crédits append-only.
- `007` isolation `shop_id` · `008` `product_scans` · `009` `category`/`buy_price` · `010` login owner par PIN.
- `011` `shops.notification_email` · `012` photo de CIN + consentement créditeur · `013` outbox des notifications.

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
| Boutique | `GET /api/shop/me`, `PUT /api/shop/notification-email` (OWNER) |
| Produits | `GET /api/products` (paginé, `?all=true` OWNER), `GET /:id`, `GET /barcode/:barcode`, `POST`/`PUT :id` (OWNER) |
| Scans | `POST /api/scans`, `GET /api/scans` (journal, n'affecte ni stock ni caisse) |
| Stock | `GET /api/stock/movements`, `POST /api/stock/adjustment` (OWNER) |
| Ventes | `POST /api/sales` (idempotent, `customerId` ⇒ vente à crédit), `GET /api/sales` |
| Crédits | `GET /api/credits/customers` (paginé), `POST /api/credits/customers` (multipart, photo CIN), `GET/PUT/DELETE /api/credits/customers/:id/cin`, `/debts`, `/repayments`, `/consent-text` |
| Caisse | `GET /api/cash-register/expected`, `POST /initialize`, `/reinitialize` (OWNER) |
| Dashboard | `GET /api/owner/stats` |

Détail caisse : [docs/cash-register.md](docs/cash-register.md) ·
crédits / photo de CIN : [docs/credits-cin.md](docs/credits-cin.md).

## Données personnelles (CIN)

Pour accorder un crédit, le commerçant collecte l'identité du créditeur et la
**photo de sa carte d'identité (CIN)** — donnée sensible (loi tunisienne, INPDP).

- **Collecté** : nom, prénom, téléphone, n° de CIN, **photo de la CIN**, consentement horodaté.
- **Accès** : le caissier **capture** la photo ; seul le **propriétaire (OWNER)** peut la **consulter**
  (URL signée **60 s**), la **reprendre** ou la **supprimer**. Le caissier ne peut **jamais** la relire.
- **Minimisation** : jamais de photo/URL/n° de CIN dans les listes, les emails ni les logs.
- **Conservation** : le temps de la dette ; suppression dès le solde soldé
  (`DELETE .../cin`, ou automatique via `CIN_AUTO_DELETE_ON_ZERO_BALANCE`).
- **Validation** : formats JPEG/PNG/WEBP (type réel vérifié), 5 Mo max, bucket **privé**.

Détail complet : [docs/credits-cin.md](docs/credits-cin.md).

## Tests

```bash
cd backend
node scripts/test-validators.js           # validateurs
node scripts/test-frontend-cash.js        # UI caisse (statique)
node scripts/test-cash-register.js        # caisse (backend démarré)
node scripts/test-credits.js              # crédits (backend démarré)
node scripts/test-credit-cin.js           # crédit + CIN + plafond + outbox (backend démarré)
node scripts/test-auth-products-scans.js  # auth, produits, scans, stock, isolation
node scripts/test-smtp.js [email]         # vérifie le SMTP et envoie un email de test
```

Les tests d'intégration tournent contre le backend **démarré** + une base réelle.
Ils créent des boutiques de test uniques (codes absents de `shops.json` → base
`DATABASE_URL`) et se connectent via le login réel. `test-credit-cin.js` **nettoie**
ce qu'il crée ; les assertions nécessitant Supabase Storage sont signalées `SKIP`
si `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` ne sont pas configurés.
