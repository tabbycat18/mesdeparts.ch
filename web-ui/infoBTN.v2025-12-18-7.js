// infoBTN.js
// --------------------------------------------------------
// Small help overlay that explains how the board works
// --------------------------------------------------------

import { appState } from "./state.v2025-12-18-7.js";
import { t } from "./i18n.v2025-12-18-7.js";

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
  title.textContent = t("infoTitle");

  const close = document.createElement("button");
  close.className = "info-panel-close";
  close.type = "button";
  close.setAttribute("aria-label", t("infoClose"));
  close.textContent = "×";

  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement("div");
  body.className = "info-panel-body";

  const intro = document.createElement("p");
  intro.textContent = t("infoIntro");

  const story = document.createElement("p");
  story.textContent = t("infoStory");

  const ul = document.createElement("ul");

  const li1 = document.createElement("li");
  li1.textContent = t("infoLi1");

  const li2 = document.createElement("li");
  li2.textContent = t("infoLi2");

  const li3 = document.createElement("li");
  li3.textContent = t("infoLi3");

  const li4 = document.createElement("li");
  li4.textContent = t("infoLi4");

  const li5 = document.createElement("li");
  li5.textContent = t("infoLi5");

  const disclaimerTitle = document.createElement("div");
  disclaimerTitle.className = "info-panel-section-title";
  disclaimerTitle.textContent = t("disclaimerTitle");

  const disclaimer = document.createElement("p");
  disclaimer.textContent = t("disclaimerBody");

  const delaysTitle = document.createElement("div");
  delaysTitle.className = "info-panel-section-title";
  delaysTitle.textContent = t("delaysTitle");

  const delays = document.createElement("p");
  delays.textContent = t("delaysBody");

  const delaysBus = document.createElement("p");
  delaysBus.textContent = t("delaysBus");

  ul.appendChild(li1);
  ul.appendChild(li2);
  ul.appendChild(li3);
  ul.appendChild(li4);
  ul.appendChild(li5);

  const creditsTitle = document.createElement("div");
  creditsTitle.className = "info-panel-section-title";
  creditsTitle.textContent = t("creditsTitle");

  const creditsList = document.createElement("ul");

  const creditData = document.createElement("li");
  creditData.textContent = t("creditsData");

  const creditClock = document.createElement("li");
  creditClock.textContent = t("creditsClock");

  const creditClockNote = document.createElement("li");
  creditClockNote.textContent = t("creditsClockNote");

  const creditColors = document.createElement("li");
  creditColors.textContent = t("lineColorsNotice");

  const creditAuthor = document.createElement("li");
  creditAuthor.textContent = t("creditsAuthor");

  creditsList.appendChild(creditData);
  creditsList.appendChild(creditClock);
  creditsList.appendChild(creditClockNote);
  creditsList.appendChild(creditColors);
  creditsList.appendChild(creditAuthor);

  body.appendChild(intro);
  body.appendChild(story);
  body.appendChild(ul);
  body.appendChild(disclaimerTitle);
  body.appendChild(disclaimer);
  body.appendChild(delaysTitle);
  body.appendChild(delays);
  body.appendChild(delaysBus);
  body.appendChild(creditsTitle);
  body.appendChild(creditsList);

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

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    overlay = buildInfoOverlay();
    document.body.appendChild(overlay);
    return overlay;
  }

  btn.addEventListener("click", () => {
    const overlayEl = ensureOverlay();
    // Keep title slightly contextual
    const title = overlayEl.querySelector(".info-panel-title");
    if (title) {
      const station = appState.STATION || "Station";
      title.textContent = `${t("infoTitle")} – ${station}`;
    }
    overlayEl.classList.add("is-visible");
  });
}
