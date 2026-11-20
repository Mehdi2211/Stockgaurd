# StockGuard

Application de gestion de boutique (kiosque) : produits, stock, ventes
(POS), suivi de caisse et gestion des crédits clients.

- **Backend** : Node.js / Express + PostgreSQL (Supabase), JWT.
- **Frontend** : React (Create React App).
- **Monnaie** : montants stockés en **millimes** (`bigint`, 1 DT = 1000),
  jamais en flottant.

Toutes les données (utilisateurs, boutiques, produits, stock, ventes,
crédits, scans) sont lues et écrites en **base de données** : aucun mock,
aucune donnée de démonstration en dur, aucun JWT fabriqué à la main.

## Structure

```
backend/     API Express (routes, services, middleware, scripts)
  src/db.js        gestionnaire de pools pg (un pool par base de boutique)
  src/routes/      auth, shop, kiosk, products, scans, sales,
                   customers, stock, owner, cashRegister, credits
  src/middleware/  auth.js (requireAuth, requireRole + alias)
  shops.json       registre multi-boutique : code → URL de base (non versionné)
frontend/    React (pages, composants, context, hooks, utils)
database/    schema.sql + migrations SQL (001..010)
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

### Variables d'environnement (`backend/.env`)

| Variable         | Rôle                                                        |
|------------------|-------------------------------------------------------------|
| `DATABASE_URL`   | Chaîne de connexion PostgreSQL (Supabase). Base par défaut. |
| `PORT`           | Port d'écoute de l'API (défaut `4000`).                     |
| `FRONTEND_URL`   | Origine autorisée (CORS).                                   |
| `BCRYPT_ROUNDS`  | Coût du hachage bcrypt (défaut `12`).                       |
| `JWT_SECRET`     | **Secret de signature des JWT (jamais en dur).**            |
| `JWT_EXPIRES_IN` | Durée de vie des jetons (défaut `12h`).                     |
| `PGSSL`          | `require` pour forcer SSL (Supabase) ; vide en local.       |
| `SHOPS_CONFIG`   | Chemin du registre (défaut `backend/shops.json`).           |

## Multi-boutique (un serveur, N bases)

Chaque kiosque possède **son code boutique** et **sa base de données**. Le
code saisi au login détermine la base sur laquelle l'application travaille :
un même serveur peut héberger plusieurs boutiques (bases distinctes).

- Le mapping `code → URL de base` vit dans `backend/shops.json` (non
  versionné, édité à chaque vente / ajout de client) :

  ```json
  {
    "HK221105": { "name": "Kiosque Chez Ali", "databaseUrl": "postgres://..." },
    "OTHER123": "postgres://..."
  }
  ```

- `src/db.js` résout le code en URL, crée **un pool `pg` par base** (mis en
  cache) et le réutilise.
- `POST /api/auth/login` interroge la base du code ; le JWT porte le
  `shopCode`. Le middleware `requireAuth` attache `req.db` (la base du
  code) et **toutes les routes utilisent `req.db`**.
- Si un code est **absent du registre**, on retombe sur `DATABASE_URL`
  (mode mono-boutique, développement et tests).

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
node scripts/apply-migration.js 007_auth_and_shop_scope.sql
node scripts/apply-migration.js 008_products_and_scans.sql
node scripts/apply-migration.js 009_products_category_buyprice.sql
node scripts/apply-migration.js 010_owner_pin_and_google.sql
# 005 = revert de 004 (à lancer manuellement, non exécuté par défaut)
```

Rôle des migrations :

- `001..006` — caisse (montant attendu, initialisation, réinitialisation),
  crédits append-only et dettes manuelles.
- `007_auth_and_shop_scope.sql` — `shops.owner_user_id`, isolation
  `shop_id` sur `sale_lines`, index `(shop_id, lower(email))`,
  contrainte de cohérence des identifiants.
- `008_products_and_scans.sql` — `products.updated_at` + table journal
  `product_scans` (index période / code-barres / utilisateur / vente).
- `009_products_category_buyprice.sql` — `products.category` et
  `products.buy_price` (colonnes optionnelles, additif).
- `010_owner_pin_and_google.sql` — login propriétaire par **PIN**
  (assouplit la contrainte d'identifiants) ; ajoute `app_users.google_sub`
  et `email_verified` (réservés aux notifications futures, hors login).

### Seed (catalogue de démonstration, idempotent)

```bash
cd backend
# Catalogue de 18 produits d'exemple pour une boutique existante
node scripts/seed-products.js [CODE_BOUTIQUE]
```

Le script crée un mouvement de stock `INITIAL` par produit nouvellement
inséré et est relançable sans risque (aucun doublon). La boutique et ses
utilisateurs (PIN hashés bcrypt) se provisionnent **directement en base** :
il n'y a plus de script de seed boutique.

## Authentification

- `POST /api/auth/login` vérifie les identifiants **dans la base du code
  boutique** et renvoie un JWT signé (`JWT_SECRET`). L'authentification
  repose **uniquement sur le PIN** hashé bcrypt (`app_users.pin_hash`).
  - **OWNER** : `{ code, pin, role: "OWNER" }` (PIN d'administration).
  - **CASHIER** : `{ code, pin, role: "CASHIER" }` (`role` facultatif :
    `CASHIER` par défaut).
  - L'email **n'intervient pas** dans le login ; il est conservé pour
    l'envoi ultérieur de notifications (`app_users.email`, `email_verified`).
- Le middleware `requireAuth` valide le JWT et expose
  `req.user = { userId, shopId, role, shopCode }` ainsi que `req.db` (le
  pool de la base de la boutique) ; `requireRole("OWNER")` restreint
  l'accès. **`shop_id`, `user_id`, `role` et `shopCode` viennent
  uniquement du jeton vérifié**, jamais du body / query / headers.
- Toutes les requêtes métier sont filtrées par le `shop_id` du jeton
  (isolation multi-boutique).
- Frontend : page de login réelle, jeton stocké sous
  `localStorage["sg_token"]`, `apiFetch` ajoute le header `Authorization`
  et redirige vers le login sur `401`.

## Routes principales

| Domaine   | Fichier                         | Routes |
|-----------|---------------------------------|--------|
| Auth      | `src/routes/auth.js`            | `POST /api/auth/login` (`{code,pin,role}` ; `role` = OWNER/CASHIER) |
| Boutique  | `src/routes/shop.js`            | `GET /api/shop/me` |
| Produits  | `src/routes/products.js`        | `GET /api/products` (paginé + recherche, `?all=true` OWNER), `GET /api/products/:id`, `GET /api/products/barcode/:barcode`, `POST` / `PUT :id` (OWNER) |
| Scans     | `src/routes/scans.js`           | `POST /api/scans` (journalise, n'affecte ni stock ni caisse), `GET /api/scans` (filtres période/utilisateur/statut, paginé) |
| Stock     | `src/routes/stock.js`           | `GET /api/stock/movements`, `POST /api/stock/adjustment` (OWNER) |
| Ventes    | `src/routes/sales.js`           | `POST /api/sales` (idempotent), `GET /api/sales` |
| Crédits   | `src/routes/credits.js`         | clients, dettes, remboursements, validation |
| Caisse    | `src/routes/cashRegister.js`    | `GET /expected`, `POST /initialize`, `/reinitialize`, ... (OWNER) |
| Dashboard | `src/routes/owner.js`           | `GET /api/owner/stats` |

Détail complet de la caisse et des crédits : voir
[docs/cash-register.md](docs/cash-register.md).

## Tests

```bash
cd backend
node scripts/test-validators.js           # validateurs
node scripts/test-frontend-cash.js        # UI caisse (statique)
node scripts/test-cash-register.js        # intégration caisse (backend démarré)
node scripts/test-cash-register-v2.js     # intégration caisse (variante, login réel)
node scripts/test-credits.js              # intégration crédits (backend démarré)
node scripts/test-auth-products-scans.js  # auth, boutique, produits, scans, stock,
                                          # dashboard, isolation shop_id
```

Les scripts d'intégration s'exécutent contre le backend **démarré** et une
base réelle (DATABASE_URL + JWT_SECRET). Chaque exécution crée des
boutiques de test uniques ; aucune boutique réelle n'est touchée. Les
tests se connectent via `POST /api/auth/login` (plus aucun JWT fabriqué à
la main). Comme ces codes de test ne figurent pas dans `shops.json`, ils
utilisent la base `DATABASE_URL` par défaut.

## Documentation

- [docs/cash-register.md](docs/cash-register.md) — suivi de caisse et
  intégration des remboursements de crédit dans le montant attendu.
