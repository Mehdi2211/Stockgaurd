import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";


const dt = (m) => (m / 1000).toFixed(3) + " DT";

const EMPTY = { barcode: "", name: "", price: "", initialStock: "" };

export default function ProductManagement() {
  const toast = useToast();
  const [products, setProducts] = useState([]);
  const [form,     setForm]     = useState(EMPTY);
  const [scanning, setScanning] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = () =>
    fetch("/api/products?all=true")
      .then((r) => r.json())
      .then((d) => setProducts(d.products || []))
      .catch(() => toast("Erreur de chargement."));

  useEffect(() => { load(); }, []);

  const handleBarcodeScan = async (e) => {
    if (e.key !== "Enter" || !form.barcode.trim()) return;
    setScanning(true);
    try {
      const r = await fetch(`/api/products/barcode/${encodeURIComponent(form.barcode.trim())}`);
      if (r.ok) {
        const d = await r.json();
        toast(`Produit existant : ${d.name}`);
        setForm({ barcode: d.barcode, name: d.name, price: String(d.price / 1000), initialStock: "" });
      }
    } catch { /* new product – keep form empty */ }
    finally { setScanning(false); setShowForm(true); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        barcode:      form.barcode.trim(),
        name:         form.name.trim(),
        price:        Math.round(parseFloat(form.price) * 1000),
        initialStock: parseFloat(form.initialStock) || 0,
      };
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      toast("Produit créé avec succès ✓");
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (err) {
      toast(err.message || "Erreur lors de la création.");
    } finally { setLoading(false); }
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
                  <label className="sg-label" htmlFor="price">Prix (DT)</label>
                  <input id="price" className="sg-input" type="number" step="0.001" min="0"
                    placeholder="0.000" value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })} required />
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
                <th>Prix</th>
                <th>Stock</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr><td colSpan={5} className="empty-state">Aucun produit enregistré.</td></tr>
              ) : products.map((p) => (
                <tr key={p.id}>
                  <td><code>{p.barcode}</code></td>
                  <td>{p.name}</td>
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
