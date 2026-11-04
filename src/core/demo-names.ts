// Names for the demo drive, one set per interface language. Every list has the same
// length in both sets (the type below enforces it), so the drive has the same shape and
// the same sizes in either language; only the names differ.

/** Same shape as `T` with plain strings: tuples keep their length. */
type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

const enNames = {
  root: 'Example Drive',
  games: 'Games',
  gameList: [
    { name: 'Starwright', exe: 'Starwright' },
    { name: 'Aurora Saga', exe: 'AuroraSaga' },
    { name: 'Deepwater Station', exe: 'Deepwater' },
    { name: 'Keepstone Chronicles', exe: 'Keepstone' },
    { name: 'Pixel Rally 3', exe: 'PixelRally3' },
    { name: 'Neon Courier', exe: 'NeonCourier' },
  ],
  videos: 'Videos',
  trips: ['Croatia Trip 2023', 'Lena & Tom Wedding', 'Ski Trip 2025', "Grandma's 80th Birthday"],
  recordings: 'Recordings',
  films: 'Movies',
  filmList: ['The Long Road North', 'Glass City', 'Last Ferry Home', 'Moonlight Sonata', 'Among Wolves', 'Summer at the Lake', 'Project Aurora', 'The Clockmaker'],
  photos: 'Photos',
  music: 'Music',
  artists: ['The Pebbles', 'Night Moths', 'Cold Front', 'Lumen Trio', 'Wanderlust Orchestra', 'Pole Star', 'The Tides', 'Kestrel', 'Mira Sun', 'Steelworks 9', 'Blue Hour', 'Daydream Club', 'Woodruff', 'Beacons', 'Stormfield', 'Grey Area Quartet', 'Half Moon', 'Morning Dew'],
  albums: ['First Steps', 'Between the Lines', 'Live in Leeds', 'Northbound', 'Sonar', 'Late Summer', 'Radio Silence', 'Fourteen', 'Weightless', 'House of Cards'],
  songs: ['Daybreak', 'Miles', 'Asphalt', 'Tightrope', 'Lighthouse', 'Shadows', 'Fever', 'Flyway', 'Paper Plane', 'Glass Heart', 'Dust Storm', 'Night Train', 'Sparks', 'Avalanche'],
  projects: 'Projects',
  website: 'my-website',
  component: 'component',
  engine: 'game-engine',
  module: 'module',
  textures: 'textures',
  downloadList: [
    'Office_Suite_2024.iso',
    'Linux-Desktop-24.04.iso',
    'Windows-Install-Media.iso',
    'Game_Mods_Pack.7z',
    'Graphics_Driver_571.33.exe',
    'Photo_Editor_Setup_v5.exe',
    'Video_Editor_Trial.msi',
    'Invoices_2023_Archive.zip',
    'Wedding_Photos_Originals.zip',
    'Washing_Machine_Manual.pdf',
  ],
  /** Stems of the small leftovers in Downloads: document, photo, setup, invoice, export. */
  leftovers: ['Document', 'Photo', 'setup', 'Invoice', 'export'],
  backups: 'Backups',
  phoneBackup: 'Phone-Backup',
  systemImage: 'Laptop-System-Image.vhdx',
  oldDisk: 'Old Hard Drive',
  oldFile: 'old',
  documents: 'Documents',
  /** Taxes, insurance, job applications, university, recipes. */
  documentFolders: ['Taxes', 'Insurance', 'Job Applications', 'University', 'Recipes'],
  notes: 'Notes.txt',
} as const;

export type DemoNames = Shape<typeof enNames>;

export const en: DemoNames = enNames;

export const de: DemoNames = {
  root: 'Beispiel-Laufwerk',
  games: 'Spiele',
  gameList: [
    { name: 'Sternenwerft', exe: 'Sternenwerft' },
    { name: 'Nordlicht Saga', exe: 'NordlichtSaga' },
    { name: 'Tiefsee Station', exe: 'Tiefsee' },
    { name: 'Burgfried Chroniken', exe: 'Burgfried' },
    { name: 'Pixel Rally 3', exe: 'PixelRally3' },
    { name: 'Neon Kurier', exe: 'NeonKurier' },
  ],
  videos: 'Videos',
  trips: ['Urlaub Kroatien 2023', 'Hochzeit Lena & Tom', 'Skiurlaub 2025', 'Geburtstag Oma 80'],
  recordings: 'Aufnahmen',
  films: 'Filme',
  filmList: ['Der lange Weg nach Norden', 'Stadt aus Glas', 'Die letzte Fähre', 'Mondscheinsonate', 'Unter Wölfen', 'Sommer am See', 'Projekt Aurora', 'Die Uhrmacherin'],
  photos: 'Fotos',
  music: 'Musik',
  artists: ['Die Kiesel', 'Nachtfalter', 'Kaltfront', 'Lumen Trio', 'Fernweh Orchester', 'Polarstern', 'Die Gezeiten', 'Rotkehlchen', 'Mira Sonne', 'Stahlwerk 9', 'Blaue Stunde', 'Kopfkino', 'Waldmeister', 'Leuchtfeuer', 'Sturmhöhe', 'Grauzone Quartett', 'Halbmond', 'Morgentau'],
  albums: ['Erste Schritte', 'Zwischen den Zeilen', 'Live in Leipzig', 'Nordwärts', 'Echolot', 'Spätsommer', 'Funkstille', 'Vierzehn', 'Schwerelos', 'Kartenhaus'],
  songs: ['Morgenrot', 'Kilometer', 'Asphalt', 'Seiltanz', 'Leuchtturm', 'Schatten', 'Fieber', 'Zugvögel', 'Papierflieger', 'Glasherz', 'Sandsturm', 'Nachtzug', 'Funken', 'Lawine'],
  projects: 'Projekte',
  website: 'meine-website',
  component: 'komponente',
  engine: 'spiel-engine',
  module: 'modul',
  textures: 'texturen',
  downloadList: [
    'Office_Paket_2024.iso',
    'Linux-Desktop-24.04.iso',
    'Windows-Installationsmedium.iso',
    'Spiel_Mods_Paket.7z',
    'Treiber_Grafikkarte_571.33.exe',
    'Setup_Fotobearbeitung_v5.exe',
    'Videoschnitt_Testversion.msi',
    'Archiv_Rechnungen_2023.zip',
    'Hochzeitsfotos_Originale.zip',
    'Handbuch_Waschmaschine.pdf',
  ],
  leftovers: ['Dokument', 'Foto', 'setup', 'Rechnung', 'export'],
  backups: 'Backups',
  phoneBackup: 'Handy-Backup',
  systemImage: 'Laptop-Systemabbild.vhdx',
  oldDisk: 'Alte Festplatte',
  oldFile: 'alt',
  documents: 'Dokumente',
  documentFolders: ['Steuer', 'Versicherungen', 'Bewerbungen', 'Studium', 'Rezepte'],
  notes: 'Notizen.txt',
};
