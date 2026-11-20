-- =====================================================================
-- 009 : Produits — catégorie + prix d'achat (colonnes optionnelles)
-- Idempotent : peut être relancé sans risque.
-- ADDITIF uniquement : ne touche pas aux colonnes existantes
-- (price, current_stock, min_stock, is_active) ni à la logique métier.
-- =====================================================================

-- 1. Catégorie libre (ex. "Épicerie", "Boissons"). Optionnelle.
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;

-- 2. Prix d'achat en millimes (entier, >= 0). Optionnel, pour la marge.
ALTER TABLE products ADD COLUMN IF NOT EXISTS buy_price bigint;

DO $$ BEGIN
  ALTER TABLE products
    ADD CONSTRAINT products_buy_price_chk
    CHECK (buy_price IS NULL OR buy_price >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE products
    ADD CONSTRAINT products_category_len_chk
    CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 60);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Index de filtre par catégorie (recherche boutique).
CREATE INDEX IF NOT EXISTS products_shop_category_idx
  ON products (shop_id, category) WHERE category IS NOT NULL;
