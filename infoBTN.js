// infoBTN.js
// --------------------------------------------------------
// Small help overlay that explains how the board works
// --------------------------------------------------------

import { appState } from "./state.js";

function buildInfoOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "info-overlay";
  overlay.id = "info-overlay";

  const panel = document.createElement("div");
  panel.className = "info-panel";

  const header = document.createElement("div");
  header.className = "info-panel-header";

  const title = document.createElement("div");
  title.className = "info-panel-title";
  title.textContent = "Infos";

  const close = document.createElement("button");
  close.className = "info-panel-close";
  close.type = "button";
  close.setAttribute("aria-label", "Fermer");
  close.textContent = "×";

  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement("div");
  body.className = "info-panel-body";

  const p = document.createElement("p");
  p.textContent =
    "Cette page affiche les prochains départs. Selon le type d’arrêt (gare vs arrêt de bus), certaines colonnes changent.";

  const ul = document.createElement("ul");

  const li1 = document.createElement("li");
  li1.textContent = "“Départ” = l’heure officielle (horaire planifié).";

  const li2 = document.createElement("li");
  li2.textContent =
    "“min” = compte à rebours basé sur le temps réel quand disponible (bus/tram/métro).";

  const li3 = document.createElement("li");
  li3.textContent =
    "Retard: affiché dès 2 min pour bus/tram/métro, dès 1 min pour les trains.";

  const li4 = document.createElement("li");
  li4.textContent =
    "En avance (bus/tram/métro): peut apparaître en “−X min” si la source fournit un temps réel plus tôt.";

  const li5 = document.createElement("li");
  li5.textContent =
    "Vue: bouton “Vue” pour basculer entre Heure et Lignes. À “Motte”, une vue “Descendre” (centre-ville) est aussi disponible.";

  ul.appendChild(li1);
  ul.appendChild(li2);
  ul.appendChild(li3);
  ul.appendChild(li4);
  ul.appendChild(li5);

  body.appendChild(p);
  body.appendChild(ul);

  panel.appendChild(header);
  panel.appendChild(body);

  overlay.appendChild(panel);

  function hide() {
    overlay.classList.remove("is-visible");
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hide();
  });

  close.addEventListener("click", hide);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  return overlay;
}

export function setupInfoButton() {
  const btn = document.getElementById("info-btn");
  if (!btn) return;

  let overlay = document.getElementById("info-overlay");
  if (!overlay) {
    overlay = buildInfoOverlay();
    document.body.appendChild(overlay);
  }

  btn.addEventListener("click", () => {
    // Keep title slightly contextual
    const title = overlay.querySelector(".info-panel-title");
    if (title) {
      const station = appState.STATION || "Station";
      title.textContent = `Infos – ${station}`;
    }
    overlay.classList.add("is-visible");
  });
}
