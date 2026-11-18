import React, { useState, useEffect, useRef } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";
import { apiFetch } from "../api";


const dt = (m) => (m / 1000).toFixed(3) + " DT";

// Demo products — replaced by real API when backend is ready
const DEMO_PRODUCTS = [
  { id: "1", barcode: "6191234500011", name: "Lait demi-écrémé 1 L",  price: 1450, currentStock: 42, isActive: true },
  { id: "2", barcode: "6191234500028", name: "Pain baguette",           price: 250,  currentStock: 18, isActive: true },
  { id: "3", barcode: "6191234500035", name: "Huile d'olive 1 L",       price: 14900,currentStock: 10, isActive: true },
  { id: "4", barcode: "6191234500042", name: "Harissa 380 g",           price: 2300, currentStock: 25, isActive: true },
  { id: "5", barcode: "6191234500059", name: "Eau minérale 1,5 L",      price: 900,  currentStock: 60, isActive: true },
  { id: "6", barcode: "6191234500066", name: "Spaghetti 500 g",         price: 1100, currentStock: 33, isActive: true },
  { id: "7", barcode: "6191234500073", name: "Fromage Kiri x8",         price: 4200, currentStock: 15, isActive: true },
  { id: "8", barcode: "6191234500080", name: "Tomates 1 kg",            price: 1800, currentStock: 20, isActive: true },
];

export default function CashierPOS() {
  const toast     = useToast();
  const [products, setProducts] = useState([]);
  const [query,    setQuery]    = useState("");
  const [cart,     setCart]     = useState(new Map());
  const [selling,  setSelling]  = useState(false);
  const searchRef  = useRef(null);
  // Identifiant de vente généré une fois par panier : une nouvelle
  // tentative après échec réutilise le même id (idempotence serveur).
  const saleIdRef  = useRef(null);

  useEffect(() => {
    // Produits réels via l'API ; repli sur les données de démo sans backend.
    apiFetch("/products")
      .then((d) => setProducts(d.products || []))
      .catch(() => setProducts(DEMO_PRODUCTS));

    searchRef.current?.focus();
  }, []);

  const filtered = products.filter(
    (p) =>
      p.isActive &&
      (p.name.toLowerCase().includes(query.toLowerCase()) ||
        (p.barcode && p.barcode.includes(query)))
  );

  const addToCart = (product) => {
    setCart((prev) => {
      const next = new Map(prev);
      next.set(product.id, { product, qty: (prev.get(product.id)?.qty || 0) + 1 });
      return next;
    });
  };

  const removeFromCart = (id) => {
    setCart((prev) => { const next = new Map(prev); next.delete(id); return next; });
  };

  const changeQty = (id, delta) => {
    setCart((prev) => {
      const next = new Map(prev);
      const item = next.get(id);
      if (!item) return prev;
      const newQty = item.qty + delta;
      if (newQty <= 0) next.delete(id);
      else next.set(id, { ...item, qty: newQty });
      return next;
    });
  };

  const cartTotal = [...cart.values()].reduce(
    (sum, { product, qty }) => sum + product.price * qty, 0
  );

  const handleBarcode = (e) => {
    if (e.key !== "Enter") return;
    const match = products.find((p) => p.barcode === query.trim() && p.isActive);
    if (match) { addToCart(match); setQuery(""); }
    else if (query.trim()) toast("Produit introuvable. Seul le propriétaire peut créer un article.");
  };

  const handleCash = async () => {
    if (!cart.size) { toast("Le panier est vide."); return; }
    if (selling) return;

    if (!saleIdRef.current) saleIdRef.current = crypto.randomUUID();

    setSelling(true);
    try {
      await apiFetch("/sales", {
        method: "POST",
        body: JSON.stringify({
          id: saleIdRef.current,
          lines: [...cart.values()].map(({ product, qty }) => ({
            productId: product.id,
            quantity: qty,
          })),
        }),
      });
      toast("Vente enregistrée en espèces ✓");
      setCart(new Map());
      saleIdRef.current = null;
      setQuery("");
    } catch (err) {
      // Le panier est conservé : une nouvelle tentative réutilise le
      // même identifiant de vente (pas de doublon côté serveur).
      toast(err.message || "Erreur lors de l'enregistrement de la vente.");
    } finally {
      setSelling(false);
    }
  };

  const handleCredit = () => {
    if (!cart.size) { toast("Le panier est vide."); return; }
    toast("Vente à crédit : bientôt disponible.");
  };

  return (
    <AppShell>
      <div className="pos-layout">
        {/* Left: product grid */}
        <div className="panel">
          <label className="sr" htmlFor="search">Produit</label>
          <input
            id="search"
            ref={searchRef}
            className="sg-input"
            type="search"
            placeholder="Scanner un code-barres ou chercher un produit"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleBarcode}
          />
          <div className="product-grid">
            {filtered.length === 0 ? (
              <p className="empty-state" style={{ gridColumn: "1/-1" }}>
                Aucun produit trouvé. Seul le propriétaire peut créer un nouveau code-barres.
              </p>
            ) : (
              filtered.map((p) => (
                <button key={p.id} className="prod-card" type="button" onClick={() => addToCart(p)}>
                  <b>{p.name}</b>
                  <span>{dt(p.price)}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: cart */}
        <div className="panel cart-panel">
          <h2>Panier</h2>

          {cart.size === 0 ? (
            <p className="empty-state">Scannez un produit pour commencer.</p>
          ) : (
            <ul className="cart-list">
              {[...cart.values()].map(({ product, qty }) => (
                <li key={product.id} className="cart-item">
                  <div className="cart-item-info">
                    <span className="cart-item-name">{product.name}</span>
                    <span className="cart-item-sub">{dt(product.price)} / unité</span>
                  </div>
                  <div className="cart-item-controls">
                    <button className="qty-btn" onClick={() => changeQty(product.id, -1)}>−</button>
                    <span className="qty-val">{qty}</span>
                    <button className="qty-btn" onClick={() => changeQty(product.id, +1)}>+</button>
                    <button className="qty-del" onClick={() => removeFromCart(product.id)} aria-label="Supprimer">✕</button>
                  </div>
                  <span className="cart-item-total">{dt(product.price * qty)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="cart-total">
            <span>Total</span>
            <span>{dt(cartTotal)}</span>
          </div>

          <div className="pay-grid">
            <button className="btn-pay" onClick={handleCash} disabled={selling}>
              {selling ? "Enregistrement…" : "Espèces"}
            </button>
            <button className="btn-pay alt" onClick={handleCredit} disabled
              title="Bientôt disponible">
              Crédit (bientôt disponible)
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
