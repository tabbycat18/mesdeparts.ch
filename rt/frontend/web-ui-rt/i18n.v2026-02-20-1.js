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
  searchEmpty: {
    fr: "Aucun arrêt trouvé",
    de: "Keine Haltestelle gefunden",
    it: "Nessuna fermata trovata",
    en: "No stop found",
  },
  searchLoading: {
    fr: "Recherche…",
    de: "Suchen…",
    it: "Ricerca…",
    en: "Searching…",
  },
  searchUnavailable: {
    fr: "Serveur indisponible",
    de: "Server nicht verfügbar",
    it: "Server non disponibile",
    en: "Server unavailable",
  },
  searchUnavailableSub: {
    fr: "Réessaie dans quelques secondes",
    de: "Versuche es in ein paar Sekunden erneut",
    it: "Riprova tra qualche secondo",
    en: "Try again in a few seconds",
  },
  searchOffline: {
    fr: "Connexion instable",
    de: "Verbindung instabil",
    it: "Connessione instabile",
    en: "Unstable connection",
  },
  searchRetry: {
    fr: "Réessayer",
    de: "Erneut versuchen",
    it: "Riprova",
    en: "Retry",
  },
  searchHintOffline: {
    fr: "hors ligne",
    de: "offline",
    it: "offline",
    en: "offline",
  },
  homeStopDialogTitle: {
    fr: "Lieu de départ",
    de: "Abfahrtshaltestelle",
    it: "Fermata di partenza",
    en: "My departure stop",
  },
  homeStopDialogDescription: {
    fr: "Choisissez votre arrêt de départ par défaut pour ce navigateur.",
    de: "Wählen Sie Ihre Standard-Abfahrtshaltestelle für diesen Browser.",
    it: "Scegli la tua fermata di partenza predefinita per questo browser.",
    en: "Choose your default departure stop for this browser.",
  },
  homeStopDialogInputLabel: {
    fr: "Rechercher un arrêt de départ",
    de: "Abfahrtshaltestelle suchen",
    it: "Cerca fermata di partenza",
    en: "Search departure stop",
  },
  homeStopDialogDontAskAgain: {
    fr: "Ne plus demander",
    de: "Nicht mehr fragen",
    it: "Non chiedere più",
    en: "Don't ask again",
  },
  homeStopDialogCancel: {
    fr: "Annuler",
    de: "Abbrechen",
    it: "Annulla",
    en: "Cancel",
  },
  homeStopDialogConfirm: {
    fr: "Confirmer",
    de: "Bestätigen",
    it: "Conferma",
    en: "Confirm",
  },
  threeDotsTipBody: {
    fr: "Astuce: utilisez le menu 3 points pour ouvrir/fermer les réglages.",
    de: "Tipp: Verwende das Drei-Punkte-Menü, um die Einstellungen zu öffnen/schließen.",
    it: "Suggerimento: usa il menu a tre puntini per aprire/chiudere le impostazioni.",
    en: "Tip: use the three dots menu to open/close settings.",
  },
  threeDotsTipClose: {
    fr: "Fermer",
    de: "Schließen",
    it: "Chiudi",
    en: "Close",
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
    it: "Da",
    en: "Departs",
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
    it: "Corsia",
    en: "Stop",
  },
  columnMinutes: {
    fr: "Min",
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
  remarkEarly: {
    fr: "En avance",
    de: "Früh",
    it: "In anticipo",
    en: "Early",
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
    fr: "Masquer les boutons",
    de: "Tasten ausblenden",
    it: "Nascondi i pulsanti",
    en: "Hide buttons",
  },
  dualShowControls: {
    fr: "Afficher les boutons",
    de: "Tasten anzeigen",
    it: "Mostra i pulsanti",
    en: "Show buttons",
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
    it: "Corsia",
    en: "Platform",
  },
  filterPlatformsShort: {
    fr: "Quai",
    de: "Gl.",
    it: "Bin.",
    en: "Stop",
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
    it: "Nascondi la colonna Da (bus)",
    en: "Hide Departure column (bus)",
  },
  filterHideDepartureShort: {
    fr: "Masquer colonne Départ",
    de: "Abfahrtsspalte ausblenden",
    it: "Nascondi colonna Da",
    en: "Hide Departure column",
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
    fr: "Tout",
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
  favoriteAdded: {
    fr: "Ajouté aux favoris",
    de: "Zu Favoriten hinzugefügt",
    it: "Aggiunto ai preferiti",
    en: "Added to favorites",
  },
  favoriteRemoved: {
    fr: "Retiré des favoris",
    de: "Aus Favoriten entfernt",
    it: "Rimosso dai preferiti",
    en: "Removed from favorites",
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
    it: "Nessuna Corsia disponibile",
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
    it: "Da prevista",
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
    fr: "Min",
    de: "Min",
    it: "Min",
    en: "Min",
  },
  viewOptionLine: {
    fr: "Ligne",
    de: "Linie",
    it: "Linea",
    en: "Line",
  },
  trainFilterAll: {
    fr: "Tous",
    de: "Alle",
    it: "Tutti",
    en: "All",
  },
  trainFilterRegional: {
    fr: "Régional",
    de: "Regional",
    it: "Regionale",
    en: "Regional",
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
    it: "Visuali",
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
  infoTitle: {
    fr: "Aide et informations",
    de: "Hilfe und Informationen",
    it: "Aiuto e informazioni",
    en: "Help and info",
  },
  infoClose: {
    fr: "Fermer",
    de: "Schließen",
    it: "Chiudi",
    en: "Close",
  },
  infoTabsLabel: {
    fr: "Sections d'aide",
    de: "Hilfebereiche",
    it: "Sezioni di aiuto",
    en: "Help sections",
  },
  infoTabHelp: {
    fr: "Aide",
    de: "Hilfe",
    it: "Aiuto",
    en: "Help",
  },
  infoTabRealtime: {
    fr: "Temps réel et retards",
    de: "Echtzeit und Verspätungen",
    it: "Tempo reale e ritardi",
    en: "Realtime and delays",
  },
  infoTabCredits: {
    fr: "Sources et crédits",
    de: "Quellen und Credits",
    it: "Fonti e crediti",
    en: "Sources and credits",
  },
  infoModalDescription: {
    fr: "Aide rapide pour utiliser mesdeparts.ch et comprendre les départs en temps réel.",
    de: "Schnelle Hilfe zur Nutzung von mesdeparts.ch und zum Verständnis der Echtzeitabfahrten.",
    it: "Aiuto rapido per usare mesdeparts.ch e capire le partenze in tempo reale.",
    en: "Quick help to use mesdeparts.ch and understand realtime departures.",
  },
  infoHelpSectionQuickStartTitle: {
    fr: "Démarrage rapide",
    de: "Schnellstart",
    it: "Avvio rapido",
    en: "Quick start",
  },
  infoHelpQuickStartItem1: {
    fr: "Tapez au moins 2 lettres pour rechercher un arrêt, puis choisissez dans la liste.",
    de: "Geben Sie mindestens 2 Buchstaben ein, suchen Sie eine Haltestelle und wählen Sie sie aus der Liste.",
    it: "Digita almeno 2 lettere, cerca una fermata e selezionala dall'elenco.",
    en: "Type at least 2 letters, search for a stop, then choose it from the list.",
  },
  infoHelpQuickStartItem2: {
    fr: "Utilisez l'étoile pour enregistrer vos arrêts favoris sur cet appareil.",
    de: "Speichern Sie Haltestellen mit dem Stern als Favoriten auf diesem Gerät.",
    it: "Usa la stella per salvare le fermate preferite su questo dispositivo.",
    en: "Use the star to save favorite stops on this device.",
  },
  infoHelpSectionReadingTitle: {
    fr: "Lire les départs",
    de: "Abfahrten lesen",
    it: "Leggere le partenze",
    en: "Reading departures",
  },
  infoHelpReadingItem1: {
    fr: "« Départ » affiche l'horaire planifié communiqué par l'exploitant.",
    de: "„Abfahrt“ zeigt die geplante Zeit laut Betreiberfahrplan.",
    it: "“Partenza” mostra l'orario pianificato pubblicato dall'operatore.",
    en: "\"Departure\" shows the planned time published by the operator.",
  },
  infoHelpReadingItem2: {
    fr: "« Min » affiche une estimation en direct qui peut évoluer minute par minute.",
    de: "„Min“ zeigt eine Live-Schätzung, die sich von Minute zu Minute ändern kann.",
    it: "“Min” mostra una stima in tempo reale che può cambiare di minuto in minuto.",
    en: "\"Min\" shows a live estimate that can change minute by minute.",
  },
  infoHelpSectionFiltersTitle: {
    fr: "Filtrer la liste",
    de: "Liste filtern",
    it: "Filtrare l'elenco",
    en: "Filtering the list",
  },
  infoHelpFiltersItem1: {
    fr: "Ouvrez « Filtres » pour limiter l'affichage par ligne ou par quai.",
    de: "Öffnen Sie „Filter“, um die Anzeige nach Linie oder Kante einzugrenzen.",
    it: "Apri “Filtri” per limitare la vista per linea o banchina.",
    en: "Open \"Filters\" to narrow the list by line or platform.",
  },
  infoHelpFiltersItem2: {
    fr: "Utilisez « Réinitialiser » pour revenir à la liste complète.",
    de: "Verwenden Sie „Zurücksetzen“, um zur vollständigen Liste zurückzukehren.",
    it: "Usa “Reimposta” per tornare all'elenco completo.",
    en: "Use \"Reset\" to return to the full list.",
  },
  infoHelpSectionPersonalizationTitle: {
    fr: "Personnaliser l'affichage",
    de: "Anzeige anpassen",
    it: "Personalizzare la vista",
    en: "Personalization",
  },
  infoHelpPersonalizationItem1: {
    fr: "Le menu « … » permet de changer d'arrêt, de langue et de mode d'affichage.",
    de: "Im Menü „…“ können Sie Haltestelle, Sprache und Anzeige-Modus ändern.",
    it: "Nel menu “…” puoi cambiare fermata, lingua e modalità di visualizzazione.",
    en: "Use the \"…\" menu to change stop, language, and display mode.",
  },
  infoHelpPersonalizationItem2: {
    fr: "Vos choix sont conservés localement dans ce navigateur.",
    de: "Ihre Auswahl wird lokal in diesem Browser gespeichert.",
    it: "Le tue scelte vengono salvate localmente in questo browser.",
    en: "Your choices are stored locally in this browser.",
  },
  infoRealtimeSectionMinDepartureTitle: {
    fr: "« Min » vs « Départ »",
    de: "„Min“ vs „Abfahrt“",
    it: "“Min” vs “Partenza”",
    en: "\"Min\" vs \"Departure\"",
  },
  infoRealtimeMinDepartureItem1: {
    fr: "« Départ » indique l'heure théorique prévue au planning.",
    de: "„Abfahrt“ zeigt die theoretische Planzeit.",
    it: "“Partenza” indica l'orario teorico pianificato.",
    en: "\"Departure\" is the scheduled timetable time.",
  },
  infoRealtimeMinDepartureItem2: {
    fr: "« Min » indique l'estimation en direct et peut varier sans alerte de retard.",
    de: "„Min“ zeigt die Live-Schätzung und kann sich ohne Verspätungsalarm ändern.",
    it: "“Min” indica la stima in tempo reale e può variare senza avviso di ritardo.",
    en: "\"Min\" is the live estimate and can move without a delay badge.",
  },
  infoRealtimeSectionOfficialTitle: {
    fr: "Retard officiel",
    de: "Offizielle Verspätung",
    it: "Ritardo ufficiale",
    en: "Official delay",
  },
  infoRealtimeOfficialItem1: {
    fr: "Un écart en temps réel n'est pas toujours publié comme retard officiel.",
    de: "Eine Echtzeitabweichung wird nicht immer als offizielle Verspätung gemeldet.",
    it: "Uno scostamento in tempo reale non viene sempre pubblicato come ritardo ufficiale.",
    en: "A realtime shift is not always published as an official delay.",
  },
  infoRealtimeOfficialItem2: {
    fr: "Le statut officiel dépend des règles de communication de l'exploitant.",
    de: "Der offizielle Status hängt von den Kommunikationsregeln des Betreibers ab.",
    it: "Lo stato ufficiale dipende dalle regole di comunicazione dell'operatore.",
    en: "Official status depends on the operator’s communication rules.",
  },
  infoRealtimeSectionThresholdsTitle: {
    fr: "Seuils mesdeparts.ch",
    de: "Schwellen auf mesdeparts.ch",
    it: "Soglie su mesdeparts.ch",
    en: "mesdeparts.ch thresholds",
  },
  infoRealtimeThresholdItem1: {
    fr: "Bus, tram, métro : étiquette « Retard » dès +2 min.",
    de: "Bus, Tram, Metro: Label „Verspätung“ ab +2 Min.",
    it: "Bus, tram, metro: etichetta “Ritardo” da +2 min.",
    en: "Bus, tram, metro: delay badge from +2 min.",
  },
  infoRealtimeThresholdItem2: {
    fr: "Trains : étiquette « Retard » dès +1 min.",
    de: "Züge: Label „Verspätung“ ab +1 Min.",
    it: "Treni: etichetta “Ritardo” da +1 min.",
    en: "Trains: delay badge from +1 min.",
  },
  infoRealtimeThresholdItem3: {
    fr: "Sous ces seuils, seul le compte à rebours est affiché.",
    de: "Unter diesen Schwellen wird nur der Countdown angezeigt.",
    it: "Sotto queste soglie viene mostrato solo il conto alla rovescia.",
    en: "Below these thresholds, only the countdown is shown.",
  },
  infoRealtimeSectionDisruptionsTitle: {
    fr: "Suppressions et changements",
    de: "Ausfälle und Änderungen",
    it: "Soppressioni e cambi",
    en: "Cancellations and changes",
  },
  infoRealtimeDisruptionsItem1: {
    fr: "En cas de suppression, la mention « Supprimé » est prioritaire.",
    de: "Bei einem Ausfall hat der Hinweis „Ausfall“ Vorrang.",
    it: "In caso di soppressione, la dicitura “Soppresso” ha priorità.",
    en: "If cancelled, the \"Cancelled\" status overrides other remarks.",
  },
  infoRealtimeDisruptionsItem2: {
    fr: "Les changements de quai ou de voie peuvent apparaître dans la remarque.",
    de: "Änderungen von Kante oder Gleis können in der Bemerkung erscheinen.",
    it: "I cambi di banchina o binario possono apparire nelle osservazioni.",
    en: "Platform changes can appear in the remarks column.",
  },
  infoRealtimeSectionCheckTitle: {
    fr: "En cas de doute",
    de: "Bei Unsicherheit",
    it: "In caso di dubbio",
    en: "When uncertain",
  },
  infoRealtimeCheckItem1: {
    fr: "Comparez avec les écrans officiels en station ou l'app de l'exploitant.",
    de: "Vergleichen Sie mit den offiziellen Anzeigen vor Ort oder der Betreiber-App.",
    it: "Confronta con i display ufficiali in stazione o con l'app dell'operatore.",
    en: "Compare with official station displays or the operator app.",
  },
  infoRealtimeCheckItem2: {
    fr: "Les données publiques peuvent évoluer rapidement selon la situation réseau.",
    de: "Öffentliche Daten können sich je nach Netzlage schnell ändern.",
    it: "I dati pubblici possono cambiare rapidamente in base alla situazione di rete.",
    en: "Public data can change quickly depending on network conditions.",
  },
  infoCreditsSectionSourcesTitle: {
    fr: "Source des données",
    de: "Datenquelle",
    it: "Fonte dei dati",
    en: "Data source",
  },
  infoCreditsSourcesItem1: {
    fr: "Données : api.mesdeparts.ch (agrégation de sources publiques suisses).",
    de: "Daten: api.mesdeparts.ch (Aggregation öffentlicher Schweizer Quellen).",
    it: "Dati: api.mesdeparts.ch (aggregazione di fonti pubbliche svizzere).",
    en: "Data: api.mesdeparts.ch (aggregation of Swiss public sources).",
  },
  infoCreditsSourcesItem2: {
    fr: "La disponibilité dépend des flux fournis par les exploitants.",
    de: "Die Verfügbarkeit hängt von den bereitgestellten Betreiber-Feeds ab.",
    it: "La disponibilità dipende dai feed forniti dagli operatori.",
    en: "Availability depends on the feeds provided by operators.",
  },
  infoCreditsSectionClockTitle: {
    fr: "Horloge",
    de: "Uhr",
    it: "Orologio",
    en: "Clock",
  },
  infoCreditsClockItem1: {
    fr: "sbbUhr — © GoetteSebastian — Apache License 2.0.",
    de: "sbbUhr — © GoetteSebastian — Apache License 2.0.",
    it: "sbbUhr — © GoetteSebastian — Apache License 2.0.",
    en: "sbbUhr — © GoetteSebastian — Apache License 2.0.",
  },
  infoCreditsClockItem2: {
    fr: "Adaptation mesdeparts.ch, inspirée de CFF-Clock / SlendyMilky.",
    de: "Anpassung für mesdeparts.ch, inspiriert von CFF-Clock / SlendyMilky.",
    it: "Adattamento per mesdeparts.ch, ispirato a CFF-Clock / SlendyMilky.",
    en: "Adaptation for mesdeparts.ch, inspired by CFF-Clock / SlendyMilky.",
  },
  infoCreditsSectionLicenseTitle: {
    fr: "Licence et copyright",
    de: "Lizenz und Copyright",
    it: "Licenza e copyright",
    en: "License and copyright",
  },
  infoCreditsLicenseItem1: {
    fr: "© 2025 tabbycat18 — mesdeparts.ch.",
    de: "© 2025 tabbycat18 — mesdeparts.ch.",
    it: "© 2025 tabbycat18 — mesdeparts.ch.",
    en: "© 2025 tabbycat18 — mesdeparts.ch.",
  },
  infoCreditsLicenseItem2: {
    fr: "Code publié sous licence Apache 2.0.",
    de: "Code veröffentlicht unter Apache License 2.0.",
    it: "Codice pubblicato con licenza Apache 2.0.",
    en: "Code published under Apache License 2.0.",
  },
  infoCreditsSectionIndependenceTitle: {
    fr: "Indépendance",
    de: "Unabhängigkeit",
    it: "Indipendenza",
    en: "Independence",
  },
  infoCreditsIndependenceItem1: {
    fr: "Projet indépendant, sans affiliation officielle avec CFF/SBB.",
    de: "Unabhängiges Projekt ohne offizielle Zugehörigkeit zu CFF/SBB.",
    it: "Progetto indipendente, senza affiliazione ufficiale con CFF/SBB.",
    en: "Independent project with no official affiliation with CFF/SBB.",
  },
  infoHelpItemSearch: {
    fr: "Recherche : saisissez quelques lettres, puis choisissez votre arrêt (⭐ pour l'ajouter aux favoris).",
    de: "Suchen: Tippen Sie 2 Buchstaben → Haltestelle wählen (⭐ Favorit).",
    it: "Cercate: digitate 2 lettere → scegliete una fermata (⭐ preferito).",
    en: "Search: type 2 letters → choose a stop (⭐ favorite).",
  },
  infoHelpItemViews: {
    fr: "Affichage : « Min » montre l'estimation en direct ; « Départ » affiche l'heure prévue.",
    de: "Ansichten: Nach min = chronologisch\nNach Linie = gruppiert.",
    it: "Viste: Per min = cronologico\nPer linea = raggruppato.",
    en: "Views: By min = chronological\nBy line = grouped.",
  },
  infoHelpItemFilters: {
    fr: "Filtres : limitez la liste par ligne ou par quai, puis utilisez « Réinitialiser » pour revenir à la vue complète.",
    de: "Filter: öffnen Sie „Filter“, wählen Sie Gleis/Linie (Chips). Die Schaltfläche zeigt „Gleis: … • Linien: …“; „Zurücksetzen“ löscht alles.",
    it: "Filtri: aprite Filtri, selezionate le pillole Binario/Linea. Il pulsante mostra \"Binario: … • Linee: …\"; “Reimposta” azzera.",
    en: "Filters: open Filters, tick the Platform/Line chips. The button shows “Platform: … • Lines: …”; “Reset” clears all.",
  },
  infoHelpItemRead: {
    fr: "Menu … : changez rapidement d'arrêt, de langue et de mode d'affichage.",
    de: "Anzeige lesen: min = Echtzeit\nAbfahrt = offizieller Fahrplan.",
    it: "Leggere: min = tempo reale\nPart. = orario ufficiale.",
    en: "Read the screen: min = realtime\nDeparture = scheduled time.",
  },
  infoHelpItemData: {
    fr: "Données : api.mesdeparts.ch regroupe des sources publiques suisses ; en cas de doute, référez-vous à l'affichage officiel sur place.",
    de: "Daten: api.mesdeparts.ch (Aggregation öffentlicher Schweizer Quellen; bei Zweifel offizielle Anzeige/vor Ort prüfen).",
    it: "Dati: api.mesdeparts.ch (aggregazione di fonti pubbliche svizzere; in dubbio: display ufficiale/sul posto).",
    en: "Data: api.mesdeparts.ch (aggregated from Swiss public sources; if unsure: official display/on site).",
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
    it: "Filtri: pulsante “Filtri” → chip Corsia/Linee. Il contatore mostra i filtri attivi; “Reimposta” li cancella.",
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
    it: "Ritardi: bus/tram da +2 min, treni da +1 min. “Part.” è sempre l’orario ufficiale; “min” è il conto alla rovescia in tempo reale che può includere piccoli scostamenti non segnalati come ritardi ufficiali.",
    en: "Delays: bus/tram from +2 min, trains from +1 min. “Departure” is always the official timetable; “min” is a realtime countdown that may include small shifts not flagged as official delays.",
  },
  disclaimerTitle: {
    fr: "Disclaimer",
    de: "Disclaimer",
    it: "Disclaimer",
    en: "Disclaimer",
  },
  disclaimerBody: {
    fr: "Les données proviennent de api.mesdeparts.ch (agrégation de sources publiques suisses) et peuvent être incomplètes ou différer de l’affichage officiel. En cas de doute, veuillez vérifier auprès de l’opérateur ou sur place.",
    de: "Die Daten stammen von api.mesdeparts.ch (Aggregation öffentlicher Schweizer Quellen) und können unvollständig sein oder vom offiziellen Aushang abweichen. Im Zweifel bitte beim Betreiber oder vor Ort prüfen.",
    it: "I dati provengono da api.mesdeparts.ch (aggregazione di fonti pubbliche svizzere) e possono essere incompleti o differire dalle indicazioni ufficiali. In caso di dubbio verifica presso l’operatore o in loco.",
    en: "Data comes from api.mesdeparts.ch (aggregation of Swiss public sources) and may be incomplete or differ from official displays. If in doubt, check with the operator or on site.",
  },
  delaysTitle: {
    fr: "Retards et données en temps réel",
    de: "Verspätungen und Echtzeitdaten",
    it: "Ritardi e dati in tempo reale",
    en: "Delays and realtime data",
  },
  infoRealtimeMinVsDepartureTitle: {
    fr: "Comprendre « Min » et « Départ »",
    de: "„min“ vs. „Abfahrt“",
    it: "“min” vs “Part.”",
    en: "“min” vs “Departure”",
  },
  infoRealtimeDeparture: {
    fr: "Départ : heure planifiée publiée par l'exploitant.",
    de: "Abfahrt: offizieller Fahrplan (geplant).",
    it: "Da: orario ufficiale (pianificato).",
    en: "Departure: official timetable (planned).",
  },
  infoRealtimeCountdown: {
    fr: "Min : estimation en direct, ajustée en continu selon la circulation.",
    de: "min: Echtzeit-Countdown; kann sich bewegen, auch wenn kein Delay angezeigt wird.",
    it: "min: conto alla rovescia in tempo reale; può cambiare anche senza ritardo visualizzato.",
    en: "min: realtime countdown; it can move even if no delay is shown.",
  },
  delaysBody: {
    fr: "En Suisse, un retard est communiqué comme officiel à partir d'un certain seuil défini par l'exploitant.",
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
    fr: "Règles d'affichage sur mesdeparts.ch",
    de: "Anzeigeschwellen auf mesdeparts.ch",
    it: "Soglie di visualizzazione su mesdeparts.ch",
    en: "Display thresholds on mesdeparts.ch",
  },
  infoRealtimeThresholdsBus: {
    fr: "Bus, tram, métro : mention « Retard » à partir de +2 min.",
    de: "Bus/Tram/Metro: Verspätung ab +2 Min",
    it: "Bus / tram / metro: ritardo mostrato da +2 min",
    en: "Bus / tram / metro: delay shown from +2 min",
  },
  infoRealtimeThresholdsTrain: {
    fr: "Trains : mention « Retard » à partir de +1 min.",
    de: "Züge: Verspätung ab +1 Min",
    it: "Treni: ritardo mostrato da +1 min",
    en: "Trains: delay shown from +1 min",
  },
  infoRealtimeThresholdsNote: {
    fr: "Sous ces seuils, seule l'estimation en minutes est affichée.",
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
    en: "Delayed approx. {min} min",
  },
  infoCreditsDataTitle: {
    fr: "Données",
    de: "Daten",
    it: "Dati",
    en: "Data",
  },
  creditsData: {
    fr: "Données : api.mesdeparts.ch, agrégation de sources publiques suisses.",
    de: "Daten: api.mesdeparts.ch",
    it: "Dati: api.mesdeparts.ch",
    en: "Data: api.mesdeparts.ch",
  },
  creditsAuthor: {
    fr: "© 2025 tabbycat18 · mesdeparts.ch · Apache 2.0",
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
    fr: "Horloge : sbbUhr — © GoetteSebastian — Apache 2.0.",
    de: "Uhr: sbbUhr — © GoetteSebastian — Apache License 2.0",
    it: "Orologio: sbbUhr — © GoetteSebastian — Apache License 2.0",
    en: "Clock: sbbUhr — © GoetteSebastian — Apache License 2.0",
  },
  creditsClockNote: {
    fr: "Adaptation et intégration : mesdeparts.ch, inspiré de CFF-Clock (SlendyMilky).",
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
    fr: "Projet indépendant, sans affiliation officielle avec CFF/SBB.",
    de: "Keine Zugehörigkeit oder offizielle Genehmigung der SBB/CFF.",
    it: "Nessuna affiliazione o approvazione ufficiale CFF/SBB.",
    en: "No affiliation or official approval from SBB/CFF.",
  },
  footerNote: {
    fr: "Données : api.mesdeparts.ch — Horloge : sbbUhr (Apache 2.0) — Non officiel, aucune affiliation avec CFF/SBB/FFS ou les exploitants.",
    de: "Daten: api.mesdeparts.ch — Uhr: sbbUhr (Apache License 2.0) — Inoffiziell, keine Zugehörigkeit zu SBB/CFF/FFS oder Betreibern.",
    it: "Dati: api.mesdeparts.ch — Orologio: sbbUhr (Apache 2.0) — Non ufficiale, nessuna affiliazione con FFS/SBB/CFF o operatori.",
    en: "Data: api.mesdeparts.ch — Clock: sbbUhr (Apache 2.0) — Unofficial; no affiliation with SBB/CFF/FFS or operators.",
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

  // Force info overlay to rebuild with the new language on next open.
  // Hide first to ensure modal side effects (body lock/padding) are cleaned up.
  const overlay = document.getElementById("info-overlay");
  if (overlay?.__infoControls && typeof overlay.__infoControls.hide === "function") {
    try {
      overlay.__infoControls.hide();
    } catch (_) {
      // ignore
    }
  }
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
      return isMobileViewport() ? "Destinazione" : "Destinazione";
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
    ["#language-select-title", "languageLabel"],
    ["#filters-open-label", "filterButton"],
    ["#filters-sheet-title", "filterButton"],
    ["#filters-display-title", "filterDisplay"],
    ["#filters-platforms-title", "filterPlatforms"],
    ["#filters-lines-title", "filterLines"],
    ["#favorites-only-label", "filterFavoritesLabel"],
    ["#favorites-popover-title", "filterFavoritesTitle"],
    ["#favorites-manage", "filterManageFavorites"],
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
