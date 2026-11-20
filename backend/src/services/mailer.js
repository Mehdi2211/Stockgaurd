// =====================================================================
// Envoi d'emails (nodemailer) — configuration SMTP via variables
// d'environnement. AUCUN secret en dur.
//
// Si le SMTP n'est pas configuré, l'application fonctionne quand même :
// isConfigured() renvoie false et l'appelant journalise l'info (les
// notifications restent en attente dans l'outbox).
// =====================================================================

const nodemailer = require("nodemailer");

let transporter = null;

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return {
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // TLS implicite sur 465
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  };
}

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function mailFrom() {
  return process.env.MAIL_FROM;
}

function getTransporter() {
  if (!isConfigured()) throw new Error("SMTP non configuré (SMTP_HOST / MAIL_FROM).");
  if (!transporter) transporter = nodemailer.createTransport(smtpConfig());
  return transporter;
}

// Vérifie la connexion SMTP (utilisé par scripts/test-smtp.js).
async function verify() {
  const t = getTransporter();
  return t.verify();
}

async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  return t.sendMail({ from: mailFrom(), to, subject, html, text });
}

// Échappe toute valeur insérée dans le HTML de l'email (anti-injection).
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { isConfigured, verify, sendMail, escapeHtml, mailFrom };
