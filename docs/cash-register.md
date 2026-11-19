# Suivi de caisse (Cash Register Monitoring)

Module **réservé au propriétaire (OWNER)** à **un seul rôle** : montrer le
montant qui devrait être dans la caisse physique à l'instant présent.
L'initialisation pose le fond de caisse ; ensuite, un bouton « Montant
attendu » recalcule à l'heure du serveur. Deux actions secondaires
permettent d'**ajuster** (ajout/retrait d'argent) ou de
**réinitialiser** la caisse après un comptage réel (l'écart est enregistré
comme vérification — un écart n'est jamais une preuve de vol).

## Date d'initialisation (point de départ)

L'initialisation exige un **montant** ; la **date/heure est automatique** :
le serveur enregistre `now()` dans `effective_at` **et** `created_at` (même
transaction, donc égales). C'est le **point de départ de tous les calculs** :
seules les ventes, remboursements et mouvements **postérieurs** à cette date
comptent.

Règles de validation (front + back) :

- `POST /initialize` n'accepte que `{ amount }` ; toute date fournie dans le
  body (`initializedAt` ou autre) est **ignorée** ;
- montant initial **entier en millimes, >= 0, <= 9 999 999 999** ;
- une seule **première** initialisation par boutique (409 sinon) ; la
  **réinitialisation** passe par `POST /reinitialize` (plusieurs lignes
  `INITIALIZATION` autorisées depuis la migration 003 — le calcul part de
  la **plus récente**) ;
- CHECK `effective_at <= created_at` conservé (égalité valide).

Les anciennes lignes `INITIALIZATION` sans `effective_at` utilisent
`created_at` comme date d'initialisation (`COALESCE(effective_at,
created_at)`).

## Formule

```
Montant attendu à l'instant T (depuis la date d'initialisation) =
    montant initial
  + ventes en espèces        (sales.total WHERE customer_id IS NULL)
  + remboursements crédit    (- credits.amount WHERE amount < 0)
  + dépôts                   (cash_movements DEPOSIT,      montant > 0)
  - retraits                 (cash_movements WITHDRAWAL,   montant < 0)
  - remboursements           (cash_movements CASH_REFUND,  montant < 0)
  +/- ajustements            (cash_movements ADJUSTMENT,   signé)
```

- Seules les écritures **postérieures à la date d'initialisation** et
  **antérieures à T** comptent.
- Les **ventes à crédit** (`customer_id NOT NULL`) et les dettes sont
  **exclues** : elles n'apportent aucun espèces.
- Les **remboursements de crédit payés en espèces** (`credits.amount < 0`)
  sont **inclus** : c'est de l'argent qui entre physiquement dans la caisse.
- Les ventes en espèces et les remboursements sont **lus directement** dans
  `sales` et `credits` — jamais copiés dans `cash_movements`.
- **Réinitialisation** (`POST /reinitialize { amount }`) : enregistre une
  `cash_verifications` (théorique recalculé par le serveur vs montant
  réel, écart + statut) puis une nouvelle ligne `INITIALIZATION`. Tout
  l'historique avant la nouvelle date est ignoré.

## Convention de signe

Montants en **millimes** (`bigint`, 1 DT = 1000 millimes), jamais de flottant.

| Type             | Signe stocké | Effet sur le solde |
|------------------|--------------|--------------------|
| INITIALIZATION   | `>= 0`       | + (base)           |
| DEPOSIT          | `> 0`        | +                  |
| WITHDRAWAL       | `< 0`        | −                  |
| CASH_REFUND      | `< 0`        | −                  |
| ADJUSTMENT       | `<> 0`       | ± (signé)          |

`cash_verifications.difference = actual_balance - theoretical_balance` :
`> 0` excédent, `= 0` correct, `< 0` manque.

## Base de données

- `database/migrations/001_cash_register.sql` — tables initiales.
- `database/migrations/002_cash_register_init_date.sql` — colonne
  `effective_at` + CHECKs (NOT VALID) + bornes de montants.
- `database/migrations/003_cash_register_reinit.sql` — plusieurs lignes
  `INITIALIZATION` autorisées (réinitialisation ; le calcul part de la
  plus récente).
- `database/migrations/004_credits_repayments.sql` — `credits`
  append-only (triggers `forbid_modify()`) + RLS + index
  `credits_shop_created_idx` (utilisé par `computeExpected`).
- `database/migrations/005_revert_credit_repayments.sql` — revert de 004
  (à lancer manuellement, non exécuté par défaut).
- `database/migrations/006_manual_credits.sql` — assouplit
  `credits_amount_chk` pour autoriser une **dette manuelle** (`sale_id
  NULL`, `amount > 0`) en plus des remboursements.
- `database/schema.sql` — mis à jour avec le même contenu.
- Tables `cash_movements` et `cash_verifications` : **append-only**
  (triggers `forbid_modify()` bloquent UPDATE / DELETE / TRUNCATE),
  RLS activée sans policy, accès révoqué à `anon` / `authenticated`.
- Trigger `cash_register_check_admin()` : `admin_id` doit être un OWNER
  actif de la même boutique.
- CHECKs `NOT VALID` : les lignes existantes ne sont pas modifiées
  (append-only), mais les **nouvelles** lignes doivent les respecter.
- Le mode de paiement **n'est pas** une colonne : il est dérivé
  (`customer_id IS NULL` → `CASH`, sinon `CREDIT`).

### Appliquer les migrations

```bash
cd backend
node scripts/apply-migration.js 001_cash_register.sql
node scripts/apply-migration.js 002_cash_register_init_date.sql
```

> Le backend se connecte avec `DATABASE_URL` (rôle privilégié, ex.
> `postgres` ou `service_role`) qui contourne la RLS. Ne jamais exposer
> ces tables via l'API Supabase anon.

## Backend

- `src/db.js` — pool `pg` (`DATABASE_URL`, SSL auto si Supabase).
- `src/middleware/auth.js` — `authenticate` (JWT `Authorization: Bearer`,
  `JWT_SECRET`) et `requireOwner`.
- `src/validators/cashRegister.js` — validateurs stricts partagés :
  `validateAmount` (entier millimes, bornes), `validateDescription`
  (3-200 caractères, sans caractères de contrôle, au moins une lettre ou
  un chiffre). (`parseInitializedAt` / `validateInitializedAt` ne sont plus
  utilisés par `/initialize` : la date est l'heure du serveur.)
- `src/services/cashRegister.js` — **une seule** fonction
  `computeExpected(shopId, at)` utilisée par `/expected` et
  `/verifications` (les deux ne peuvent pas diverger) ; `listRepayments`
  (détail des remboursements par créditeur) ; `getInitialization`.
- `src/routes/cashRegister.js` — endpoints ci-dessous. Chaque mutation
  prend un **`pg_advisory_xact_lock` par boutique** (`hashtext(shop_id)`)
  pour sérialiser les lectures du montant attendu (évite les races, ex.
  deux retraits parallèles).
- `src/routes/sales.js` — `POST /api/sales` (OWNER ou CASHIER, idempotent
  via `client_sale_id`, prix recalculés côté serveur, mouvements de stock
  dans la même transaction) et `GET /api/sales` (historique +
  `paymentMethod` + nom du caissier).
- `src/routes/products.js` — `GET /api/products` (requis par la caisse).

`shop_id` et `admin_id` sont **toujours** pris du jeton vérifié, jamais de
la requête.

### Endpoints `/api/cash-register` (OWNER uniquement)

| Méthode | Route              | Corps / paramètres                     | Réponse |
|---------|--------------------|----------------------------------------|---------|
| POST    | `/initialize`      | `{ amount }` (millimes >= 0) — date = heure serveur, `initializedAt` ignoré | 201 / 400 montant invalide / 409 si déjà initialisée |
| GET     | `/expected`        | —                                      | `{ initialized, initializedAt, initialAmount, cashSales, salesCount, cashRepayments, repaymentsCount, deposits, withdrawals, refunds, adjustments, moneyAdded, moneyRemoved, expectedAmount, computedAt }` ou `{ initialized: false }` |
| POST    | `/withdrawals`     | `{ amount > 0, description }`          | stocké en négatif ; **409** si > montant attendu ; 409 si non initialisée |
| POST    | `/deposits`        | `{ amount > 0, description }`          | stocké en positif ; 409 si non initialisée |
| POST    | `/adjustments`     | `{ amount > 0, direction: "ADD"\|"REMOVE", reason? }` | `reason` absent/vide → « Ajustement sans motif » ; fourni → 3-200 car. avec lettre/chiffre ; REMOVE > attendu → **409** ; 409 si non initialisée |
| POST    | `/reinitialize`    | `{ amount >= 0 }` (millimes) — date = heure serveur | vérification (théorique vs réel, écart) + nouvelle `INITIALIZATION` ; 409 si non initialisée |
| POST    | `/verifications`   | `{ actualAmount >= 0 }`                | montant attendu recalculé par le serveur, ligne insérée avec `difference` et `status` générés |
| GET     | `/movements?from&to&limit` | plus récents d'abord, avec `admin_name` | (conservé pour l'API) |
| GET     | `/verifications?limit`     | plus récentes d'abord, avec `admin_name` | (conservé pour l'API) |
| GET     | `/repayments?from&to`      | détail des remboursements de crédit (nom du créditeur + de l'enregistreur) — alimente le bloc « Remboursements de crédit » de la carte résultat |

### Endpoints ventes

| Méthode | Route        | Détails |
|---------|--------------|---------|
| POST    | `/api/sales` | `{ id: uuid, lines: [{ productId, quantity }] }` — OWNER ou CASHIER. Prix et total recalculés par le serveur ; produits fusionnés ; idempotent (même `id` → même vente, pas de doublon). |
| GET     | `/api/sales` | Historique avec `paymentMethod` (`CASH`/`CREDIT`) et `cashierName`. |
| GET     | `/api/products` | Produits actifs (`?all=true` réservé OWNER). |

### Endpoints crédits (`/api/credits`)

`src/routes/credits.js` (monté dans `src/index.js`). Toutes les routes
exigent un jeton valide (`authenticate`). Les montants sont des entiers
en **millimes > 0** côté requête, **jamais** de flottant.

| Méthode | Route                        | Corps / paramètres | Accès | Détails |
|---------|------------------------------|--------------------|-------|---------|
| GET     | `/customers`                 | —                  | OWNER + CASHIER | clients + solde dû (`SUM(credits.amount)`) |
| GET     | `/customers/:id`            | —                  | OWNER + CASHIER | détail + historique (dette, remboursement, annulation) |
| POST    | `/customers/:id/validate`   | —                  | **OWNER** | `PENDING → VALIDATED` ; 409 si déjà validé |
| POST    | `/debts`                     | `{ customerId, amount > 0, note?, id (uuid) }` | **OWNER** | dette manuelle sans vente (`sale_id NULL`, `amount > 0`) ; client `VALIDATED` requis (409) ; idempotent via `id` |
| POST    | `/repayments`               | `{ customerId, amount > 0, note?, id (uuid) }` | OWNER + CASHIER | stocké **négatif** (`amount < 0`, `sale_id NULL`) ; 409 si `amount > solde dû` ou solde ≤ 0 ; idempotent via `id` |

**Impact sur le montant attendu** : `computeExpected` additionne
`credits.amount < 0` (remboursements) comme **entrées d'espèces** dans la
caisse. Un remboursement augmente donc le montant attendu dès son
enregistrement — c'est la seule écriture `credits` qui compte dans la
caisse (les dettes, `amount > 0`, en sont exclues). Le détail par
créditeur est exposé par `GET /api/cash-register/repayments`.

## Frontend

- Page `/owner/cash-register` (`src/pages/CashRegister.js`), visible dans
  la navigation **uniquement pour OWNER** ; un caissier qui ouvre l'URL
  voit un message 403.
- **Page à UN seul rôle** : montrer le montant qui devrait être dans la
  caisse physique. Pas de filtres, pas d'historiques, pas de mouvements
  manuels ni de vérification dans l'interface (les endpoints backend
  `/withdrawals`, `/deposits`, `/adjustments`, `/verifications`,
  `/movements` restent disponibles pour l'API).
- Deux états :
  1. **Non initialisée** (`initialized:false`) : phrase « Saisissez
     l'argent présent dans la caisse en ce moment. », champ « Montant
     dans la caisse (DT) » (`type="text"`, `inputMode="decimal"`,
     `autoComplete="off"`, regex `^\d{1,7}([.,]\d{1,3})?$`, max 3
     décimales, max 9 999 999,999 DT, 0 autorisé, conversion millimes
     sans flottant, erreurs inline au blur/soumission avec
     `aria-invalid`/`aria-describedby`), ligne grisée « Date et heure :
     automatique » (heure de Tunis rafraîchie chaque seconde,
     indicative — la date enregistrée est l'heure du serveur), bouton
     « Initialiser la caisse » désactivé tant que le montant est invalide,
     **dialogue de confirmation** avant envoi.
  2. **Initialisée** : ligne grisée « Caisse initialisée le
     JJ/MM/AAAA à HH:MM avec X DT » (date serveur, `Africa/Tunis`), UN
     bouton primaire « Montant attendu » → `GET /expected` → carte
     résultat : « Montant attendu en caisse : X DT », « Calculé le
     JJ/MM/AAAA à HH:MM » (`computedAt` serveur), ventilation
     **Montant initial / + Ventes en espèces (N) / + Remboursements de
     crédit (N) / + Argent ajouté / - Argent retiré** (les deux dernières
     seulement si non nulles — les lignes somment au total), note
     « Les ventes à crédit ne sont pas comptées ». Quand
     `repaymentsCount > 0`, un bloc « Remboursements de crédit » liste
     chaque remboursement (créditeur, date, enregistreur, montant) via
     `GET /api/cash-register/repayments?from=<initializedAt>` — **même
     période que le total** (depuis l'initialisation). Chaque clic recalcule
     à l'heure serveur (pas de polling). Pendant le calcul : bouton
     désactivé « Calcul en cours... » ; en cas d'erreur : message
     français + « Réessayer ».
  3. **Deux boutons secondaires** (panneaux, un à la fois, rien de
     sauvegardé à la fermeture sans confirmation) :
     - **Ajuster la caisse** : bascule « Ajouter de l'argent » /
       « Retirer de l'argent », montant > 0, motif facultatif (compteur
       x/200), « Enregistrer » → confirmation → message de succès ;
       la carte résultat est recalculée automatiquement si affichée.
     - **Réinitialiser la caisse** : charge `GET /expected` à
       l'ouverture (« Montant attendu actuellement : X DT »), montant
       réel (0 autorisé), **écart en direct** (« manque de… / excédent
       de… / aucun écart »), « Réinitialiser » → dialogue de
       confirmation avec les valeurs serveur → message de succès
       **depuis les valeurs renvoyées** (« Caisse réinitialisée. Écart
       enregistré : … »), ligne 1 mise à jour, carte résultat effacée.
       Note : « Un écart n'est pas une preuve : vérifiez les ventes et
       les mouvements. »
- `src/utils/money.js` — conversion DT ↔ millimes **sans flottant**
  (parsing par chaîne + `Number` borné, formatage manuel) ;
  `src/api.js` ré-exporte `dtToMillimes` / `formatMillimes`.
- `src/utils/amount.js` — `parseAmountDT` : parsing strict des montants
  (regex `^\d{1,7}([.,]\d{1,3})?$`, 3 décimales max, sans flottant),
  testé par `amount.test.js` (Jest).
- `src/api.js` — `apiFetch` joint `Authorization: Bearer <jeton>` depuis
  `localStorage["sg_token"]`. **Le flux de login (hors périmètre) doit
  enregistrer le JWT sous cette clé** pour que les appels authentifiés
  fonctionnent. Les erreurs affichent le message français du serveur
  (`error`/`message`) ; réseau ou statut inconnu → « Le service est
  indisponible, réessayez. » (détails techniques en console uniquement,
  jamais « Erreur 404 » brut).
- **Proxy dev** : `frontend/package.json` contient
  `"proxy": "http://localhost:4000"` — sans lui, le serveur de dev CRA
  renvoie `index.html` pour `GET /api/*` et 404 pour `POST /api/*`
  (cause du bug 404 d'initialisation).
- Caisse (`CashierPOS.js`) : la vente « Espèces » est envoyée à
  `POST /api/sales` avec un `crypto.randomUUID()` généré une fois par
  panier (réutilisé en cas de nouvelle tentative). Le panier n'est vidé
  qu'après confirmation du serveur. Le bouton « Crédit » est désactivé
  (« bientôt disponible »).
- Historique des ventes : affiche `paymentMethod` (Espèces / Crédit) et
  le nom du caissier.
- Page `/owner/credits` (`src/pages/CreditManagement.js`) : **Gestion des
  crédits** (données réelles via `/api/credits`). OWNER valide les
  clients, ajoute des dettes et rembourse ; CASHIER consulte et enregistre
  des remboursements. Le lien « Crédits » apparaît dans la nav pour
  CASHIER et OWNER (`src/components/AppShell.js`).

## Tests

```bash
# 1. Migrer la base (schema.sql + migrations 001..006)
# 2. Démarrer le backend :  cd backend && npm run dev
# 3. Tests unitaires validateurs backend :
cd backend && node scripts/test-validators.js
# 4. Tests unitaires money.js (frontend) :
cd frontend && set CI=true&& npm test -- --watchAll=false --testPathPattern=money
# 5. Tests statiques frontend (UI caisse) :
cd backend && node scripts/test-frontend-cash.js
# 6. Tests d'intégration caisse :
cd backend
DATABASE_URL="postgresql://..." JWT_SECRET="..." node scripts/test-cash-register.js
# 7. Tests d'intégration crédits (dettes, remboursements, validation client) :
cd backend
DATABASE_URL="postgresql://..." JWT_SECRET="..." node scripts/test-credits.js
```

Le script d'intégration couvre : **date d'initialisation automatique**
(`initializedAt` passé/futur ignoré, `effective_at = created_at` = heure
serveur ±5 s, `shop_id`/`admin_id` forgés ignorés), régression chemins
frontend jamais 404 (+ proxy :3000 si démarré), l'exemple de référence (230.500
DT, écart −1.000 SHORTAGE, CORRECT, SURPLUS), exclusion des ventes à
crédit et inclusion des remboursements, 403 caissier / 401 sans jeton sur
les 8 routes, `shop_id`/`admin_id` forgés ignorés, seconde initialisation
→ 409, UPDATE/DELETE bloqués en base, **retrait > attendu → 409**,
**validations de description** (trop courte, caractère de contrôle, sans
lettre ni chiffre, trop longue → 400), **retraits parallèles** (verrou
consultatif : un 201, un 409, solde final exact), boutique non
initialisée → 409, idempotence de `POST /api/sales`.

`test-credits.js` couvre : validation client (CASHIER 403, OWNER OK,
double validation 409), dette manuelle (CASHIER 403, OWNER 201,
idempotence), remboursement (CASHIER 201 stocké en négatif, dépassement
du solde 409, idempotence, solde restant exact), liste + détail client, et
**impact caisse** : `computeExpected` inclut le remboursement dans
`cashRepayments`/`repaymentsCount` et dans `expectedAmount`, et
`listRepayments` renvoie le nom du créditeur.

Chaque exécution crée des boutiques de test uniques (les tables
financières étant append-only, aucun nettoyage n'est possible). Aucune
boutique réelle n'est touchée.

## Limites connues

- Le login/émission de JWT est hors périmètre : sans jeton stocké sous
  `sg_token`, l'interface affiche « Authentification requise ».
- Les ventes à crédit (client + code personnel) ne sont pas implémentées :
  la gestion des crédits se fait par **dette manuelle** (`POST
  /api/credits/debts`) et **remboursement** (`POST /api/credits/repayments`),
  pas encore via le tunnel de vente à crédit.
- Les remboursements `CASH_REFUND` n'ont pas d'endpoint manuel (module
  retours hors périmètre) ; la table et les contraintes sont prêtes.
- `credits` : seuls les `amount < 0` (remboursements) comptent dans le
  montant attendu, conformément à la formule ; les contre-passations
  (`reverses_id`) sont prévues par le CHECK mais pas encore gérées par
  l'API.
- Les endpoints `GET /movements` et `GET /verifications` restent
  disponibles pour l'API mais ne sont plus affichés dans l'interface.
