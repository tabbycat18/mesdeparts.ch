// i18n.js
// --------------------------------------------------------
// Minimal translations for selected UI strings (fr, de, it, en)
// --------------------------------------------------------

const SUPPORTED = ["fr", "de", "it", "en"];
const LANG_STORAGE_KEY = "mesdeparts.lang";

export const LANGUAGE_OPTIONS = [
  { code: "fr", label: "FR" },
  { code: "de", label: "DE" },
  { code: "it", label: "IT" },
  { code: "en", label: "EN" },
];

const TRANSLATIONS = {
  nextDepartures: {
    fr: "Vos prochains départs",
    de: "Ihre nächsten Abfahrten",
    it: "Prossime partenze",
    en: "Upcoming departures",
  },
  searchStop: {
    fr: "Recherche d'arrêt",
    de: "Haltestelle suchen",
    it: "Ricerca fermata",
    en: "Search stop",
  },
  servedByLines: {
    fr: "Desservi par les lignes :",
    de: "Bedient von den Linien:",
    it: "Servito dalle linee:",
    en: "Served by lines:",
  },
  columnLine: {
    fr: "Ligne",
    de: "Linie",
    it: "Linea",
    en: "Line",
  },
  columnDestination: {
    fr: "Destination",
    de: "Ziel",
    it: "Destinazione",
    en: "Destination",
  },
  columnDeparture: {
    fr: "Départ",
    de: "Abfahrt",
    it: "Partenza",
    en: "Departure",
  },
  columnPlatformTrain: {
    fr: "Voie",
    de: "Gleis",
    it: "Binario",
    en: "Track",
  },
  columnPlatformBus: {
    fr: "Quai",
    de: "Kante",
    it: "Banchina",
    en: "Pl.",
  },
  columnMinutes: {
    fr: "min",
    de: "Min",
    it: "min",
    en: "min",
  },
  columnRemark: {
    fr: "Remarque",
    de: "Hinweis",
    it: "Nota",
    en: "Info",
  },
  filterButton: {
    fr: "Filtres",
    de: "Filter",
    it: "Filtri",
    en: "Filters",
  },
  filterReset: {
    fr: "Réinitialiser",
    de: "Zurücksetzen",
    it: "Reimposta",
    en: "Reset",
  },
  filterApply: {
    fr: "Appliquer",
    de: "Anwenden",
    it: "Applica",
    en: "Apply",
  },
  filterPlatforms: {
    fr: "Quai",
    de: "Gleis",
    it: "Banchina",
    en: "Platform",
  },
  filterLines: {
    fr: "Lignes",
    de: "Linien",
    it: "Linee",
    en: "Lines",
  },
  filterAll: {
    fr: "Tous",
    de: "Alle",
    it: "Tutti",
    en: "All",
  },
  filterFavoritesTitle: {
    fr: "Mes favoris",
    de: "Meine Favoriten",
    it: "I miei preferiti",
    en: "My favorites",
  },
  filterFavoritesLabel: {
    fr: "Mes favoris",
    de: "Favoriten",
    it: "Preferiti",
    en: "Favorites",
  },
  filterFavoritesOnly: {
    fr: "Afficher seulement mes favoris",
    de: "Nur meine Favoriten anzeigen",
    it: "Mostra solo i miei preferiti",
    en: "Show only my favorites",
  },
  filterFavoritesOnlyShort: {
    fr: "Mes favoris",
    de: "Favoriten",
    it: "Preferiti",
    en: "Favorites",
  },
  filterManageFavorites: {
    fr: "Gérer mes favoris",
    de: "Favoriten verwalten",
    it: "Gestisci i preferiti",
    en: "Manage favorites",
  },
  favoritesManageDone: {
    fr: "Terminer",
    de: "Fertig",
    it: "Fine",
    en: "Done",
  },
  favoritesDelete: {
    fr: "Supprimer",
    de: "Löschen",
    it: "Elimina",
    en: "Delete",
  },
  favoritesDeleteConfirm: {
    fr: "Supprimer les favoris sélectionnés ?",
    de: "Ausgewählte Favoriten löschen?",
    it: "Eliminare i preferiti selezionati?",
    en: "Delete selected favorites?",
  },
  filterNoFavorites: {
    fr: "Aucun favori pour l'instant",
    de: "Noch keine Favoriten",
    it: "Nessun preferito per ora",
    en: "No favorites yet",
  },
  filterNoPlatforms: {
    fr: "Aucun quai disponible",
    de: "Keine verfügbaren Bahnsteige",
    it: "Nessuna banchina disponibile",
    en: "No platform available",
  },
  filterNoLines: {
    fr: "Aucune ligne disponible",
    de: "Keine Linien verfügbar",
    it: "Nessuna linea disponibile",
    en: "No line available",
  },
  favoritesClearConfirm: {
    fr: "Supprimer tous les favoris ?",
    de: "Alle Favoriten löschen?",
    it: "Eliminare tutti i preferiti?",
    en: "Remove all favorites?",
  },
  favoritesManageHint: {
    fr: "Saisissez les favoris à enlever (nom ou id), séparés par virgule/retour.",
    de: "Geben Sie die zu entfernenden Favoriten ein (Name oder ID), getrennt durch Komma/Zeilenumbruch.",
    it: "Inserisca i preferiti da rimuovere (nome o id), separati da virgola/a capo.",
    en: "Enter favorites to remove (name or id), separated by comma/newline.",
  },
  viewOptionTime: {
    fr: "Par min",
    de: "Pro Min",
    it: "Per min",
    en: "By min",
  },
  viewOptionLine: {
    fr: "Par ligne",
    de: "Nach Linie",
    it: "Per linea",
    en: "By line",
  },
  viewSectionLabel: {
    fr: "Affichage",
    de: "Anzeige",
    it: "Visualizzazione",
    en: "Display",
  },
  viewLabelFallback: {
    fr: "Vue",
    de: "Ansicht",
    it: "Vista",
    en: "View",
  },
  languageLabel: {
    fr: "Langue",
    de: "Sprache",
    it: "Lingua",
    en: "Language",
  },
  boardModeLabel: {
    fr: "Tableau",
    de: "Board",
    it: "Tabellone",
    en: "Board",
  },
  boardModeStateOn: {
    fr: "ON",
    de: "ON",
    it: "ON",
    en: "ON",
  },
  boardModeStateOff: {
    fr: "OFF",
    de: "OFF",
    it: "OFF",
    en: "OFF",
  },
  boardModeTitle: {
    fr: "Tableau",
    de: "Board",
    it: "Tabellone",
    en: "Board",
  },
  boardModeDesc1: {
    fr: "Le mode tableau passe par Cloudflare et met en cache les réponses pour éviter de surcharger les serveurs publics. Idéal quand l’écran reste ouvert.",
    de: "Der Board-Modus nutzt Cloudflare-Cache, um die öffentlichen Server nicht zu überlasten. Ideal, wenn der Bildschirm dauerhaft läuft.",
    it: "La modalità tabellone usa la cache Cloudflare per evitare di sovraccaricare i server pubblici. Ideale quando lo schermo resta aperto.",
    en: "Board mode uses Cloudflare cache to avoid overloading the public API servers. Best when the screen stays open.",
  },
  boardModeDesc2: {
    fr: "Le mode normal appelle transport.opendata.ch directement, pratique pour des consultations ponctuelles.",
    de: "Der Normalmodus ruft transport.opendata.ch direkt auf, praktisch für gelegentliche Abfragen.",
    it: "La modalità normale chiama transport.opendata.ch direttamente, utile per controlli occasionali.",
    en: "Normal mode calls transport.opendata.ch directly, good for occasional checks.",
  },
  boardModeOk: {
    fr: "OK",
    de: "OK",
    it: "OK",
    en: "OK",
  },
  infoTitle: {
    fr: "Infos",
    de: "Infos",
    it: "Info",
    en: "Info",
  },
  infoClose: {
    fr: "Fermer",
    de: "Schließen",
    it: "Chiudi",
    en: "Close",
  },
  infoIntro: {
    fr: "mesdeparts.ch affiche les prochains départs en Suisse. Les noms avec virgule désignent un arrêt (bus/tram), ceux sans virgule une gare (train). Actualisation automatique toutes les 10-20 s selon le mode (~3 h d’horizon).",
    de: "mesdeparts.ch zeigt die nächsten Abfahrten in der Schweiz. Namen mit Komma stehen für eine Haltestelle (Bus/Tram), ohne Komma für einen Bahnhof (Zug). Automatische Aktualisierung alle 10-20 s je nach Modus (~3 h Horizont).",
    it: "mesdeparts.ch mostra le prossime partenze in Svizzera. I nomi con virgola indicano una fermata (bus/tram), senza virgola una stazione (treno). Aggiornamento automatico ogni 10-20 s a seconda della modalità (~3 h di orizzonte).",
    en: "mesdeparts.ch shows upcoming departures in Switzerland. Names with a comma are stops (bus/tram); names without a comma are stations (train). Auto-refresh runs every 10-20 s depending on mode (~3 h horizon).",
  },
  infoStory: {
    fr: "Né de l’envie d’avoir un tableau des départs chez soi, utilisable partout en Suisse (pas seulement dans les grandes gares). Inspiré par des discussions en ligne (horloge CFF, Reddit, forums), c’est devenu une alternative personnelle, gratuite et open source dans le navigateur.",
    de: "Entstanden aus dem Wunsch nach einer Abfahrtsanzeige zu Hause, nutzbar an jedem Schweizer Halt (nicht nur an grossen Bahnhöfen). Inspiriert von Online-Diskussionen (SBB-Uhr, Reddit, Foren) wurde daraus eine persönliche, kostenlose und Open-Source-Alternative im Browser.",
    it: "Nato dal desiderio di avere una tabella partenze a casa, utilizzabile in ogni fermata svizzera (non solo nelle grandi stazioni). Ispirato da discussioni online (orologio FFS, Reddit, forum), è diventato un’alternativa personale, gratuita e open source nel browser.",
    en: "Born from wanting a home departure board usable at any Swiss stop (not just big stations). Inspired by online discussions (SBB clock, Reddit, forums), it became a personal, free, open-source browser alternative.",
  },
  infoLi1: {
    fr: "Recherche : saisissez un arrêt ou choisissez un favori (étoile). Les suggestions apparaissent dès 2 lettres.",
    de: "Suche: Haltestelle eingeben oder einen Favoriten (Stern) wählen. Vorschläge erscheinen ab 2 Buchstaben.",
    it: "Ricerca: inserisca una fermata o scelga un preferito (stella). I suggerimenti appaiono da 2 lettere.",
    en: "Search: type a stop or pick a favorite (star). Suggestions appear after 2 letters.",
  },
  infoLi2: {
    fr: "Vues : “Par ligne” regroupe par ligne et destination ; “Par min” liste tout chronologiquement. Les trains restent chronologiques.",
    de: "Ansichten: „Nach Linie“ gruppiert nach Linie/Ziel; „Pro Min“ zeigt alles chronologisch. Züge bleiben chronologisch.",
    it: "Viste: “Per linea” raggruppa per linea e destinazione; “Per min” elenca in ordine cronologico. I treni restano cronologici.",
    en: "Views: “By line” groups by line/destination; “By min” lists chronologically. Trains stay chronological.",
  },
  infoLi3: {
    fr: "Filtres : bouton “Filtres” → pastilles Quai/Lignes. Le compteur indique les filtres actifs ; “Réinitialiser” efface tout.",
    de: "Filter: Schaltfläche „Filter“ → Chips für Kante/Linien. Der Zähler zeigt aktive Filter; „Zurücksetzen“ löscht alles.",
    it: "Filtri: pulsante “Filtri” → chip Banchina/Linee. Il contatore mostra i filtri attivi; “Reimposta” li cancella.",
    en: "Filters: “Filters” button → Platform/Lines chips. The counter shows active filters; “Reset” clears them.",
  },
  infoLi4: {
    fr: "Mes favoris : stockés localement sur cet appareil (sans compte). Le bouton étoile ajoute/retire un arrêt ; “Mes favoris” peut afficher uniquement vos arrêts.",
    de: "Meine Favoriten: lokal auf diesem Gerät gespeichert (ohne Konto). Der Stern fügt eine Haltestelle hinzu/entfernt sie; „Meine Favoriten“ zeigt nur diese Haltestellen.",
    it: "I miei preferiti: salvati localmente su questo dispositivo (senza account). La stella aggiunge/rimuove una fermata; “I miei preferiti” può mostrare solo quelle fermate.",
    en: "My favorites: stored locally on this device (no account). The star adds/removes a stop; “My favorites” can show only those stops.",
  },
  infoLi5: {
    fr: "Retards : bus/tram dès +2 min, trains dès +1 min. “Départ” est toujours l’horaire officiel ; “min” est un compte à rebours temps réel qui peut inclure de petits décalages non signalés comme retards officiels.",
    de: "Verspätungen: Bus/Tram ab +2 Min, Züge ab +1 Min. „Abfahrt“ zeigt immer den Fahrplan; „min“ ist der Echtzeit-Countdown und kann kleine Abweichungen enthalten, die nicht als offizielle Verspätung gelten.",
    it: "Ritardi: bus/tram da +2 min, treni da +1 min. “Partenza” è sempre l’orario ufficiale; “min” è il conto alla rovescia in tempo reale che può includere piccoli scostamenti non segnalati come ritardi ufficiali.",
    en: "Delays: bus/tram from +2 min, trains from +1 min. “Departure” is always the official timetable; “min” is a realtime countdown that may include small shifts not flagged as official delays.",
  },
  disclaimerTitle: {
    fr: "Disclaimer",
    de: "Disclaimer",
    it: "Disclaimer",
    en: "Disclaimer",
  },
  disclaimerBody: {
    fr: "Les données proviennent de transport.opendata.ch et peuvent être incomplètes ou différer de l’affichage officiel. En cas de doute, veuillez vérifier auprès de l’opérateur ou sur place.",
    de: "Die Daten stammen von transport.opendata.ch und können unvollständig sein oder vom offiziellen Aushang abweichen. Im Zweifel bitte beim Betreiber oder vor Ort prüfen.",
    it: "I dati provengono da transport.opendata.ch e possono essere incompleti o differire dalle indicazioni ufficiali. In caso di dubbio verifica presso l’operatore o in loco.",
    en: "Data comes from transport.opendata.ch and may be incomplete or differ from official displays. If in doubt, check with the operator or on site.",
  },
  delaysTitle: {
    fr: "Retards et données en temps réel",
    de: "Verspätungen und Echtzeitdaten",
    it: "Ritardi e dati in tempo reale",
    en: "Delays and realtime data",
  },
  delaysBody: {
    fr: "En Suisse, un retard est considéré comme officiel à partir de 3 minutes. Les écarts de 1 à 2 minutes peuvent apparaître dans l’horaire en temps réel, mais ne sont pas signalés comme des retards officiels.",
    de: "In der Schweiz gilt eine Verspätung ab 3 Minuten als offiziell. Abweichungen von 1 bis 2 Minuten können in der Echtzeit-Anzeige erscheinen, werden aber nicht als offizielle Verspätung markiert.",
    it: "In Svizzera un ritardo è considerato ufficiale a partire da 3 minuti. Scostamenti di 1–2 minuti possono comparire nell’orario in tempo reale, ma non sono segnalati come ritardi ufficiali.",
    en: "In Switzerland a delay is official from 3 minutes. Deviations of 1–2 minutes may appear in realtime schedules but are not marked as official delays.",
  },
  delaysBus: {
    fr: "Pour les bus et trams, de légers écarts sont fréquents et reflètent l’adaptation du trafic en temps réel.",
    de: "Bei Bussen und Trams sind leichte Abweichungen häufig und spiegeln die Anpassung des Verkehrs in Echtzeit wider.",
    it: "Per bus e tram sono frequenti piccole variazioni che riflettono l’adattamento del traffico in tempo reale.",
    en: "For buses and trams, small shifts are common and reflect realtime traffic adjustments.",
  },
  platformChange: {
    fr: "Changement de voie",
    de: "Gleiswechsel",
    it: "Cambio binario",
    en: "Platform change",
  },
  remarkCancelled: {
    fr: "Supprimé",
    de: "Ausfall",
    it: "Soppresso",
    en: "Cancelled",
  },
  remarkDelayShort: {
    fr: "Retard",
    de: "Verspätung",
    it: "Ritardo",
    en: "Delay",
  },
  remarkDelayTrainApprox: {
    fr: "Retard env. {min} min",
    de: "ca. {min} Min später",
    it: "Ritardo ca. {min} min",
    en: "Delay approx. {min} min",
  },
  creditsTitle: {
    fr: "Crédits & licences",
    de: "Credits & Lizenzen",
    it: "Crediti e licenze",
    en: "Credits & licenses",
  },
  creditsData: {
    fr: "Données : transport.opendata.ch",
    de: "Daten: transport.opendata.ch",
    it: "Dati: transport.opendata.ch",
    en: "Data: transport.opendata.ch",
  },
  creditsAuthor: {
    fr: "© 2024 Mattia Pastore – mesdeparts.ch — Licence Apache 2.0.",
    de: "© 2024 Mattia Pastore – mesdeparts.ch — Apache-Lizenz 2.0.",
    it: "© 2024 Mattia Pastore – mesdeparts.ch — Licenza Apache 2.0.",
    en: "© 2024 Mattia Pastore – mesdeparts.ch — Apache License 2.0.",
  },
  creditsClock: {
    fr: "Horloge : sbbUhr — © GoetteSebastian — Apache License 2.0",
    de: "Uhr: sbbUhr — © GoetteSebastian — Apache License 2.0",
    it: "Orologio: sbbUhr — © GoetteSebastian — Apache License 2.0",
    en: "Clock: sbbUhr — © GoetteSebastian — Apache License 2.0",
  },
  creditsClockNote: {
    fr: "Adaptation et intégration pour mesdeparts.ch. Aucune affiliation ni approbation officielle CFF/SBB.",
    de: "Anpassung und Integration für mesdeparts.ch. Keine offizielle Partnerschaft oder Genehmigung durch SBB/CFF.",
    it: "Adattamento e integrazione per mesdeparts.ch. Nessuna affiliazione o approvazione ufficiale CFF/SBB.",
    en: "Adaptation and integration for mesdeparts.ch. No official affiliation or approval by CFF/SBB.",
  },
  lineColorsNotice: {
    fr: "Les couleurs des lignes sont utilisées à des fins d’identification visuelle, selon les chartes publiques des exploitants.",
    de: "Die Linienfarben dienen der visuellen Identifikation gemäß den öffentlich zugänglichen Farbwelten der Betreiber.",
    it: "I colori delle linee sono usati solo per identificazione visiva, secondo le palette pubbliche degli operatori.",
    en: "Line colors are used for visual identification only, following operators’ public palettes.",
  },
  serviceEndedToday: {
    fr: "Fin de service pour cet arrêt aujourd'hui",
    de: "Betrieb für diese Haltestelle heute beendet",
    it: "Fine del servizio per questa fermata oggi",
    en: "Service ended for this stop today",
  },
  loadingDepartures: {
    fr: "Actualisation…",
    de: "Wird aktualisiert…",
    it: "Aggiornamento…",
    en: "Refreshing…",
  },
};

let currentLang = "fr";

function normalizeLang(val) {
  if (!val) return null;
  return String(val).trim().slice(0, 2).toLowerCase();
}

function isMobileViewport() {
  try {
    return window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
  } catch (_) {
    return false;
  }
}

function readStoredLanguage() {
  try {
    const raw = localStorage.getItem(LANG_STORAGE_KEY);
    const norm = normalizeLang(raw);
    if (norm && SUPPORTED.includes(norm)) return norm;
  } catch (_) {
    // ignore
  }
  return null;
}

function detectLanguage() {
  // URL override (?lang=de|it|fr) takes priority
  try {
    const params = new URLSearchParams(window.location.search || "");
    const urlLang = normalizeLang(params.get("lang"));
    if (urlLang && SUPPORTED.includes(urlLang)) return urlLang;
  } catch (_) {
    // ignore
  }

  const stored = readStoredLanguage();
  if (stored) return stored;

  try {
    const navCandidates = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
    for (const lng of navCandidates) {
      const norm = normalizeLang(lng);
      if (norm && SUPPORTED.includes(norm)) return norm;
    }
  } catch (_) {
    // ignore
  }

  return "fr";
}

export function initI18n() {
  currentLang = detectLanguage();
  try {
    document.documentElement.lang = currentLang;
  } catch (_) {
    // ignore
  }
  return currentLang;
}

export function setLanguage(lang) {
  const norm = normalizeLang(lang);
  if (!norm || !SUPPORTED.includes(norm)) return currentLang;

  currentLang = norm;
  try {
    document.documentElement.lang = currentLang;
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch (_) {
    // ignore
  }

  // Force info overlay to rebuild with the new language on next open
  const overlay = document.getElementById("info-overlay");
  if (overlay) overlay.remove();

  return currentLang;
}

export function getCurrentLanguage() {
  return currentLang;
}

export function t(key) {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;

  // Italian tweaks: shorter destination label on mobile, different remark label on desktop
  if (currentLang === "it") {
    if (key === "columnDestination") {
      return isMobileViewport() ? "Destinaz." : "Destinazione";
    }
    if (key === "columnRemark") {
      return isMobileViewport() ? entry.it : "Informazione";
    }
  }

  return entry[currentLang] || entry.fr || Object.values(entry)[0] || key;
}

export function applyStaticTranslations() {
  const pairs = [
    ["#station-subtitle", "nextDepartures"],
    ["#departures-caption", "nextDepartures"],
    ["label[for='station-input']", "searchStop"],
    [".line-chips-label", "servedByLines"],
    ["th.col-line", "columnLine"],
    ["th.col-dest", "columnDestination"],
    ["th.col-time", "columnDeparture"],
    ["th.col-platform", "columnPlatformBus"],
    ["th.col-min", "columnMinutes"],
    ["th.col-remark", "columnRemark"],
    ["label[for='language-select']", "languageLabel"],
    ["#board-mode-label", "boardModeLabel"],
    ["#board-mode-title", "boardModeTitle"],
    ["#board-mode-desc-1", "boardModeDesc1"],
    ["#board-mode-desc-2", "boardModeDesc2"],
    ["#board-mode-ok", "boardModeOk"],
    ["#filters-open-label", "filterButton"],
    ["#filters-sheet-title", "filterButton"],
    ["#filters-platforms-title", "filterPlatforms"],
    ["#filters-lines-title", "filterLines"],
    ["#favorites-only-label", "filterFavoritesLabel"],
    ["#favorites-popover-title", "filterFavoritesTitle"],
    ["#favorites-manage", "filterManageFavorites"],
    ["#favorites-delete", "favoritesDelete"],
    ["#filters-reset-inline", "filterReset"],
    ["#filters-reset", "filterReset"],
    ["#filters-apply", "filterApply"],
    ["#favorites-empty", "filterNoFavorites"],
    ["#platforms-empty", "filterNoPlatforms"],
    ["#lines-empty", "filterNoLines"],
    ["#view-section-label", "viewSectionLabel"],
    ["#view-segment [data-view='line']", "viewOptionLine"],
    ["#view-segment [data-view='time']", "viewOptionTime"],
  ];

  for (const [selector, key] of pairs) {
    const el = document.querySelector(selector);
    if (el) el.textContent = t(key);
  }
}
