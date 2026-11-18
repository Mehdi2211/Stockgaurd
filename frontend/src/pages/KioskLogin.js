import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useKiosk } from "../context/KioskContext";


const KIOSK_CODE = "HK2211";
const normalise  = (val) => val.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

export default function KioskLogin() {
  const { login } = useKiosk();
  const navigate  = useNavigate();

  const [code,    setCode]    = useState("");
  const [name,    setName]    = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    const trimmedCode = normalise(code);
    const trimmedName = name.trim();

    if (trimmedCode.length !== 6) { setError("Le code doit contenir exactement 6 caractères."); return; }
    if (!trimmedName)              { setError("Veuillez entrer le nom de la boutique."); return; }

    setLoading(true);
    await new Promise((r) => setTimeout(r, 350));

    if (trimmedCode !== KIOSK_CODE) {
      setError("Code incorrect.");
      setLoading(false);
      return;
    }

    // Always log in as CASHIER — owner elevation happens inside the app
    login({ id: "demo-shop", name: trimmedName });
    setLoading(false);
    navigate("/caisse");
  };

  return (
    <section className="login">
      <div className="login-side">
        <div>
          <h1>StockGuard</h1>
          <p>Voyez où le stock et l&apos;argent disparaissent, preuves à l&apos;appui.</p>
        </div>
        <p className="login-side-foot">Système de caisse et gestion de stock</p>
      </div>

      <form className="login-form" onSubmit={handleSubmit} autoComplete="off">
        <h2>Ouvrir la caisse</h2>

        {error && <p className="error-msg" role="alert">{error}</p>}

        <div className="field">
          <label className="sg-label" htmlFor="code">
            Code de la caisse
            {code.length > 0 && (
              <span className={`code-counter ${code.length === 6 ? "ok" : ""}`}>{code.length}/6</span>
            )}
          </label>
          <div className="input-row">
            <input id="code" className="sg-input code"
              type={showPwd ? "text" : "password"}
              placeholder="A1B2C3" autoCapitalize="characters"
              spellCheck="false" maxLength={6} required autoFocus
              value={code}
              onChange={(e) => { setCode(normalise(e.target.value)); setError(""); }}
            />
            <button type="button" className="btn-ghost" onClick={() => setShowPwd((v) => !v)}>
              {showPwd ? "Masquer" : "Afficher"}
            </button>
          </div>
          <p className="hint">Le code vous a été remis par votre fournisseur.</p>
        </div>

        <div className="field">
          <label className="sg-label" htmlFor="shopName">Nom de la boutique</label>
          <input id="shopName" className="sg-input" type="text"
            placeholder="Épicerie El Amel" maxLength={60} required
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <button className="btn-primary" type="submit" disabled={loading || code.length !== 6}>
          {loading ? "Connexion…" : "Ouvrir"}
        </button>

        <div className="demo-block">
          <p>Mode démo — code de test : <code>{KIOSK_CODE}</code></p>
        </div>
      </form>
    </section>
  );
}
