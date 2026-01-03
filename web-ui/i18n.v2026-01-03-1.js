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
  searchAction: {
    fr: "Rechercher un arrêt",
    de: "Haltestelle suchen",
    it: "Cerca fermata",
    en: "Search stop",
  },
  nearbyButton: {
    fr: "Autour de moi",
    de: "In meiner Nähe",
    it: "Vicino a me",
    en: "Nearby",
  },
  nearbyNoGeo: {
    fr: "La géolocalisation n'est pas disponible sur cet appareil.",
    de: "Standortbestimmung ist auf diesem Gerät nicht verfügbar.",
    it: "La geolocalizzazione non è disponibile su questo dispositivo.",
    en: "Location is not available on this device.",
  },
  nearbyDenied: {
    fr: "Accès à la localisation refusé.",
    de: "Zugriff auf den Standort verweigert.",
    it: "Accesso alla posizione negato.",
    en: "Location access denied.",
  },
  nearbySearching: {
    fr: "Recherche des arrêts proches…",
    de: "Suche nach Haltestellen in der Nähe…",
    it: "Ricerca delle fermate vicine…",
    en: "Looking for nearby stops…",
  },
  nearbyNone: {
    fr: "Aucun arrêt trouvé autour de vous.",
    de: "Keine Haltestellen in Ihrer Nähe gefunden.",
    it: "Nessuna fermata trovata nelle vicinanze.",
    en: "No nearby stops found.",
  },
  nearbyError: {
    fr: "Échec de la recherche autour de vous.",
    de: "Suche in Ihrer Nähe fehlgeschlagen.",
    it: "Ricerca nelle vicinanze non riuscita.",
    en: "Nearby search failed.",
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
  quickControlsHide: {
    fr: "Masquer",
    de: "Ausblenden",
    it: "Nascondi",
    en: "Hide",
  },
  quickControlsShow: {
    fr: "Afficher",
    de: "Anzeigen",
    it: "Mostra",
    en: "Show",
  },
  dualBoardLabel: {
    fr: "Dual",
    de: "Dual",
    it: "Dual",
    en: "Dual",
  },
  dualBoardOpen: {
    fr: "Ouvrir le dual board",
    de: "Dual board öffnen",
    it: "Aprire il dual board",
    en: "Open dual board",
  },
  dualSwap: {
    fr: "Échanger",
    de: "Tauschen",
    it: "Scambia",
    en: "Swap",
  },
  dualReset: {
    fr: "Réinitialiser",
    de: "Zurücksetzen",
    it: "Reimposta",
    en: "Reset",
  },
  dualHideControls: {
    fr: "Masquer les contrôles",
    de: "Bedienelemente ausblenden",
    it: "Nascondi i controlli",
    en: "Hide controls",
  },
  dualShowControls: {
    fr: "Afficher les contrôles",
    de: "Bedienelemente anzeigen",
    it: "Mostra i controlli",
    en: "Show controls",
  },
  dualFullscreen: {
    fr: "Plein écran",
    de: "Vollbild",
    it: "Schermo intero",
    en: "Fullscreen",
  },
  dualExitFullscreen: {
    fr: "Quitter le plein écran",
    de: "Vollbild beenden",
    it: "Esci da schermo intero",
    en: "Exit fullscreen",
  },
  dualInfoLabel: {
    fr: "Informations",
    de: "Informationen",
    it: "Informazioni",
    en: "Info",
  },
  dualStatusEnterStation: {
    fr: "Merci d'entrer une station valide",
    de: "Bitte einen gültigen Halt eingeben",
    it: "Inserisci una fermata valida",
    en: "Please enter a valid stop",
  },
  dualStatusNoNearby: {
    fr: "aucun arrêt proche",
    de: "keine Haltestelle in der Nähe",
    it: "nessuna fermata vicina",
    en: "no nearby stop",
  },
  dualStatusGeoUnavailable: {
    fr: "géolocalisation indisponible",
    de: "Standortbestimmung nicht verfügbar",
    it: "geolocalizzazione non disponibile",
    en: "location unavailable",
  },
  dualStatusSelectBeforeFavorite: {
    fr: "sélectionne un arrêt avant d'ajouter aux favoris.",
    de: "bitte wähle eine Haltestelle, bevor du sie zu den Favoriten hinzufügst.",
    it: "seleziona una fermata prima di aggiungerla ai preferiti.",
    en: "select a stop before adding to favorites.",
  },
  dualStatusFillBoth: {
    fr: "Merci de renseigner les deux tableaux.",
    de: "Bitte beide Tafeln ausfüllen.",
    it: "Compila entrambi i pannelli.",
    en: "Please fill both boards.",
  },
  dualStatusLoadedSuffix: {
    fr: "chargés.",
    de: "geladen.",
    it: "caricati.",
    en: "loaded.",
  },
  dualStatusSwapped: {
    fr: "Les tableaux ont été échangés.",
    de: "Die Tafeln wurden vertauscht.",
    it: "I tabelloni sono stati scambiati.",
    en: "Boards have been swapped.",
  },
  dualStatusReset: {
    fr: "Réinitialisé sur les arrêts par défaut.",
    de: "Auf Standardhaltestellen zurückgesetzt.",
    it: "Reimpostato sulle fermate predefinite.",
    en: "Reset to default stops.",
  },
  dualStatusFullscreenUnavailable: {
    fr: "Le plein écran n'est pas disponible ici.",
    de: "Vollbild ist hier nicht verfügbar.",
    it: "La modalità schermo intero non è disponibile qui.",
    en: "Fullscreen is not available here.",
  },
  dualStatusFullscreenFailed: {
    fr: "Impossible d'activer le plein écran.",
    de: "Vollbild konnte nicht aktiviert werden.",
    it: "Impossibile attivare lo schermo intero.",
    en: "Could not enable fullscreen.",
  },
  dualStatusTapFullscreen: {
    fr: "Touchez pour activer le plein écran (fs=1).",
    de: "Tippen, um Vollbild zu aktivieren (fs=1).",
    it: "Tocca per attivare lo schermo intero (fs=1).",
    en: "Tap to enable fullscreen (fs=1).",
  },
  dualSideLeft: {
    fr: "Gauche",
    de: "Links",
    it: "Sinistra",
    en: "Left",
  },
  dualSideRight: {
    fr: "Droite",
    de: "Rechts",
    it: "Destra",
    en: "Right",
  },
  filterPlatforms: {
    fr: "Quai",
    de: "Gleis",
    it: "Banchina",
    en: "Platform",
  },
  filterPlatformsShort: {
    fr: "Quai",
    de: "Gl.",
    it: "Bin.",
    en: "Pl.",
  },
  filterDisplay: {
    fr: "Affichage",
    de: "Anzeige",
    it: "Display",
    en: "Display",
  },
  filterHideDeparture: {
    fr: "Masquer la colonne Départ (bus)",
    de: "Abfahrts-Spalte ausblenden (Bus)",
    it: "Nascondi la colonna Partenza (bus)",
    en: "Hide Departure column (bus)",
  },
  filterHideDepartureShort: {
    fr: "Départ–",
    de: "Abfahrt–",
    it: "Partenza–",
    en: "Depart–",
  },
  filterLines: {
    fr: "Lignes",
    de: "Linien",
    it: "Linee",
    en: "Lines",
  },
  filterLinesShort: {
    fr: "Lig.",
    de: "Lin.",
    it: "Lin.",
    en: "Ln.",
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
    fr: "Favoris",
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
  headerUnofficialTag: {
    fr: "Non officiel — aucune affiliation",
    de: "Inoffiziell — keine Zugehörigkeit",
    it: "Non ufficiale — nessuna affiliazione",
    en: "Unofficial — no affiliation",
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
  journeyTitle: {
    fr: "Détails du trajet",
    de: "Fahrtdetails",
    it: "Dettagli del viaggio",
    en: "Trip details",
  },
  journeyLoading: {
    fr: "Chargement…",
    de: "Laden…",
    it: "Caricamento…",
    en: "Loading…",
  },
  journeyNoStops: {
    fr: "Aucun arrêt détaillé pour ce trajet.",
    de: "Keine Detailhalte für diese Fahrt.",
    it: "Nessuna fermata dettagliata per questo viaggio.",
    en: "No detailed stops for this trip.",
  },
  journeyPlannedDeparture: {
    fr: "Départ prévu",
    de: "Geplante Abfahrt",
    it: "Partenza prevista",
    en: "Planned departure",
  },
  journeyStopsError: {
    fr: "Impossible de charger les arrêts pour ce trajet.",
    de: "Halte für diese Fahrt können nicht geladen werden.",
    it: "Impossibile caricare le fermate per questo viaggio.",
    en: "Unable to load stops for this trip.",
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
  trainFilterAll: {
    fr: "Tous",
    de: "Alle",
    it: "Tutti",
    en: "All",
  },
  trainFilterRegional: {
    fr: "Régional (S/R)",
    de: "Regional (S/R)",
    it: "Regionale (S/R)",
    en: "Regional (S/R)",
  },
  trainFilterLongDistance: {
    fr: "Grande ligne",
    de: "Fernverkehr",
    it: "Lunga percorrenza",
    en: "Long-distance",
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
    fr: "Mode tableau ON (recommandé) :",
    de: "Board-Modus ON (empfohlen):",
    it: "Modalità tabellone ON (consigliata):",
    en: "Board mode ON (recommended):",
  },
  boardModeDesc2: {
    fr: "Mode tableau OFF :",
    de: "Board-Modus OFF:",
    it: "Modalità tabellone OFF:",
    en: "Board mode OFF:",
  },
  boardModeDetail1: {
    fr: "Cache via Cloudflare, requêtes plus rares ; idéal si l’écran reste ouvert.",
    de: "Cache über Cloudflare, seltener abrufen; ideal, wenn der Bildschirm offen bleibt.",
    it: "Cache tramite Cloudflare, richieste meno frequenti; ideale con schermo aperto.",
    en: "Caches via Cloudflare, polls less often; ideal when the screen stays open.",
  },
  boardModeDetail2: {
    fr: "Requêtes directes plus fréquentes pour précision max ; pratique pour des consultations ponctuelles.",
    de: "Direkte, häufigere Abfragen für maximale Genauigkeit; praktisch für kurze Checks.",
    it: "Richieste dirette più frequenti per massima precisione; pratico per rapide consultazioni.",
    en: "Direct, more frequent requests for maximum accuracy; handy for quick checks.",
  },
  boardModeFootnote1: {
    fr: "Pour éviter de surcharger transport.opendata.ch, on passe par Cloudflare qui fait des appels moins fréquemment qu'en mode tableau OFF et met en cache les réponses pour que les utilisateurs se partagent un même fichier.",
    de: "Um transport.opendata.ch nicht zu überlasten, läuft Board ON über Cloudflare, ruft seltener ab als Board OFF und cached die Antworten, damit alle denselben Cache teilen.",
    it: "Per evitare di sovraccaricare transport.opendata.ch, si passa da Cloudflare che effettua meno chiamate rispetto al tabellone OFF e mette in cache le risposte così gli utenti condividono lo stesso file.",
    en: "To avoid overloading transport.opendata.ch, Board ON goes via Cloudflare, polls less often than Board OFF, and caches responses so users share the same file.",
  },
  boardModeFootnote2: {
    fr: "Appelle transport.opendata.ch directement et plus fréquemment qu'en mode tableau ON pour garantir une meilleure précision de l'horaire à l'utilisateur.",
    de: "Ruft transport.opendata.ch direkt und häufiger ab als Board ON, um eine genauere Fahrplananzeige zu liefern.",
    it: "Chiama transport.opendata.ch direttamente e più frequentemente del tabellone ON per garantire una maggiore precisione dell'orario.",
    en: "Calls transport.opendata.ch directly and more frequently than Board ON to give more accurate times.",
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
  infoTabsLabel: {
    fr: "Sections d’informations",
    de: "Infobereiche",
    it: "Sezioni informative",
    en: "Info sections",
  },
  infoTabHelp: {
    fr: "Aide",
    de: "Hilfe",
    it: "Aiuto",
    en: "Help",
  },
  infoTabRealtime: {
    fr: "Temps réel & retards",
    de: "Echtzeit & Verspätungen",
    it: "Tempo reale & ritardi",
    en: "Realtime & delays",
  },
  infoTabCredits: {
    fr: "Crédits",
    de: "Credits",
    it: "Crediti",
    en: "Credits",
  },
  infoHelpItemSearch: {
    fr: "Recherchez : tapez 2 lettres → choisissez un arrêt (⭐ favori).",
    de: "Suchen: Tippen Sie 2 Buchstaben → Haltestelle wählen (⭐ Favorit).",
    it: "Cercate: digitate 2 lettere → scegliete una fermata (⭐ preferito).",
    en: "Search: type 2 letters → choose a stop (⭐ favorite).",
  },
  infoHelpItemViews: {
    fr: "Vues : Par min = chronologique\nPar ligne = regroupé.",
    de: "Ansichten: Nach min = chronologisch\nNach Linie = gruppiert.",
    it: "Viste: Per min = cronologico\nPer linea = raggruppato.",
    en: "Views: By min = chronological\nBy line = grouped.",
  },
  infoHelpItemFilters: {
    fr: "Filtres : ouvrez Filtres, cochez les pastilles Quai/Ligne. Le bouton affiche « Quai: … • Lignes: … » ; « Réinitialiser » efface.",
    de: "Filter: öffnen Sie „Filter“, wählen Sie Gleis/Linie (Chips). Die Schaltfläche zeigt „Gleis: … • Linien: …“; „Zurücksetzen“ löscht alles.",
    it: "Filtri: aprite Filtri, selezionate le pillole Binario/Linea. Il pulsante mostra \"Binario: … • Linee: …\"; “Reimposta” azzera.",
    en: "Filters: open Filters, tick the Platform/Line chips. The button shows “Platform: … • Lines: …”; “Reset” clears all.",
  },
  infoHelpItemRead: {
    fr: "Lire l’écran : min = temps réel\nDépart = horaire officiel.",
    de: "Anzeige lesen: min = Echtzeit\nAbfahrt = offizieller Fahrplan.",
    it: "Leggere: min = tempo reale\nPartenza = orario ufficiale.",
    en: "Read the screen: min = realtime\nDeparture = scheduled time.",
  },
  infoHelpItemData: {
    fr: "Données : transport.opendata.ch (en cas de doute : affichage officiel/sur place).",
    de: "Daten: transport.opendata.ch (bei Zweifel offizielle Anzeige/vor Ort prüfen).",
    it: "Dati: transport.opendata.ch (in dubbio: display ufficiale/sul posto).",
    en: "Data: transport.opendata.ch (if unsure: official display/on site).",
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
  infoRealtimeMinVsDepartureTitle: {
    fr: "“min” vs “Départ”",
    de: "„min“ vs. „Abfahrt“",
    it: "“min” vs “Partenza”",
    en: "“min” vs “Departure”",
  },
  infoRealtimeDeparture: {
    fr: "Départ : horaire officiel (planifié).",
    de: "Abfahrt: offizieller Fahrplan (geplant).",
    it: "Partenza: orario ufficiale (pianificato).",
    en: "Departure: official timetable (planned).",
  },
  infoRealtimeCountdown: {
    fr: "min : compte à rebours en temps réel ; il peut bouger même si aucun retard n’est affiché.",
    de: "min: Echtzeit-Countdown; kann sich bewegen, auch wenn kein Delay angezeigt wird.",
    it: "min: conto alla rovescia in tempo reale; può cambiare anche senza ritardo visualizzato.",
    en: "min: realtime countdown; it can move even if no delay is shown.",
  },
  delaysBody: {
    fr: "En Suisse, un retard est considéré comme officiel à partir de 3 minutes. Les écarts de 1 à 2 minutes peuvent apparaître en temps réel sans être considérés comme officiels.",
    de: "In der Schweiz gilt eine Verspätung ab 3 Minuten als offiziell. Abweichungen von 1–2 Minuten können in der Echtzeit erscheinen, ohne als offiziell zu gelten.",
    it: "In Svizzera un ritardo è ufficiale da 3 minuti. Scostamenti di 1–2 minuti possono apparire in tempo reale senza essere considerati ufficiali.",
    en: "In Switzerland a delay is official from 3 minutes. Deviations of 1–2 minutes may appear in realtime without being considered official.",
  },
  delaysBus: {
    fr: "Pour les bus et trams, de légers écarts sont fréquents et reflètent l’adaptation du trafic en temps réel.",
    de: "Bei Bussen und Trams sind leichte Abweichungen häufig und spiegeln die Anpassung des Verkehrs in Echtzeit wider.",
    it: "Per bus e tram sono frequenti piccole variazioni che riflettono l’adattamento del traffico in tempo reale.",
    en: "For buses and trams, small shifts are common and reflect realtime traffic adjustments.",
  },
  delaysRuleThresholds: {
    fr: "Seuils : bus/tram/metro dès +2 min, trains dès +1 min. En dessous, on laisse le compte à rebours clair.",
    de: "Schwellen: Bus/Tram/Metro ab +2 Min, Züge ab +1 Min. Darunter bleibt der Countdown sauber.",
    it: "Soglie: bus/tram/metro da +2 min, treni da +1 min. Sotto queste soglie il conto alla rovescia resta pulito.",
    en: "Thresholds: bus/tram/metro from +2 min, trains from +1 min. Below that, the countdown stays uncluttered.",
  },
  delaysRuleCountdown: {
    fr: "La ligne « min » est en temps réel : même 1 min de décalage peut apparaître, sans afficher un retard officiel pour les bus.",
    de: "Die Zeile „min“ ist Echtzeit: Auch 1 Minute Abweichung kann erscheinen, ohne bei Bussen als offizielle Verspätung zu gelten.",
    it: "La riga “min” è in tempo reale: anche 1 minuto di scarto può apparire lì, senza mostrare un ritardo ufficiale per i bus.",
    en: "The “min” line is realtime: even a 1-minute shift can appear there, without marking an official delay for buses.",
  },
  infoRealtimeOfficialTitle: {
    fr: "Retard officiel (Suisse)",
    de: "Offizielle Verspätung (Schweiz)",
    it: "Ritardo ufficiale (Svizzera)",
    en: "Official delay (Switzerland)",
  },
  infoRealtimeThresholdsTitle: {
    fr: "Seuils d’affichage sur mesdeparts.ch",
    de: "Anzeigeschwellen auf mesdeparts.ch",
    it: "Soglie di visualizzazione su mesdeparts.ch",
    en: "Display thresholds on mesdeparts.ch",
  },
  infoRealtimeThresholdsBus: {
    fr: "Bus / tram / métro : retard affiché dès +2 min",
    de: "Bus/Tram/Metro: Verspätung ab +2 Min",
    it: "Bus / tram / metro: ritardo mostrato da +2 min",
    en: "Bus / tram / metro: delay shown from +2 min",
  },
  infoRealtimeThresholdsTrain: {
    fr: "Trains : retard affiché dès +1 min",
    de: "Züge: Verspätung ab +1 Min",
    it: "Treni: ritardo mostrato da +1 min",
    en: "Trains: delay shown from +1 min",
  },
  infoRealtimeThresholdsNote: {
    fr: "En dessous, le compte à rebours reste “clair” (pas d’étiquette).",
    de: "Darunter bleibt der Countdown klar (kein Label).",
    it: "Sotto, il conto alla rovescia resta “pulito” (senza etichetta).",
    en: "Below that, the countdown stays clear (no label).",
  },
  infoRealtimeColorsTitle: {
    fr: "Couleurs",
    de: "Farben",
    it: "Colori",
    en: "Colors",
  },
  infoRealtimeColorsInline: {
    fr: "Jaune : retard • Rouge : annulation",
    de: "Gelb: Verspätung • Rot: Ausfall",
    it: "Giallo: ritardo • Rosso: soppressione",
    en: "Yellow: delay • Red: cancellation",
  },
  infoRealtimeCancelTitle: {
    fr: "Annulations / suppressions",
    de: "Annullierungen / Ausfälle",
    it: "Cancellazioni / soppressioni",
    en: "Cancellations / suppressions",
  },
  delaysRuleColors: {
    fr: "Affichage : la colonne « Remarque » passe en jaune pour un retard, rouge pour les annulations.",
    de: "Anzeige: Die Spalte „Bemerkung“ wird gelb bei Verspätung, rot bei Ausfällen.",
    it: "Visualizzazione: la colonna “Osservazioni” diventa gialla per ritardi, rossa per soppressioni.",
    en: "Display: the “Remark” column turns yellow for delays, red for cancellations.",
  },
  delaysRuleCancelled: {
    fr: "“Supprimé” : la suppression remplace le reste (texte rouge).",
    de: "„Supprimé“: Ausfall ersetzt den Rest (roter Text).",
    it: "“Soppresso”: la soppressione sostituisce il resto (testo rosso).",
    en: "\"Cancelled\": the cancellation overrides everything else (red text).",
  },
  infoRealtimeWhyBusTitle: {
    fr: "Pourquoi les bus bougent souvent",
    de: "Warum Busse sich oft bewegen",
    it: "Perché i bus si muovono spesso",
    en: "Why buses move often",
  },
  infoRealtimeWhyBusBody: {
    fr: "Pour les bus/trams, de légers écarts sont fréquents (trafic, priorités, régulation) et reflètent l’adaptation temps réel.",
    de: "Bei Bussen/Trams sind kleine Abweichungen häufig (Verkehr, Prioritäten, Regulierung) und zeigen die Echtzeitanpassung.",
    it: "Per bus/tram piccoli scostamenti sono frequenti (traffico, priorità, regolazione) e riflettono l’adattamento in tempo reale.",
    en: "For buses/trams, small shifts are common (traffic, priority, regulation) and reflect realtime adjustments.",
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
  infoCreditsDataTitle: {
    fr: "Données",
    de: "Daten",
    it: "Dati",
    en: "Data",
  },
  creditsData: {
    fr: "Données : transport.opendata.ch",
    de: "Daten: transport.opendata.ch",
    it: "Dati: transport.opendata.ch",
    en: "Data: transport.opendata.ch",
  },
  creditsAuthor: {
    fr: "© 2025 tabbycat18 – mesdeparts.ch — Licence Apache 2.0.",
    de: "© 2025 tabbycat18 – mesdeparts.ch — Apache-Lizenz 2.0.",
    it: "© 2025 tabbycat18 – mesdeparts.ch — Licenza Apache 2.0.",
    en: "© 2025 tabbycat18 – mesdeparts.ch — Apache License 2.0.",
  },
  infoCreditsClockTitle: {
    fr: "Horloge",
    de: "Uhr",
    it: "Orologio",
    en: "Clock",
  },
  creditsClock: {
    fr: "Horloge : sbbUhr — © GoetteSebastian — Apache License 2.0",
    de: "Uhr: sbbUhr — © GoetteSebastian — Apache License 2.0",
    it: "Orologio: sbbUhr — © GoetteSebastian — Apache License 2.0",
    en: "Clock: sbbUhr — © GoetteSebastian — Apache License 2.0",
  },
  creditsClockNote: {
    fr: "Adaptation et intégration pour mesdeparts.ch (inspiré par CFF-Clock / SlendyMilky).",
    de: "Anpassung und Integration für mesdeparts.ch (inspiriert von CFF-Clock / SlendyMilky).",
    it: "Adattamento e integrazione per mesdeparts.ch (ispirato da CFF-Clock / SlendyMilky).",
    en: "Adaptation and integration for mesdeparts.ch (inspired by CFF-Clock / SlendyMilky).",
  },
  infoCreditsAffiliationTitle: {
    fr: "Affiliation",
    de: "Zugehörigkeit",
    it: "Affiliazione",
    en: "Affiliation",
  },
  infoCreditsAffiliation: {
    fr: "Aucune affiliation ni approbation officielle CFF/SBB.",
    de: "Keine Zugehörigkeit oder offizielle Genehmigung der SBB/CFF.",
    it: "Nessuna affiliazione o approvazione ufficiale CFF/SBB.",
    en: "No affiliation or official approval from SBB/CFF.",
  },
  footerNote: {
    fr: "Données : transport.opendata.ch — Horloge : sbbUhr (Apache 2.0) — Non officiel, aucune affiliation avec CFF/SBB/FFS ou les exploitants.",
    de: "Daten: transport.opendata.ch — Uhr: sbbUhr (Apache License 2.0) — Inoffiziell, keine Zugehörigkeit zu SBB/CFF/FFS oder Betreibern.",
    it: "Dati: transport.opendata.ch — Orologio: sbbUhr (Apache 2.0) — Non ufficiale, nessuna affiliazione con FFS/SBB/CFF o operatori.",
    en: "Data: transport.opendata.ch — Clock: sbbUhr (Apache 2.0) — Unofficial; no affiliation with SBB/CFF/FFS or operators.",
  },
  infoCreditsLineColorsTitle: {
    fr: "Couleurs de lignes",
    de: "Linienfarben",
    it: "Colori delle linee",
    en: "Line colors",
  },
  lineColorsNotice: {
    fr: "Les couleurs des lignes sont utilisées à des fins d’identification visuelle, selon les chartes publiques des exploitants.",
    de: "Die Linienfarben dienen der visuellen Identifikation gemäß den öffentlich zugänglichen Farbwelten der Betreiber.",
    it: "I colori delle linee sono usati solo per identificazione visiva, secondo le palette pubbliche degli operatori.",
    en: "Line colors are used for visual identification only, following operators’ public palettes.",
  },
  infoCreditsLicenseTitle: {
    fr: "Licence du projet",
    de: "Projektlizenz",
    it: "Licenza del progetto",
    en: "Project license",
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
    ["#board-mode-detail-1", "boardModeDetail1"],
    ["#board-mode-detail-2", "boardModeDetail2"],
    ["#board-mode-footnote-1", "boardModeFootnote1"],
    ["#board-mode-footnote-2", "boardModeFootnote2"],
    ["#board-mode-ok", "boardModeOk"],
    ["#filters-open-label", "filterButton"],
    ["#filters-sheet-title", "filterButton"],
    ["#filters-display-title", "filterDisplay"],
    ["label[for='filters-hide-departure']", "filterHideDeparture"],
    ["#filters-hide-departure", "filterHideDeparture"],
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
    ["#unofficial-tag", "headerUnofficialTag"],
    ["#footer-note", "footerNote"],
    ["#view-section-label", "viewSectionLabel"],
    ["#view-segment [data-view='line']", "viewOptionLine"],
    ["#view-segment [data-view='time']", "viewOptionTime"],
    ["#dual-board-label", "dualBoardLabel"],
  ];

  for (const [selector, key] of pairs) {
    const el = document.querySelector(selector);
    if (el) el.textContent = t(key);
  }

  const geoBtn = document.getElementById("station-search-btn");
  if (geoBtn) {
    geoBtn.setAttribute("aria-label", t("nearbyButton"));
    geoBtn.title = t("nearbyButton");
  }

  const quickToggle = document.getElementById("quick-controls-toggle");
  const quickToggleLabel = document.getElementById("quick-controls-toggle-label");
  if (quickToggleLabel) {
    const collapsed = quickToggle ? quickToggle.classList.contains("is-collapsed") : false;
    const txt = t(collapsed ? "quickControlsShow" : "quickControlsHide");
    quickToggleLabel.textContent = txt;
    if (quickToggle) quickToggle.setAttribute("aria-label", txt);
  }

  const dualBoardLink = document.getElementById("dual-board-link");
  if (dualBoardLink) {
    const dualLabel = t("dualBoardOpen");
    dualBoardLink.setAttribute("aria-label", dualLabel);
    dualBoardLink.title = dualLabel;
  }
}
