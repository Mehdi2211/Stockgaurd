import React from "react";
import { useNavigate } from "react-router-dom";

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 16,
      background: "var(--bg)", color: "var(--ink)", textAlign: "center", padding: 24
    }}>
      <span style={{ fontSize: "4rem" }}>🔍</span>
      <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0 }}>Page introuvable</h1>
      <p style={{ color: "var(--muted)" }}>Cette page n&apos;existe pas ou vous n&apos;avez pas accès.</p>
      <button className="btn-primary" style={{ maxWidth: 200 }} onClick={() => navigate("/")}>
        Retour à l&apos;accueil
      </button>
    </div>
  );
}
