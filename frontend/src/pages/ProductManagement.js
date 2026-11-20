import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";
import { apiFetch } from "../api";


const dt = (m) => (m / 1000).toFixed(3) + " DT";
const toMillimes = (v) => Math.round(parseFloat(v) * 1000);

const EMPTY = { barcode: "", name: "", category: "", price: "", buyPrice: "", initialStock: "" };

export default function ProductManagement() {
  const toast = useToast();
  const [products, setProducts] = useState([]);
  const [form,     setForm]     = useState(EMPTY);
  const [scanning, setScanning] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const load = () =>
    apiFetch("/products?all=true")
      .then((d) => setProducts(d.products || []))
      .catch((err) => toast(err.message || "Erreur de chargement."));

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    load().finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleBarcodeScan = async (e) => {
    if (e.key !== "Enter" || !form.barcode.trim()) return;
    setScanning(true);
    try {
      const d = await apiFetch(`/products/barcode/${encodeURIComponent(form.barcode.trim())}`);
      toast(`Produit existant : ${d.product.name}`);
      setForm({
        barcode: d.product.barcode || "",
        name: d.product.name,
        category: d.product.category || "",
        price: String(d.product.price / 1000),
        buyPrice: d.product.buyPrice != null ? String(d.product.buyPrice / 1000) : "",
        initialStock: "",
      });
    } catch {
      /* nouveau produit — on garde le code-barres saisi */
    } finally {
      setScanning(false);
      setShowForm(true);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        name:         form.name.trim(),
        price:        toMillimes(form.price),
        initialStock: parseFloat(form.initialStock) || 0,
      };
      const barcode = form.barcode.trim();
      if (barcode) payload.barcode = barcode;
      const category = form.category.trim();
      if (category) payload.category = category;
      if (form.buyPrice !== "") payload.buyPrice = toMillimes(form.buyPrice);

      await apiFetch("/products", { method: "POST", body: JSON.stringify(payload) });
      toast("Produit créé avec succès ✓");
      setForm(EMPTY);
      setShowForm(false);
      await load();
    } catch (err) {
      toast(err.message || "Erreur lors de la création.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Produits</h1>
          <button className="btn-primary" style={{ width: "auto", padding: "10px 20px" }}
            onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Annuler" : "+ Ajouter un produit"}
          </button>
        </div>

        {showForm && (
          <div className="panel mb-2">
            <h2 className="section-title">Nouveau produit</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="field">
                  <label className="sg-label" htmlFor="barcode">Code-barres</label>
                  <input id="barcode" className="sg-input code" placeholder="Scanner ou saisir"
                    value={form.barcode}
                    onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                    onKeyDown={handleBarcodeScan}
                    autoFocus />
                  <p className="hint">{scanning ? "Recherche…" : "Appuyez sur Entrée après le scan."}</p>
                </div>
                <div className="field">
                  <label className="sg-label" htmlFor="pname">Nom du produit</label>
                  <input id="pname" className="sg-input" placeholder="Ex. Lait demi-écrémé 1L"
                    value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label className="sg-label" htmlFor="category">Catégorie (facultatif)</label>
                  <input id="category" className="sg-input" placeholder="Ex. Crémerie"
                    value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                </div>
                <div className="field">
                  <label className="sg-label" htmlFor="price">Prix de vente (DT)</label>
                  <input id="price" className="sg-input" type="number" step="0.001" min="0"
                    placeholder="0.000" value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label className="sg-label" htmlFor="buyPrice">Prix d&apos;achat (DT, facultatif)</label>
                  <input id="buyPrice" className="sg-input" type="number" step="0.001" min="0"
                    placeholder="0.000" value={form.buyPrice}
                    onChange={(e) => setForm({ ...form, buyPrice: e.target.value })} />
                </div>
                <div className="field">
                  <label className="sg-label" htmlFor="stock">Stock initial</label>
                  <input id="stock" className="sg-input" type="number" step="0.001" min="0"
                    placeholder="0" value={form.initialStock}
                    onChange={(e) => setForm({ ...form, initialStock: e.target.value })} />
                </div>
              </div>
              <button className="btn-primary" type="submit" disabled={loading} style={{ maxWidth: 220 }}>
                {loading ? "Enregistrement…" : "Créer le produit"}
              </button>
            </form>
          </div>
        )}

        <div className="panel">
          <table className="sg-table">
            <thead>
              <tr>
                <th>Code-barres</th>
                <th>Nom</th>
                <th>Catégorie</th>
                <th>Prix</th>
                <th>Stock</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {listLoading ? (
                <tr><td colSpan={6} className="empty-state">Chargement…</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={6} className="empty-state">Aucun produit enregistré.</td></tr>
              ) : products.map((p) => (
                <tr key={p.id}>
                  <td><code>{p.barcode || "—"}</code></td>
                  <td>{p.name}</td>
                  <td>{p.category || "—"}</td>
                  <td>{dt(p.price)}</td>
                  <td>{p.currentStock}</td>
                  <td><span className={`badge ${p.isActive ? "badge-success" : "badge-muted"}`}>
                    {p.isActive ? "Actif" : "Inactif"}
                  </span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
