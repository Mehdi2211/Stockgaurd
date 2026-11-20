import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useKiosk } from "../context/KioskContext";
import { apiFetch } from "../api";


// Code boutique : 6 à 12 caractères A-Z / 0-9 (contrat serveur).
const normaliseCode = (val) => val.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
const CODE_RE = /^[A-Z0-9]{6,12}$/;
const PIN_RE = /^[0-9]{4,8}$/;

export default function KioskLogin() {
  const { login } = useKiosk();
  const navigate  = useNavigate();

  const [mode,    setMode]    = useState("CASHIER"); // "CASHIER" | "OWNER"
  const [code,    setCode]    = useState("");
  const [pin,     setPin]     = useState("");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const isCashier = mode === "CASHIER";

  const switchMode = (next) => {
    setMode(next);
    setPin("");
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    const shopCode = normaliseCode(code);
    if (!CODE_RE.test(shopCode)) {
      setError("Le code boutique doit contenir 6 à 12 caractères (A-Z, 0-9).");
      return;
    }
    if (!PIN_RE.test(pin.trim())) {
      setError(isCashier ? "Le PIN doit contenir 4 à 8 chiffres."
                         : "Le PIN d'administration doit contenir 4 à 8 chiffres.");
      return;
    }

    setLoading(true);
    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ code: shopCode, pin: pin.trim(), role: mode }),
        authRedirect: false, // un échec de login ne doit pas recharger la page
      });
      login({ token: data.token, user: data.user, shop: data.shop });
      navigate(data.user.role === "OWNER" ? "/owner" : "/caisse");
    } catch (err) {
      setError(err.message || "Connexion impossible.");
      setLoading(false);
    }
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

        <div className="mode-toggle" role="tablist">
          <button type="button" role="tab" aria-selected={isCashier}
            className={isCashier ? "active" : ""} onClick={() => switchMode("CASHIER")}>
            Caissier
          </button>
          <button type="button" role="tab" aria-selected={!isCashier}
            className={!isCashier ? "active" : ""} onClick={() => switchMode("OWNER")}>
            Propriétaire
          </button>
        </div>

        {error && <p className="error-msg" role="alert">{error}</p>}

        <div className="field">
          <label className="sg-label" htmlFor="code">
            Code de la boutique
            {code.length > 0 && (
              <span className={`code-counter ${CODE_RE.test(code) ? "ok" : ""}`}>{code.length}/12</span>
            )}
          </label>
          <input id="code" className="sg-input code"
            type="text" placeholder="SGDEMO01" autoCapitalize="characters"
            spellCheck="false" maxLength={12} required autoFocus
            value={code}
            onChange={(e) => { setCode(normaliseCode(e.target.value)); setError(""); }}
          />
          <p className="hint">Le code vous a été remis par votre fournisseur.</p>
        </div>

        <div className="field">
          <label className="sg-label" htmlFor="pin">
            {isCashier ? "PIN du caissier" : "PIN d'administration"}
          </label>
          <input id="pin" className="sg-input code" type="password"
            inputMode="numeric" placeholder="••••" maxLength={8} required
            value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }} />
        </div>

        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? "Connexion…" : "Ouvrir"}
        </button>
      </form>
    </section>
  );
}
