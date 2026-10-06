// Abgleich der gespeicherten PDFs mit der täglich erstellten Versionsliste (versions.json).
//
// Die Versionsliste enthält je Online-Dokument nur Titel, Links, Datum und
// Dateigröße der PDFs – keine Inhalte. Erkannt wird eine Datei in dieser
// Reihenfolge: eigene Zuordnung › exakte Dateigröße › Dateiname ›
// AWMF-Registernummer › Titelähnlichkeit.

import { titelWoerter } from "./text.js";

export const STATUS = {
  aktuell: { text: "Aktuell", ton: "ruhig" },
  neu: { text: "Neue Version", ton: "warnung" },
  abweichend: { text: "Andere Fassung online", ton: "hinweis" },
  vermutet: { text: "Zuordnung prüfen", ton: "neutral" },
  ersetzt: { text: "Ältere Fassung", ton: "neutral" },
  entfernt: { text: "Nicht mehr gelistet", ton: "hinweis" },
  unbekannt: { text: "Nicht überwacht", ton: "leise" },
};

export async function versionenLaden() {
  const antwort = await fetch("./versions.json", { cache: "no-store" });
  if (!antwort.ok) throw new Error(`Versionsliste nicht erreichbar (${antwort.status})`);
  return antwort.json();
}

function entschluesseln(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function dateiname(url) {
  return entschluesseln((url || "").split(/[?#]/)[0].split("/").pop() || "");
}

/** Vergleichbarer Kern eines Dateinamens (ohne Endung, Kopie-Zusätze, Satzzeichen). */
export function dateiKern(name) {
  let n = entschluesseln(name).toLowerCase().trim();
  n = n.replace(/\.pdf$/, "");
  n = n.replace(/\s*\(\d+\)$/, "").replace(/\s+\d{1,2}$/, ""); // iOS: "Datei 2", "Datei (1)"
  n = n.replace(/-\d{1,2}$/, ""); // WordPress: "datei-1"
  return n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
}

/** AWMF-Registernummer aus einem Dateinamen, z. B. 045-018l_S1_…_2025-10.pdf */
export function registerInfo(name) {
  const n = entschluesseln(name || "");
  const m = n.match(/(?:^|[^0-9])(\d{3})[-_](\d{3})([a-z])?(?=[_\-\s.]|$)/i);
  if (!m) return null;
  const d = n.match(/(20\d{2})-(\d{2})(?:_\d+)?\.pdf$/i);
  return { nummer: `${m[1]}-${m[2]}`, art: (m[3] || "").toLowerCase(), datum: d ? `${d[1]}-${d[2]}` : null };
}

function fingerabdruck(dok) {
  return (dok.dateien || [])
    .map((f) => `${f.url}|${f.groesse ?? ""}|${f.etag || f.geaendert || ""}`)
    .sort()
    .join(";");
}

function titelOhneJahr(t) {
  return (t || "").replace(/\(\s*\d{4}(\s*\/\s*\d{4})?\s*\)|\bNEU!?|\b(19|20)\d{2}\b/gi, " ");
}

function aehnlichkeit(titelW, heuhaufenW) {
  if (!titelW.size) return 0;
  let treffer = 0;
  for (const w of titelW) if (heuhaufenW.has(w)) treffer++;
  return treffer / titelW.size;
}

/**
 * dokumente: lokale Metadaten [{ id, dateiname, groesse, titel, ersteSeite, zuordnung, bestaetigt }]
 * versionen: Inhalt von versions.json
 * Ergebnis: Map id → { status, online, grund, datei }
 */
export function abgleichen(dokumente, versionen) {
  const ergebnis = new Map();
  const online = (versionen?.dokumente || []).filter((d) => d && d.schluessel);
  const nachSchluessel = new Map(online.map((d) => [d.schluessel, d]));

  const nachGroesse = new Map();
  const nachKern = new Map();
  const nachRegister = new Map();
  const merken = (map, key, eintrag) => {
    if (key === undefined || key === null || key === "") return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(eintrag);
  };
  for (const d of online) {
    for (const f of d.dateien || []) {
      merken(nachGroesse, f.groesse, { dok: d, datei: f, aktuell: true });
      merken(nachKern, dateiKern(f.name || dateiname(f.url)), { dok: d, datei: f, aktuell: true });
      const r = registerInfo(f.name || dateiname(f.url));
      if (r) merken(nachRegister, r.nummer, { dok: d, datei: f, aktuell: true, r });
    }
    for (const f of d.frueher || []) {
      merken(nachGroesse, f.groesse, { dok: d, datei: f, aktuell: false });
      merken(nachKern, dateiKern(f.name || dateiname(f.url)), { dok: d, datei: f, aktuell: false });
    }
  }

  const titelCache = new Map();
  const titelW = (d) => {
    if (!titelCache.has(d.schluessel)) titelCache.set(d.schluessel, titelWoerter(titelOhneJahr(d.titel)));
    return titelCache.get(d.schluessel);
  };
  const heuhaufen = (lokal) => titelWoerter(`${lokal.dateiname || ""} ${lokal.titel || ""} ${lokal.ersteSeite || ""}`);

  // Bei mehreren Kandidaten (z. B. zufällig gleiche Größe) den mit dem passendsten Titel nehmen
  const besterKandidat = (kandidaten, lokal) => {
    if (kandidaten.length === 1) return kandidaten[0];
    const h = heuhaufen(lokal);
    return kandidaten
      .map((k) => ({ k, s: aehnlichkeit(titelW(k.dok), h) + (k.aktuell ? 0.01 : 0) }))
      .sort((a, b) => b.s - a.s)[0].k;
  };

  for (const lokal of dokumente) {
    let r = null;

    // 1. eigene Zuordnung
    if (lokal.zuordnung === "-") r = { status: "unbekannt", grund: "abgewaehlt" };
    else if (lokal.zuordnung && nachSchluessel.has(lokal.zuordnung)) {
      const d = nachSchluessel.get(lokal.zuordnung);
      if (lokal.bestaetigt) {
        r = { status: lokal.bestaetigt === fingerabdruck(d) ? "aktuell" : "neu", online: d, grund: "bestaetigt" };
      } else if ((d.dateien || []).some((f) => f.groesse === lokal.groesse)) {
        r = { status: "aktuell", online: d, grund: "groesse" };
      } else if ((d.frueher || []).some((f) => f.groesse === lokal.groesse)) {
        r = { status: "neu", online: d, grund: "groesse" };
      } else {
        r = { status: "abweichend", online: d, grund: "zugeordnet" };
      }
    }

    // 2. exakte Dateigröße – mit Plausibilitätsprüfung, falls Name und Titel gar nicht passen
    if (!r && nachGroesse.has(lokal.groesse)) {
      const k = besterKandidat(nachGroesse.get(lokal.groesse), lokal);
      const gleicherName = dateiKern(lokal.dateiname || "") === dateiKern(k.datei.name || dateiname(k.datei.url));
      const passenderTitel = aehnlichkeit(titelW(k.dok), heuhaufen(lokal)) >= 0.34;
      if (gleicherName || passenderTitel) {
        r = { status: k.aktuell ? "aktuell" : "neu", online: k.dok, datei: k.datei, grund: "groesse" };
      } else {
        r = { status: "vermutet", online: k.dok, datei: k.datei, grund: "groesse-unsicher" };
      }
    }

    // 3. gleicher Dateiname
    const kern = dateiKern(lokal.dateiname || "");
    if (!r && kern && nachKern.has(kern)) {
      const k = besterKandidat(nachKern.get(kern), lokal);
      r = { status: k.aktuell ? "abweichend" : "neu", online: k.dok, datei: k.datei, grund: "dateiname" };
    }

    // 4. AWMF-Registernummer (Dateiname enthält z. B. 045-018l_…_2021-01)
    const reg = registerInfo(lokal.dateiname || "");
    if (!r && reg && nachRegister.has(reg.nummer)) {
      const kandidaten = nachRegister.get(reg.nummer);
      const k = kandidaten.find((x) => x.r.art === reg.art) || kandidaten.find((x) => x.r.art === "l") || kandidaten[0];
      const aelter = reg.datum && k.r.datum && reg.datum < k.r.datum;
      r = { status: aelter ? "neu" : "abweichend", online: k.dok, datei: k.datei, grund: "register" };
    }

    // 5. ähnlicher Titel
    if (!r) {
      const h = heuhaufen(lokal);
      const wertung = online
        .filter((d) => (d.dateien || []).length)
        .map((d) => ({ d, s: aehnlichkeit(titelW(d), h), n: titelW(d).size }))
        .filter((x) => x.n >= 1)
        .sort((a, b) => b.s - a.s || b.n - a.n);
      const [erster, zweiter] = wertung;
      const passt = erster && (
        (erster.s >= 0.75 && (erster.n >= 2 || erster.s === 1)) ||
        (erster.s >= 0.6 && erster.n >= 4)
      );
      if (passt && (!zweiter || zweiter.s <= erster.s - 0.2)) {
        r = { status: "vermutet", online: erster.d, grund: "titel" };
      }
    }

    if (!r) r = { status: "unbekannt" };
    if (r.online?.entfernt && r.status === "aktuell") r.status = "entfernt";
    ergebnis.set(lokal.id, r);
  }

  // Ist die aktuelle Fassung schon gespeichert, sind ältere Dateien desselben Dokuments "ersetzt"
  const hatAktuelle = new Set();
  for (const r of ergebnis.values()) if (r.status === "aktuell" && r.online) hatAktuelle.add(r.online.schluessel);
  for (const r of ergebnis.values()) {
    if (r.online && hatAktuelle.has(r.online.schluessel) && ["neu", "abweichend", "vermutet"].includes(r.status)) {
      r.status = "ersetzt";
    }
  }
  return ergebnis;
}

/** Online-Dokumente, die neu erschienen sind und nicht in der eigenen Sammlung liegen. */
export function neuOnline(versionen, abgleich) {
  if (!versionen?.dokumente) return [];
  const vorhanden = new Set();
  for (const r of abgleich.values()) if (r.online) vorhanden.add(r.online.schluessel);
  const basis = Date.parse(versionen.basis || versionen.stand || 0) + 36 * 3600 * 1000;
  return versionen.dokumente
    .filter((d) => !d.entfernt && (d.dateien || []).length && !vorhanden.has(d.schluessel))
    .filter((d) => d.neu_markiert || Date.parse(d.erstmals || 0) > basis || Date.parse(d.aktualisiert || 0) > basis)
    .sort((a, b) => (b.aktualisiert || b.erstmals || "").localeCompare(a.aktualisiert || a.erstmals || ""));
}

export { fingerabdruck };
