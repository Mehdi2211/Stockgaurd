import React, { useState, useEffect, useRef } from "react";
import { useKiosk } from "../context/KioskContext";
import { useNavigate } from "react-router-dom";


// Demo admin PIN — 4 digits
const ADMIN_PIN = "1234";

export default function AdminPinModal({ onClose }) {
  const { elevate }  = useKiosk();
  const navigate     = useNavigate();
  const [pin,  setPin]  = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (pin !== ADMIN_PIN) {
      setError("PIN incorrect.");
      setPin("");
      inputRef.current?.focus();
      return;
    }
    elevate();
    onClose();
    navigate("/owner");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Accès Administration</h2>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>

        <p className="modal-hint">Entrez le PIN du propriétaire pour accéder au tableau de bord.</p>

        <form onSubmit={handleSubmit} autoComplete="off">
          {error && <p className="error-msg" role="alert">{error}</p>}

          <div className="field">
            <label className="sg-label" htmlFor="adminPin">PIN propriétaire</label>
            <input
              id="adminPin"
              ref={inputRef}
              className="sg-input code"
              type="password"
              inputMode="numeric"
              placeholder="••••"
              maxLength={6}
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(""); }}
              required
            />
            <p className="hint">Mode démo — PIN : <code>1234</code></p>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn-primary" style={{ flex: 1 }}>
              Accéder
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
