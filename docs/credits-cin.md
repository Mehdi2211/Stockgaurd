# Crédits & photo de CIN

Documents la gestion du crédit client, le parcours d'encaissement « Crédit »
au POS et le traitement de la **photo de la CIN** (donnée personnelle sensible).

## Vue d'ensemble

- Un **créditeur** est un client (`customers`) rattaché à une boutique (`shop_id`).
- Le **solde dû** = `SUM(credits.amount)` du créditeur (dette > 0, remboursement < 0).
- Table `credits` **append-only** : jamais de mise à jour ni de suppression de lignes.
- **Plafond** par créditeur : `CREDIT_LIMIT` DT (défaut **100**), contrôlé côté serveur.

## Parcours d'encaissement (POS)

1. Le caissier clique **Espèces** ou **Crédit**.
2. « Crédit » ouvre le sélecteur de créditeurs (recherche + pagination) :
   nom, prénom, téléphone, solde dû, disponible restant.
   Un créditeur au disponible insuffisant est affiché mais **désactivé** avec la raison.
3. **Ajouter un profil** : nom, prénom, téléphone, **n° et photo de CIN**, case de
   consentement — tous obligatoires.
4. À la création, un email est envoyé au propriétaire (asynchrone, non bloquant).
5. La vente à crédit crée **dans une seule transaction** : la vente, ses lignes, la
   baisse de stock et la ligne `credits` liée au `sale_id`. Si le plafond est refusé,
   **rien** n'est enregistré.
6. Une vente à crédit **n'entre pas** dans le montant attendu de caisse (seuls les
   remboursements y entrent).

## Plafond de crédit (serveur)

- Constante `CREDIT_LIMIT` (`.env`, défaut `100` DT), convertie en millimes
  (`100 DT = 100000`).
- À chaque dette (vente à crédit **ou** dette manuelle), dans une transaction :
  la ligne du créditeur est verrouillée (`SELECT ... FOR UPDATE`), le solde est
  recalculé depuis `credits`, et l'opération est refusée (**409**) si
  `solde + montant > plafond`. Cela empêche le dépassement en cas de ventes
  simultanées (une seule passe).
- Les **remboursements** ne sont pas limités : ils réduisent le solde.

## Photo de la CIN et consentement

- Formats acceptés : **JPEG / PNG / WEBP** uniquement (vérification par *magic
  bytes*, pas l'extension), **5 Mo** max.
- Stockage dans un **bucket Supabase Storage privé**, nom de fichier aléatoire
  (uuid), chemin `shop_id/uuid.ext`. Seul le **chemin** est stocké en base.
- Avis de consentement : affiché au formulaire, **case obligatoire**. Le texte
  vit dans un **fichier unique** :
  [`backend/src/constants/privacy.js`](../backend/src/constants/privacy.js)
  (exposé au front via `GET /api/credits/consent-text`). La date du consentement
  est enregistrée (`cin_consent_at`).
- La liste des créditeurs ne renvoie **jamais** la photo ni son chemin (seulement
  un booléen `hasCin`).

### Accès à la photo

| Action | Route | Rôle |
|--------|-------|------|
| Voir la CIN (URL signée 60 s) | `GET /api/credits/customers/:id/cin` | **OWNER** |
| Supprimer la CIN | `DELETE /api/credits/customers/:id/cin` | **OWNER** |
| (Re)capturer la CIN | `PUT /api/credits/customers/:id/cin` | OWNER + CASHIER |

- Le **caissier** peut prendre la photo mais **ne peut jamais la relire** (403).
- La photo et son URL ne figurent **jamais** dans les emails, les logs ou les listes.

### Durée de conservation & suppression

- `DELETE` supprime d'abord le fichier du bucket, **puis** met `cin_photo_path` à
  `NULL`. Si la suppression du fichier échoue, rien n'est modifié et l'erreur est
  journalisée (**cohérence**).
- Option `CIN_AUTO_DELETE_ON_ZERO_BALANCE` (`.env`, défaut `false`) : si `true`,
  la photo est supprimée automatiquement quand le solde retombe à 0 après un
  remboursement.
- Un profil **sans photo** reste valide, mais **toute nouvelle dette exige de
  reprendre la photo** (même formulaire + consentement).
- La suppression de la photo **ne touche jamais** aux lignes `credits` (append-only).

## Données personnelles (CIN)

- **Ce qui est collecté** : nom, prénom, téléphone, numéro de CIN, photo de la CIN
  et horodatage du consentement.
- **Qui y accède** : le caissier peut **capturer** la photo ; seuls le
  **propriétaire (OWNER)** peut la **consulter** (URL signée 60 s) ou la supprimer.
- **Pourquoi** : garantir le crédit accordé au client (base légale : consentement).
- **Durée de conservation** : le temps de la dette. La photo est supprimée dès que
  le solde est soldé (manuellement, ou automatiquement si l'option est activée).
- **Suppression** : `DELETE /api/credits/customers/:id/cin` (OWNER) ; le fichier est
  retiré du bucket et le chemin remis à `NULL`.
- **Minimisation** : la photo n'apparaît dans aucune liste, aucun email, aucun log.
- Conformité visée : loi tunisienne sur la protection des données personnelles
  (INPDP).

## Configuration

### Bucket Supabase Storage privé (obligatoire)

1. Supabase → **Storage** → **New bucket**.
2. Nom : `cin-photos` (ou la valeur de `SUPABASE_CIN_BUCKET`).
3. **Public = OFF** (bucket **privé**).
4. Supabase → **Project Settings → API** : copier
   - `Project URL` → `.env` `SUPABASE_URL`
   - `service_role` (secrète) → `.env` `SUPABASE_SERVICE_ROLE_KEY`
5. Ajouter dans `.env` : `SUPABASE_CIN_BUCKET=cin-photos`.
6. Aucune politique RLS n'est requise : l'accès se fait côté serveur avec la clé
   `service_role` et les URL signées.

Variables concernées : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_CIN_BUCKET`.

### SMTP (notifications au propriétaire)

Variables : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
(voir les exemples Gmail / Brevo / Resend dans `.env.example`).

Tester la configuration **avant** d'utiliser l'application :

```bash
cd backend
node scripts/test-smtp.js                # envoie au notification_email d'une boutique
node scripts/test-smtp.js a@b.com        # ou à une adresse donnée
```

Le script vérifie la connexion (`transporter.verify()`) puis envoie un email de
test. Au démarrage, le serveur journalise un **avertissement non bloquant** si le
SMTP n'est pas configuré.

### File d'attente des notifications (`notification_outbox`)

- Chaque notification est d'abord enregistrée (`status = 'pending'`), puis envoyée
  en tâche de fond (**non bloquant**). Un échec **n'empêche jamais** la création du
  profil.
- Reprise : **3 tentatives** max, délai croissant (30 s × tentative). Sans SMTP
  configuré, les entrées restent en attente et **aucune tentative n'est consommée**.
- Le `payload` ne contient **aucune donnée sensible** (pas de photo, d'URL ni de n° de CIN).

### HTTPS et caméra (capture sur tablette)

La capture utilise `<input type="file" accept="image/*" capture="environment">`
(pas `getUserMedia`) : elle fonctionne sans HTTPS strict et garde un repli
« choisir un fichier » si la caméra est indisponible.

En dehors de `localhost`, certaines API navigateur (dont la caméra) **exigent
HTTPS**. Pour tester sur une tablette en réseau local :

- **Tunnel HTTPS de développement** (le plus simple) : exposez le frontend via un
  tunnel (ex. `cloudflared tunnel --url http://localhost:3000` ou `ngrok http 3000`)
  et ouvrez l'URL HTTPS obtenue sur la tablette.
- **Certificat local** : servez le frontend en HTTPS avec un certificat de
  développement de confiance (ex. `mkcert`) et accédez via `https://<ip-locale>:3000`.

En **production**, l'application doit être servie en **HTTPS**.

## Points non traités

- Pas de chiffrement côté application des photos (repose sur le chiffrement
  au repos du stockage Supabase).
- Pas de purge planifiée automatique des photos pour les créditeurs dont la dette
  reste > 0 (suppression manuelle par l'OWNER ou automatique au solde = 0).
