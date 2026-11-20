import React, { useRef, useState } from "react";
import { useScan } from "../hooks/useScan";

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString("fr-TN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Zone de scan : champ de saisie autofocus (un lecteur USB se comporte
// comme un clavier — Entrée valide le scan), bouton caméra désactivé
// (« Bientôt disponible ») et liste des derniers produits scannés.
// `onProductMatched(product)` est appelé quand le code correspond à un
// produit connu de la boutique.
export default function ScanPanel({ onProductMatched }) {
  const { recent, error, onBarcodeDetected } = useScan();
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const submit = async () => {
    const code = value.trim();
    if (code === "") return;
    setValue("");
    const data = await onBarcodeDetected(code);
    if (data?.product && onProductMatched) onProductMatched(data.product);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };

  return (
    <div className="scan-panel">
      <h2 className="scan-title">Scanner un produit</h2>

      <label className="sr" htmlFor="scan-input">Code-barres</label>
      <input
        id="scan-input"
        ref={inputRef}
        className="sg-input"
        type="text"
        placeholder="Scannez un code-barres…"
        autoComplete="off"
        spellCheck="false"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="scan-actions">
        <button type="button" className="btn-ghost" disabled title="Bientôt disponible">
          📷 Scanner avec la caméra — Bientôt disponible
        </button>
      </div>

      {error && <p className="error-msg" role="alert">{error}</p>}

      <ul className="scan-list">
        {recent.length === 0 ? (
          <li className="empty-state">Aucun produit scanné pour le moment.</li>
        ) : (
          recent.map((s) => (
            <li key={s.key} className={`scan-item ${s.status}`}>
              <span className="scan-name">{s.product ? s.product.name : "Code inconnu"}</span>
              <span className="scan-meta">
                <code>{s.barcode}</code> · qté {s.quantity} · {fmtTime(s.at)}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
