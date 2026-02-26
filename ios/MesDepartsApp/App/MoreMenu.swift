import SwiftUI

enum AppPreferencesKeys {
    static let displayMode = "mesdeparts.display_mode"
    static let language = "mesdeparts.language"
    static let includeAlerts = "mesdeparts.include_alerts"
}

enum DisplayModeOption: String, CaseIterable, Identifiable {
    case line
    case min

    var id: String { rawValue }
}

enum AppLanguageOption: String, CaseIterable, Identifiable {
    case en
    case fr
    case de
    case it

    var id: String { rawValue }
}

enum MoreSheetDestination: String, Identifiable {
    case favorites
    case filters
    case diagnostics
    case about

    var id: String { rawValue }
}

enum AppLabelKey {
    case more
    case favorites
    case filters
    case stopSearch
    case searchPlaceholder
    case typeAtLeastTwoCharacters
    case searching
    case noMatchingStops
    case results
    case displayMode
    case displayModeLine
    case displayModeMin
    case language
    case aboutInfo
    case diagnostics
    case includeAlerts
    case departures
    case servedByLines
    case updatedLabel
    case loadingDepartures
    case favoritesPlaceholder
    case filtersPlaceholder
    case aboutTitle
    case aboutDescription
    case minuteSuffix
    case platformUnavailable
}

func appLabel(_ key: AppLabelKey, language: AppLanguageOption) -> String {
    switch language {
    case .en:
        switch key {
        case .more: return "More"
        case .favorites: return "Favorites"
        case .filters: return "Filters"
        case .stopSearch: return "Stop Search"
        case .searchPlaceholder: return "Search stop or station"
        case .typeAtLeastTwoCharacters: return "Type at least 2 characters."
        case .searching: return "Searching..."
        case .noMatchingStops: return "No matching stops."
        case .results: return "Results"
        case .displayMode: return "Display mode"
        case .displayModeLine: return "Line"
        case .displayModeMin: return "Min"
        case .language: return "Language"
        case .aboutInfo: return "About / Info"
        case .diagnostics: return "Diagnostics"
        case .includeAlerts: return "Include alerts"
        case .departures: return "Departures"
        case .servedByLines: return "Served by lines"
        case .updatedLabel: return "Updated"
        case .loadingDepartures: return "Loading departures..."
        case .favoritesPlaceholder: return "Favorites placeholder"
        case .filtersPlaceholder: return "Filter preferences"
        case .aboutTitle: return "About MesDeparts"
        case .aboutDescription: return "Native iOS client for mesdeparts.ch"
        case .minuteSuffix: return "min"
        case .platformUnavailable: return "Platform n/a"
        }
    case .fr:
        switch key {
        case .more: return "Plus"
        case .favorites: return "Favoris"
        case .filters: return "Filtres"
        case .stopSearch: return "Recherche d'arret"
        case .searchPlaceholder: return "Rechercher un arret ou une gare"
        case .typeAtLeastTwoCharacters: return "Entrez au moins 2 caracteres."
        case .searching: return "Recherche..."
        case .noMatchingStops: return "Aucun arret trouve."
        case .results: return "Resultats"
        case .displayMode: return "Mode d'affichage"
        case .displayModeLine: return "Ligne"
        case .displayModeMin: return "Min"
        case .language: return "Langue"
        case .aboutInfo: return "A propos / Infos"
        case .diagnostics: return "Diagnostics"
        case .includeAlerts: return "Inclure les alertes"
        case .departures: return "Departs"
        case .servedByLines: return "Lignes desservies"
        case .updatedLabel: return "Mis a jour"
        case .loadingDepartures: return "Chargement des departs..."
        case .favoritesPlaceholder: return "Ecran favoris (placeholder)"
        case .filtersPlaceholder: return "Preferences de filtres"
        case .aboutTitle: return "A propos de MesDeparts"
        case .aboutDescription: return "Client iOS natif pour mesdeparts.ch"
        case .minuteSuffix: return "min"
        case .platformUnavailable: return "Quai n/d"
        }
    case .de:
        switch key {
        case .more: return "Mehr"
        case .favorites: return "Favoriten"
        case .filters: return "Filter"
        case .stopSearch: return "Haltestellensuche"
        case .searchPlaceholder: return "Haltestelle oder Bahnhof suchen"
        case .typeAtLeastTwoCharacters: return "Mindestens 2 Zeichen eingeben."
        case .searching: return "Suche..."
        case .noMatchingStops: return "Keine Treffer."
        case .results: return "Ergebnisse"
        case .displayMode: return "Anzeigemodus"
        case .displayModeLine: return "Linie"
        case .displayModeMin: return "Min"
        case .language: return "Sprache"
        case .aboutInfo: return "Info"
        case .diagnostics: return "Diagnose"
        case .includeAlerts: return "Meldungen einbeziehen"
        case .departures: return "Abfahrten"
        case .servedByLines: return "Bediente Linien"
        case .updatedLabel: return "Aktualisiert"
        case .loadingDepartures: return "Abfahrten werden geladen..."
        case .favoritesPlaceholder: return "Favoriten Platzhalter"
        case .filtersPlaceholder: return "Filtereinstellungen"
        case .aboutTitle: return "Uber MesDeparts"
        case .aboutDescription: return "Native iOS-App fur mesdeparts.ch"
        case .minuteSuffix: return "min"
        case .platformUnavailable: return "Gleis k. A."
        }
    case .it:
        switch key {
        case .more: return "Altro"
        case .favorites: return "Preferiti"
        case .filters: return "Filtri"
        case .stopSearch: return "Ricerca fermata"
        case .searchPlaceholder: return "Cerca fermata o stazione"
        case .typeAtLeastTwoCharacters: return "Inserisci almeno 2 caratteri."
        case .searching: return "Ricerca in corso..."
        case .noMatchingStops: return "Nessuna fermata trovata."
        case .results: return "Risultati"
        case .displayMode: return "Modalita visualizzazione"
        case .displayModeLine: return "Linea"
        case .displayModeMin: return "Min"
        case .language: return "Lingua"
        case .aboutInfo: return "Info"
        case .diagnostics: return "Diagnostica"
        case .includeAlerts: return "Includi avvisi"
        case .departures: return "Partenze"
        case .servedByLines: return "Linee servite"
        case .updatedLabel: return "Aggiornato"
        case .loadingDepartures: return "Caricamento partenze..."
        case .favoritesPlaceholder: return "Schermata preferiti (placeholder)"
        case .filtersPlaceholder: return "Preferenze filtri"
        case .aboutTitle: return "Informazioni su MesDeparts"
        case .aboutDescription: return "Client iOS nativo per mesdeparts.ch"
        case .minuteSuffix: return "min"
        case .platformUnavailable: return "Binario n/d"
        }
    }
}

struct MoreMenuButton: View {
    @Binding var presentedSheet: MoreSheetDestination?
    @Binding var displayModeRawValue: String
    @Binding var languageRawValue: String

    private var displayModeBinding: Binding<DisplayModeOption> {
        Binding(
            get: { DisplayModeOption(rawValue: displayModeRawValue) ?? .line },
            set: { displayModeRawValue = $0.rawValue }
        )
    }

    private var languageBinding: Binding<AppLanguageOption> {
        Binding(
            get: { AppLanguageOption(rawValue: languageRawValue) ?? .en },
            set: { languageRawValue = $0.rawValue }
        )
    }

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }

    var body: some View {
        Menu {
            Button {
                presentedSheet = .favorites
            } label: {
                Label(appLabel(.favorites, language: language), systemImage: "star")
            }

            Button {
                presentedSheet = .filters
            } label: {
                Label(appLabel(.filters, language: language), systemImage: "line.3.horizontal.decrease.circle")
            }

            Menu {
                Button {
                    languageBinding.wrappedValue = .en
                } label: {
                    languageMenuLabel("EN", isSelected: languageBinding.wrappedValue == .en)
                }
                Button {
                    languageBinding.wrappedValue = .fr
                } label: {
                    languageMenuLabel("FR", isSelected: languageBinding.wrappedValue == .fr)
                }
                Button {
                    languageBinding.wrappedValue = .de
                } label: {
                    languageMenuLabel("DE", isSelected: languageBinding.wrappedValue == .de)
                }
                Button {
                    languageBinding.wrappedValue = .it
                } label: {
                    languageMenuLabel("IT", isSelected: languageBinding.wrappedValue == .it)
                }
            } label: {
                Label(appLabel(.language, language: language), systemImage: "globe")
            }

            Menu {
                Button {
                    displayModeBinding.wrappedValue = .line
                } label: {
                    modeMenuLabel(
                        appLabel(.displayModeLine, language: language),
                        isSelected: displayModeBinding.wrappedValue == .line
                    )
                }
                Button {
                    displayModeBinding.wrappedValue = .min
                } label: {
                    modeMenuLabel(
                        appLabel(.displayModeMin, language: language),
                        isSelected: displayModeBinding.wrappedValue == .min
                    )
                }
            } label: {
                Label(appLabel(.displayMode, language: language), systemImage: "rectangle.grid.1x2")
            }

            Divider()

            Button {
                presentedSheet = .diagnostics
            } label: {
                Label(appLabel(.diagnostics, language: language), systemImage: "waveform.path.ecg")
            }

            Button {
                presentedSheet = .about
            } label: {
                Label(appLabel(.aboutInfo, language: language), systemImage: "info.circle")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(appLabel(.more, language: language))
    }

    @ViewBuilder
    private func languageMenuLabel(_ code: String, isSelected: Bool) -> some View {
        if isSelected {
            Label(code, systemImage: "checkmark")
        } else {
            Text(code)
        }
    }

    @ViewBuilder
    private func modeMenuLabel(_ label: String, isSelected: Bool) -> some View {
        if isSelected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }
}

struct FavoritesPlaceholderView: View {
    @AppStorage(AppPreferencesKeys.language) private var languageRawValue = AppLanguageOption.en.rawValue

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }

    var body: some View {
        List {
            Section {
                Text(appLabel(.favoritesPlaceholder, language: language))
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(appLabel(.favorites, language: language))
    }
}

struct FiltersPlaceholderView: View {
    @AppStorage(AppPreferencesKeys.language) private var languageRawValue = AppLanguageOption.en.rawValue
    @AppStorage(AppPreferencesKeys.includeAlerts) private var includeAlertsEnabled = true

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }

    var body: some View {
        Form {
            Section {
                Toggle(appLabel(.includeAlerts, language: language), isOn: $includeAlertsEnabled)
            } footer: {
                Text(appLabel(.filtersPlaceholder, language: language))
            }
        }
        .navigationTitle(appLabel(.filters, language: language))
    }
}

struct AboutInfoView: View {
    @AppStorage(AppPreferencesKeys.language) private var languageRawValue = AppLanguageOption.en.rawValue

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(appLabel(.aboutDescription, language: language))
                    Text(versionString)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
        }
        .navigationTitle(appLabel(.aboutTitle, language: language))
    }

    private var versionString: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "v\(version) (\(build))"
    }
}
