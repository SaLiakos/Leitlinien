# Leitlinien

Eine kleine Web-App für das iPhone: eigene Leitlinien-PDFs durchsuchen, Fundstellen direkt auf der Seite markiert sehen und erkennen, ob es von DOG und BVA eine neuere Fassung gibt.

## Auf dem iPhone einrichten

1. Die App-Adresse (GitHub Pages dieses Repos) in **Safari** öffnen.
2. Teilen › **Zum Home-Bildschirm**.
3. Die App über das neue Symbol öffnen, **PDFs hinzufügen** antippen und im Dateien-Dialog den Leitlinien-Ordner öffnen › Auswählen › Alle auswählen › Öffnen.

Neue PDFs später genauso hinzufügen; schon gespeicherte werden übersprungen.

## Datenschutz

- Die PDFs und ihr Text bleiben **nur auf dem Gerät** (Speicher der App). Die App lädt nichts hoch und kennt keinen Ordnerpfad, nur die ausgewählten Dateien.
- Aus dem Internet lädt die App nur `versions.json` aus diesem Repo.
- Dieses Repo enthält keine Leitlinientexte und keine PDFs.

## Versionsprüfung

`.github/workflows/versionspruefung.yml` läuft jeden Morgen und startet `pruefung/pruefen.py`:

- liest die öffentliche Übersicht von DOG und BVA (`pruefung/quellen.json`), die verlinkten Dokumentseiten und die verlinkten AWMF-Registerseiten,
- fragt für jedes PDF nur **Dateigröße, Datum und ETag** beim Server ab (kein Download),
- schreibt das Ergebnis nach `versions.json` (Titel, Links, Datum, Dateigröße, frühere Fassungen).

Die App vergleicht ihre gespeicherten PDFs mit dieser Liste: über die exakte Dateigröße, den Dateinamen, die AWMF-Registernummer oder – als Vorschlag zum Bestätigen – den Titel.

Manuell starten: Reiter **Actions** › **Versionsprüfung** › **Run workflow**.

## Technik

- Reines HTML/CSS/JavaScript ohne Build-Schritt, offline nutzbar (Service Worker).
- PDF-Verarbeitung mit [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0, in `vendor/pdfjs/`).
- Nach Änderungen an der App `VERSION` in `sw.js` erhöhen, damit installierte Apps aktualisiert werden.
