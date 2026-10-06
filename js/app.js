// Leitlinien – App-Logik
import * as db from "./db.js";
import { suchen, ausschnitt, falte, alleFundstellen, anfrageZerlegen, titelWoerter } from "./text.js";
import { textAuslesen, sha256, pdfOeffnen, pdfSchliessen, seiteZeichnen } from "./pdf.js";
import { versionenLaden, abgleichen, neuOnline, STATUS, fingerabdruck, dateiname } from "./versionen.js";

// ---------- Hilfen ----------

const APP_VERSION = "2026-10-06.2";

const $ = (s) => document.querySelector(s);

function h(tag, eig, ...kinder) {
  const el = document.createElement(tag);
  if (eig) {
    for (const [k, v] of Object.entries(eig)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kind of kinder.flat(Infinity)) {
    if (kind === null || kind === undefined || kind === false) continue;
    el.append(kind instanceof Node ? kind : String(kind));
  }
  return el;
}

const SYMBOLE = {
  landolt: '<svg class="landolt" viewBox="0 0 24 24" aria-hidden="true"><g class="landolt-luecke-gruppe"><circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="3.6" stroke-dasharray="41.6 3.64" transform="rotate(-59.5 12 12)"/></g></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10.8v6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.15" fill="currentColor"/></svg>',
};

function lupenmarke() {
  const t = document.createElement("template");
  t.innerHTML = '<svg class="lupenmarke" viewBox="0 0 32 32" aria-hidden="true"><use href="#lupenmarke"/></svg>';
  return t.content.firstElementChild;
}

function symbol(name, klasse) {
  const t = document.createElement("template");
  t.innerHTML = SYMBOLE[name];
  const el = t.content.firstElementChild;
  if (klasse) el.classList.add(...klasse.split(" "));
  return el;
}

const fmtDatum = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtZeit = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const fmtZahl = new Intl.NumberFormat("de-DE");

function wann(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const tag = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const tage = Math.round((tag(new Date()) - tag(d)) / 864e5);
  if (tage === 0) return `heute, ${fmtZeit.format(d)} Uhr`;
  if (tage === 1) return `gestern, ${fmtZeit.format(d)} Uhr`;
  return `${fmtDatum.format(d)}, ${fmtZeit.format(d)} Uhr`;
}

function datum(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : fmtDatum.format(d);
}

function groesse(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024 * 1024) return `${fmtZahl.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

const mehrzahl = (n, eins, viele) => `${fmtZahl.format(n)} ${n === 1 ? eins : viele}`;

function istIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function istApp() {
  return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

let meldungsUhr;
function meldung(text) {
  const el = $("#meldung");
  el.textContent = text;
  el.classList.add("sichtbar");
  clearTimeout(meldungsUhr);
  meldungsUhr = setTimeout(() => el.classList.remove("sichtbar"), 4000);
}

function lokalSpeicher(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch { /* privat/gesperrt */ }
  return null;
}

// ---------- Zustand ----------

const zustand = {
  dokumente: new Map(), // id → Metadaten
  index: new Map(), // id → { anzeige: [], norm: [], titelNorm }
  versionen: null,
  versionenOffline: false,
  versionenFehler: null,
  versionenGeladenUm: 0,
  abgleich: new Map(),
  anfrage: "",
  ergebnis: null,
  grenze: 25,
  aufgeklappt: new Set(),
  importLaeuft: false,
};

const abgleichVon = (id) => zustand.abgleich.get(id) || { status: "unbekannt" };

const titelBereinigen = (t) => (t || "").replace(/,?\s*NEU!?\s*$/i, "").replace(/\s+NEU!?(?=\s|$)/gi, " ").trim();
const titelOhneJahr = (t) => titelBereinigen(t).replace(/\s*\(\s*\d{4}(\s*\/\s*\d{4})?\s*\)\s*/g, " ").replace(/\s+(19|20)\d{2}$/, "").trim();

function titelAusDateiname(name) {
  return (name || "Ohne Titel")
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/(\p{L})-(?=\p{L})/gu, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function sinnvollerTitel(t) {
  t = (t || "").trim();
  if (t.length < 8 || !/\s/.test(t)) return "";
  if (/microsoft|\.docx?\b|\.indd\b|untitled|unbenannt|^folie|^präsentation|^layout|^dokument\s*\d*$/i.test(t)) return "";
  return t;
}

function anzeigeTitel(meta) {
  if (!meta) return "";
  const r = abgleichVon(meta.id);
  if (r.online) {
    if (r.status === "aktuell" || r.status === "entfernt") return titelBereinigen(r.online.titel);
    if (["neu", "abweichend", "ersetzt"].includes(r.status)) return titelOhneJahr(r.online.titel);
  }
  return meta.titel || titelAusDateiname(meta.dateiname);
}

function onlineVerweis(d) {
  const datei = (d.dateien || [])[0];
  return datei ? datei.url : d.seite;
}

// ---------- Start ----------

async function start() {
  ereignisseBinden();
  serviceWorker();
  try {
    await bibliothekLaden();
  } catch (e) {
    console.error(e);
    meldung("Die gespeicherten Dokumente konnten nicht geladen werden.");
  }
  try {
    const gemerkt = await db.kvHolen("versionen");
    if (gemerkt) zustand.versionen = gemerkt;
  } catch { /* noch nichts gespeichert */ }
  neuAbgleichen();
  zeichnen();
  versionenAktualisieren();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - zustand.versionenGeladenUm > 5 * 60 * 1000) versionenAktualisieren();
  });
}

function serviceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hatteSteuerung = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service Worker:", e));
  let neu = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hatteSteuerung || neu) return;
    neu = true;
    if (!b.offen && !zustand.importLaeuft) location.reload();
  });
}

async function bibliothekLaden() {
  const [metas, texte] = await Promise.all([db.alle("dokumente"), db.alle("texte")]);
  const texteNachId = new Map(texte.map((t) => [t.id, t.seiten]));
  for (const meta of metas) {
    zustand.dokumente.set(meta.id, meta);
    const seiten = texteNachId.get(meta.id) || [];
    zustand.index.set(meta.id, { anzeige: seiten, norm: seiten.map(falte), titelNorm: "" });
  }
}

async function versionenAktualisieren() {
  zustand.versionenGeladenUm = Date.now();
  try {
    const v = await versionenLaden();
    zustand.versionen = v;
    zustand.versionenOffline = false;
    zustand.versionenFehler = null;
    db.kvSetzen("versionen", v).catch(() => {});
  } catch (e) {
    zustand.versionenFehler = e;
    zustand.versionenOffline = !!zustand.versionen;
  }
  neuAbgleichen();
  zeichnen();
}

function neuAbgleichen() {
  zustand.abgleich = zustand.versionen ? abgleichen([...zustand.dokumente.values()], zustand.versionen) : new Map();
  for (const [id, e] of zustand.index) e.titelNorm = falte(anzeigeTitel(zustand.dokumente.get(id)));
  if (zustand.anfrage) zustand.ergebnis = suchen(zustand.index, zustand.anfrage);
}

// ---------- Darstellung ----------

function zeichnen() {
  const main = $("#inhalt");
  const teile = zustand.anfrage ? ergebnisAnsicht() : startAnsicht();
  main.replaceChildren(...teile.filter(Boolean));
  $("#hinzufuegen").hidden = !zustand.dokumente.size || !!zustand.anfrage;
  $("#such-leeren").hidden = !$("#suchfeld").value;
}

function sortiert() {
  return [...zustand.dokumente.values()].sort((a, b) =>
    anzeigeTitel(a).localeCompare(anzeigeTitel(b), "de", { sensitivity: "base", numeric: true }));
}

function startAnsicht() {
  const teile = [];
  if (istIOS() && !istApp() && !lokalSpeicher("hinweis-installiert")) teile.push(installHinweis());
  if (!zustand.dokumente.size) {
    teile.push(
      h("div", { class: "leer" },
        lupenmarke(),
        h("h2", null, "Noch keine Leitlinien gespeichert"),
        h("p", null, "Wähle die PDFs aus deinem Leitlinien-Ordner aus. Sie bleiben nur auf diesem iPhone und sind danach durchsuchbar, auch offline."),
        h("button", { class: "knopf", type: "button", onclick: dateiWahl }, "PDFs auswählen")),
    );
    teile.push(onlineAbschnitt(true), fusszeile());
    return teile;
  }

  const alle = sortiert();
  const neue = alle.filter((m) => abgleichVon(m.id).status === "neu");
  if (neue.length) {
    teile.push(
      h("section", { class: "band", "aria-labelledby": "band-titel" },
        h("h2", { id: "band-titel" }, neue.length === 1 ? "Neue Version verfügbar" : `${neue.length} neue Versionen verfügbar`),
        h("p", null, "Für diese gespeicherten Dokumente gibt es bei DOG und BVA eine neuere Fassung."),
        h("ul", { class: "liste" }, neue.map((m) => h("li", null, zeile(m, { details: true }))))),
    );
  }

  teile.push(
    h("section", { class: "abschnitt" },
      h("div", { class: "abschnitt-kopf" }, h("h2", null, `Gespeichert (${fmtZahl.format(alle.length)})`)),
      h("ul", { class: "liste" }, alle.map((m) => h("li", null, zeile(m))))),
  );
  teile.push(onlineAbschnitt(false), fusszeile());
  return teile;
}

function zeile(meta, { details = false } = {}) {
  const r = abgleichVon(meta.id);
  const st = STATUS[r.status] || STATUS.unbekannt;
  return h("div", { class: "zeile" },
    h("button", {
      class: "zeile-haupt", type: "button",
      onclick: () => (details ? detailsZeigen(meta.id) : betrachterOeffnen(meta.id, 1)),
    },
      h("span", { class: "dok-titel" }, anzeigeTitel(meta)),
      h("span", { class: "zeile-unter" },
        h("span", { class: `status status-${st.ton}` }, st.text),
        h("span", null, mehrzahl(meta.seiten || 0, "Seite", "Seiten")))),
    h("button", { class: "info-knopf", type: "button", "aria-label": `Details zu ${anzeigeTitel(meta)}`, onclick: () => detailsZeigen(meta.id) }, symbol("info")),
  );
}

function installHinweis() {
  return h("section", { class: "band band-dezent" },
    h("h2", null, "Als App auf den Home-Bildschirm"),
    h("p", null, "In Safari unten auf Teilen tippen, dann „Zum Home-Bildschirm“. Danach die App über das neue Symbol öffnen und dort die PDFs hinzufügen – Safari und die App haben getrennte Speicher."),
    h("button", { class: "textknopf", type: "button", onclick: () => { lokalSpeicher("hinweis-installiert", "1"); zeichnen(); } }, "Hinweis ausblenden"),
  );
}

function onlineAbschnitt(leer) {
  const v = zustand.versionen;
  const anzahl = (v?.dokumente || []).filter((d) => !d.entfernt).length;
  if (!anzahl) return null;
  const neue = leer ? [] : neuOnline(v, zustand.abgleich).slice(0, 6);
  if (!leer && !neue.length) return null;
  return h("section", { class: "abschnitt" },
    h("div", { class: "abschnitt-kopf" },
      h("h2", null, leer ? "Bei DOG und BVA" : "Neu bei DOG und BVA"),
      h("button", { class: "textknopf", type: "button", onclick: onlineListeZeigen }, `Alle ${fmtZahl.format(anzahl)} ansehen`)),
    leer ? h("p", { class: "hinweis-text" }, `${mehrzahl(anzahl, "Leitlinie, Stellungnahme oder Empfehlung", "Leitlinien, Stellungnahmen und Empfehlungen")} zum Herunterladen.`) : null,
    neue.length ? h("ul", { class: "liste" }, neue.map((d) => h("li", null, onlineZeile(d)))) : null,
  );
}

function onlineZeile(d, gespeichert) {
  return h("a", { class: "zeile-haupt", href: onlineVerweis(d), target: "_blank", rel: "noopener" },
    h("span", { class: "dok-titel" }, titelBereinigen(d.titel)),
    h("span", { class: "zeile-unter" },
      gespeichert ? h("span", { class: `status status-${(STATUS[gespeichert] || STATUS.unbekannt).ton}` }, gespeichert === "aktuell" ? "Gespeichert" : STATUS[gespeichert].text) : null,
      h("span", null, [d.art, (d.kategorien || [])[0]].filter(Boolean).join(", ")),
      (d.dateien || []).length ? null : h("span", null, "nur Webseite")));
}

function fusszeile() {
  const v = zustand.versionen;
  const zeilen = [];
  if (!v) {
    zeilen.push(zustand.versionenFehler ? "Die Versionsliste ist gerade nicht erreichbar." : "Versionsliste wird geladen …");
  } else if (!v.stand) {
    zeilen.push("Die automatische Versionsprüfung ist noch nicht gelaufen.");
  } else {
    zeilen.push(`Versionsprüfung bei DOG und BVA: ${wann(v.stand)}.`);
    if (Date.now() - Date.parse(v.stand) > 3 * 864e5) zeilen.push("Die Prüfung ist seit mehreren Tagen nicht gelaufen.");
    if ((v.quellen || []).some((q) => !q.ok)) zeilen.push("Die letzte Prüfung war unvollständig, die vorherigen Angaben bleiben gültig.");
    if (zustand.versionenOffline) zeilen.push("Offline – es gilt der zuletzt geladene Stand.");
  }
  zeilen.push(`App-Version ${APP_VERSION}`);
  if (zustand.dokumente.size) {
    let seiten = 0, bytes = 0;
    for (const m of zustand.dokumente.values()) { seiten += m.seiten || 0; bytes += m.groesse || 0; }
    zeilen.push(`${mehrzahl(zustand.dokumente.size, "Dokument", "Dokumente")} mit ${mehrzahl(seiten, "Seite", "Seiten")} (${groesse(bytes)}), nur auf diesem Gerät gespeichert.`);
  }
  return h("footer", { class: "fuss" }, zeilen.map((z) => h("p", null, z)));
}

// ---------- Suche ----------

let suchUhr;
function sucheAnstossen() {
  clearTimeout(suchUhr);
  suchUhr = setTimeout(sucheAusfuehren, 140);
  $("#such-leeren").hidden = !$("#suchfeld").value;
}

function sucheAusfuehren() {
  const q = $("#suchfeld").value.trim();
  if (q !== zustand.anfrage) {
    zustand.grenze = 25;
    zustand.aufgeklappt.clear();
  }
  zustand.anfrage = q;
  zustand.ergebnis = q ? suchen(zustand.index, q) : null;
  zeichnen();
  if (!q) window.scrollTo(0, 0);
}

function ergebnisAnsicht() {
  const e = zustand.ergebnis;
  if (!zustand.dokumente.size) {
    return [h("p", { class: "hinweis-text" }, "Noch keine PDFs gespeichert. Füge zuerst deine Leitlinien hinzu."),
      h("button", { class: "knopf", type: "button", onclick: dateiWahl }, "PDFs auswählen")];
  }
  if (!e) return [];
  if (!e.dokumente.length) {
    return [h("div", { class: "leer" },
      h("h2", null, "Keine Fundstelle"),
      h("p", null, `„${zustand.anfrage}“ kommt in deinen ${mehrzahl(zustand.dokumente.size, "Dokument", "Dokumenten")} nicht vor. Ein Wortteil findet mehr, z. B. „Glaukom“ findet auch „Normaldruckglaukom“.`))];
  }
  const teile = [
    h("p", { class: "ergebnis-kopf" },
      h("strong", null, mehrzahl(e.gesamt, "Fundstelle", "Fundstellen")),
      ` in ${mehrzahl(e.dokumente.length, "Dokument", "Dokumenten")}`),
  ];
  if (e.modus === "einzelne") {
    teile.push(h("p", { class: "hinweis-text" }, "Keine Seite enthält alle Begriffe. Angezeigt werden Seiten mit einzelnen Begriffen."));
  }
  for (const d of e.dokumente.slice(0, zustand.grenze)) teile.push(gruppe(d, e.begriffe));
  if (e.dokumente.length > zustand.grenze) {
    teile.push(h("button", { class: "mehr-seiten", type: "button", onclick: () => { zustand.grenze += 25; zeichnen(); } },
      `Weitere ${mehrzahl(e.dokumente.length - zustand.grenze, "Dokument", "Dokumente")} zeigen`));
  }
  return teile;
}

function gruppe(d, begriffe) {
  const meta = zustand.dokumente.get(d.id);
  const eintrag = zustand.index.get(d.id);
  const offen = zustand.aufgeklappt.has(d.id);
  const seiten = offen ? d.seiten : d.seiten.slice(0, 3);
  const r = abgleichVon(d.id);
  return h("section", { class: "gruppe" },
    h("div", { class: "gruppe-kopf" },
      h("span", { class: "dok-titel" }, anzeigeTitel(meta)),
      h("span", { class: "anzahl" }, mehrzahl(d.seitenGesamt, "Seite", "Seiten"))),
    r.status === "neu" ? h("p", { class: "hinweis-text" }, h("span", { class: "status status-warnung" }, "Neue Version verfügbar"), " Diese Fassung ist veraltet.") : null,
    seiten.map((s) => trefferZeile(d.id, s, eintrag, begriffe)),
    d.seiten.length > 3 && !offen
      ? h("button", { class: "mehr-seiten", type: "button", onclick: () => { zustand.aufgeklappt.add(d.id); zeichnen(); } },
        `${mehrzahl(d.seiten.length - 3, "weitere Seite", "weitere Seiten")} zeigen`)
      : null,
  );
}

function trefferZeile(id, s, eintrag, begriffe) {
  const a = ausschnitt(eintrag.anzeige[s.seite - 1] || "", s);
  return h("button", {
    class: "treffer", type: "button",
    onclick: () => {
      const stellen = alleFundstellen(begriffe, eintrag.norm[s.seite - 1] || "");
      const ziel = s.fenster ? s.fenster[0] : 0;
      const k = Math.max(0, stellen.findIndex(([anf, end]) => end > ziel));
      betrachterOeffnen(id, s.seite, { trefferAufSeite: k });
    },
  },
    h("span", { class: "seitenzahl" }, `S. ${s.seite}`),
    h("span", { class: "stelle" },
      a.vorne ? "… " : "",
      a.teile.map((t) => (t.markiert ? h("mark", null, t.text) : t.text)),
      a.hinten ? " …" : ""),
  );
}

// ---------- Import ----------

function dateiWahl() {
  const eingabe = $("#datei-eingabe");
  eingabe.value = "";
  eingabe.click();
}

async function importieren(dateien) {
  const liste = [...dateien].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!liste.length) {
    meldung("Keine PDF-Dateien ausgewählt.");
    return;
  }
  zustand.importLaeuft = true;
  db.dauerhaftAnfordern();
  const anzeige = importBlatt(liste.length);
  let neu = 0, doppelt = 0;
  const fehler = [], ohneText = [];
  const imStapel = new Set();

  for (let i = 0; i < liste.length; i++) {
    const datei = liste[i];
    anzeige.stand(i, datei.name, 0, 0);
    let schritt = "Datei lesen";
    try {
      const buffer = await datei.arrayBuffer();
      schritt = "Prüfsumme";
      const id = await sha256(buffer);
      if (zustand.dokumente.has(id) || imStapel.has(id)) { doppelt++; continue; }
      imStapel.add(id);
      schritt = "PDF auswerten";
      const { seiten, titel } = await textAuslesen(buffer, (s, n) => anzeige.stand(i, datei.name, s, n));
      const zeichen = seiten.reduce((summe, s) => summe + s.length, 0);
      const meta = {
        id,
        dateiname: datei.name,
        groesse: datei.size,
        seiten: seiten.length,
        zeichen,
        titel: sinnvollerTitel(titel),
        ersteSeite: seiten.slice(0, 2).join(" ").slice(0, 1500),
        hinzugefuegt: new Date().toISOString(),
        dateiDatum: datei.lastModified ? new Date(datei.lastModified).toISOString() : null,
      };
      schritt = "Speichern";
      await db.dokumentSpeichern(meta, buffer, seiten);
      zustand.dokumente.set(id, meta);
      zustand.index.set(id, { anzeige: seiten, norm: seiten.map(falte), titelNorm: "" });
      neu++;
      if (zeichen < 40 * Math.max(1, seiten.length)) ohneText.push(datei.name);
    } catch (e) {
      console.error(datei.name, e);
      const wo = e?.schritt || schritt;
      fehler.push({ name: datei.name, grund: fehlerText(e, wo), technik: technikText(e, wo) });
    }
  }

  zustand.importLaeuft = false;
  anzeige.schliessen();
  neuAbgleichen();
  zeichnen();
  importErgebnis({ neu, doppelt, fehler, ohneText, gesamt: liste.length });
}

function fehlerText(e, schritt) {
  const n = e?.name || "";
  if (n === "PasswordException") return "Das PDF ist mit einem Passwort geschützt.";
  if (n === "InvalidPDFException") return "Die Datei ist kein gültiges PDF.";
  if (n === "QuotaExceededError") return "Der Speicher auf dem Gerät ist voll.";
  if (schritt === "Datei lesen") return "Die Datei ließ sich nicht öffnen. Liegt sie nur in der Cloud? Dann in der Dateien-App einmal antippen und erneut hinzufügen.";
  if (schritt === "Speichern") return "Die Datei konnte nicht in der App gespeichert werden.";
  return "Die Datei konnte nicht gelesen werden.";
}

/** Kurze technische Angabe für die Fehlersuche (Schritt, Fehlerart, Meldung). */
function technikText(e, schritt) {
  const name = e?.name || (typeof e === "object" ? e?.constructor?.name : "") || "Fehler";
  const text = String(e?.message ?? e ?? "").replace(/\s+/g, " ").slice(0, 220);
  return `${schritt} – ${name}${text ? `: ${text}` : ""}`;
}

function importBlatt(gesamt) {
  const kreis = symbol("landolt");
  const status = h("div", { class: "import-status dreht" }, kreis, h("div", null,
    h("div", { id: "imp-zaehler" }, `Dokument 1 von ${gesamt}`),
    h("div", { class: "datei", id: "imp-datei" }, "")));
  const balken = h("div");
  const inhalt = h("div", null,
    h("p", null, "Die Texte werden auf diesem iPhone ausgelesen. Bitte die App so lange geöffnet lassen."),
    status,
    h("div", { class: "fortschritt" }, balken));
  const bl = blatt("PDFs werden eingelesen", inhalt, { ohneSchliessen: true });
  return {
    stand(i, name, s, n) {
      $("#imp-zaehler").textContent = `Dokument ${i + 1} von ${gesamt}`;
      $("#imp-datei").textContent = n ? `${name}, Seite ${s} von ${n}` : name;
      const anteil = (i + (n ? s / n : 0)) / gesamt;
      balken.style.width = `${Math.round(anteil * 100)}%`;
    },
    schliessen: bl.schliessen,
  };
}

function importErgebnis({ neu, doppelt, fehler, ohneText }) {
  const teile = [];
  if (neu) teile.push(h("p", null, `${mehrzahl(neu, "Dokument", "Dokumente")} eingelesen und durchsuchbar.`));
  if (doppelt) teile.push(h("p", null, `${mehrzahl(doppelt, "Dokument war", "Dokumente waren")} schon gespeichert und wurden übersprungen.`));
  if (ohneText.length) {
    teile.push(h("h3", null, "Kaum Text gefunden"),
      h("p", null, "Diese Dateien sind vermutlich eingescannt. Sie werden gespeichert, aber die Suche findet darin wenig:"),
      h("ul", { class: "schritte" }, ohneText.map((n) => h("li", null, n))));
  }
  if (fehler.length) {
    teile.push(h("h3", null, "Nicht eingelesen"),
      h("ul", { class: "schritte" }, fehler.map((f) => h("li", null, `${f.name}: ${f.grund}`,
        f.technik ? h("span", { class: "technik" }, f.technik) : null))),
      h("div", { class: "technik technik-abstand" }, `App-Version ${APP_VERSION}, ${navigator.userAgent}`));
  }
  if (!neu && !doppelt && !fehler.length) teile.push(h("p", null, "Es wurde nichts eingelesen."));
  if (neu === 1 && !doppelt && !fehler.length && !ohneText.length) {
    meldung("1 Dokument eingelesen.");
    return;
  }
  blatt("Einlesen abgeschlossen", h("div", null, teile));
}

// ---------- Blatt (Dialog) ----------

function blatt(titel, inhalt, { ohneSchliessen = false, fertig = "Fertig" } = {}) {
  const vorher = document.activeElement;
  const grund = h("div", { class: "blatt-grund" });
  const schliessen = () => {
    grund.remove();
    if (!document.querySelector(".blatt-grund")) document.documentElement.style.overflow = "";
    vorher?.focus?.({ preventScroll: true });
  };
  const box = h("div", { class: "blatt", role: "dialog", "aria-modal": "true", "aria-label": titel },
    h("div", { class: "blatt-kopf" },
      h("h2", null, titel),
      ohneSchliessen ? null : h("button", { class: "textknopf", type: "button", onclick: schliessen }, fertig)),
    h("div", { class: "blatt-inhalt" }, inhalt));
  grund.append(box);
  if (!ohneSchliessen) {
    grund.addEventListener("click", (e) => { if (e.target === grund) schliessen(); });
    grund.addEventListener("keydown", (e) => { if (e.key === "Escape") schliessen(); });
  }
  document.body.append(grund);
  document.documentElement.style.overflow = "hidden";
  box.setAttribute("tabindex", "-1");
  box.focus({ preventScroll: true });
  return { schliessen, box };
}

// ---------- Details zu einem gespeicherten Dokument ----------

const GRUENDE = {
  groesse: "erkannt an der Dateigröße",
  "groesse-unsicher": "gleiche Dateigröße, aber anderer Titel",
  dateiname: "erkannt am Dateinamen",
  register: "erkannt an der AWMF-Registernummer",
  titel: "vermutet anhand des Titels",
  bestaetigt: "von dir bestätigt",
  zugeordnet: "von dir zugeordnet",
};

async function metaAendern(id, aenderung) {
  const meta = { ...zustand.dokumente.get(id), ...aenderung };
  for (const [k, v] of Object.entries(aenderung)) if (v === undefined) delete meta[k];
  await db.setzen("dokumente", meta);
  zustand.dokumente.set(id, meta);
  neuAbgleichen();
  zeichnen();
}

function detailsZeigen(id) {
  const meta = zustand.dokumente.get(id);
  if (!meta) return;
  const r = abgleichVon(id);
  const d = r.online;
  const st = STATUS[r.status] || STATUS.unbekannt;
  let bl;
  const knopf = (text, aktion, klasse = "knopf knopf-zweit") => h("button", { class: klasse, type: "button", onclick: aktion }, text);
  const link = (text, href, klasse = "knopf knopf-zweit") => h("a", { class: klasse, href, target: "_blank", rel: "noopener" }, text);

  const erklaerung = {
    aktuell: "Deine Datei entspricht der Fassung, die DOG und BVA aktuell veröffentlichen.",
    neu: "Bei DOG und BVA gibt es eine neuere Fassung. Öffne sie, sichere sie über Teilen › „In Dateien sichern“ in deinem Ordner und füge sie hier hinzu.",
    abweichend: "Online liegt eine andere Datei als deine – meist eine neuere oder korrigierte Fassung.",
    vermutet: d ? `Das ist vermutlich „${titelBereinigen(d.titel)}“. Stimmt das?` : "",
    ersetzt: "Die aktuelle Fassung dieses Dokuments ist bereits gespeichert. Diese ältere Datei kannst du löschen.",
    entfernt: "Dieses Dokument wird bei DOG und BVA nicht mehr aufgeführt. Möglicherweise wurde es zurückgezogen oder ersetzt.",
    unbekannt: "Diese Datei ist keinem Dokument von DOG und BVA zugeordnet und wird nicht auf neue Versionen geprüft.",
  }[r.status];

  const teile = [
    h("p", { class: "blatt-titel" }, anzeigeTitel(meta)),
    h("p", null, h("span", { class: `status status-${st.ton}` }, st.text), r.grund && GRUENDE[r.grund] ? h("span", { class: "hinweis-text" }, `  ${GRUENDE[r.grund]}`) : null),
    erklaerung ? h("p", null, erklaerung) : null,
  ];

  const aktionen = [];
  if (d && ["neu", "abweichend", "entfernt"].includes(r.status) && onlineVerweis(d)) aktionen.push(link("Neue Fassung öffnen", onlineVerweis(d), "knopf"));
  if (r.status === "abweichend" && d) {
    aktionen.push(knopf("Ist dieselbe Fassung", async () => { await metaAendern(id, { zuordnung: d.schluessel, bestaetigt: fingerabdruck(d) }); bl.schliessen(); meldung("Als aktuell bestätigt."); }));
  }
  if (r.status === "vermutet" && d) {
    aktionen.push(knopf("Ja, gleiche Fassung", async () => { await metaAendern(id, { zuordnung: d.schluessel, bestaetigt: fingerabdruck(d) }); bl.schliessen(); }, "knopf"));
    aktionen.push(knopf("Ja, aber ältere Fassung", async () => { await metaAendern(id, { zuordnung: d.schluessel, bestaetigt: "veraltet" }); bl.schliessen(); }));
  }
  if (r.status === "ersetzt") {
    aktionen.push(knopf("Ältere Fassung löschen", () => loeschen(id, bl), "knopf knopf-gefahr"));
  }
  if (aktionen.length) teile.push(h("div", { class: "knopfreihe" }, aktionen));

  if (d) {
    teile.push(h("h3", null, "Bei DOG und BVA"));
    const zeilen = [["Titel", titelBereinigen(d.titel)]];
    if (d.art) zeilen.push(["Art", d.art]);
    if ((d.kategorien || []).length) zeilen.push(["Thema", d.kategorien.join("; ")]);
    if (d.register?.nummer) zeilen.push(["AWMF-Register", d.register.nummer]);
    if (d.register?.stand) zeilen.push(["Stand", d.register.stand]);
    if (d.register?.gueltig_bis) zeilen.push(["Gültig bis", d.register.gueltig_bis]);
    if (d.aktualisiert) zeilen.push(["Neue Fassung erkannt", datum(d.aktualisiert)]);
    teile.push(h("dl", { class: "daten" }, zeilen.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])));
    const verweise = [];
    if (d.seite) verweise.push(link("Seite bei der DOG", d.seite));
    (d.dateien || []).slice(0, 3).forEach((f) => verweise.push(link(f.bezeichnung && f.bezeichnung !== "PDF" ? `PDF: ${f.bezeichnung}` : "PDF öffnen", f.url)));
    if (verweise.length) teile.push(h("div", { class: "knopfreihe" }, verweise));
  }

  teile.push(h("h3", null, "Deine Datei"));
  teile.push(h("dl", { class: "daten" }, [
    ["Dateiname", meta.dateiname],
    ["Größe", groesse(meta.groesse)],
    ["Seiten", fmtZahl.format(meta.seiten || 0)],
    ["Hinzugefügt", datum(meta.hinzugefuegt)],
  ].flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])));

  const weitere = [
    knopf("Öffnen", () => { bl.schliessen(); betrachterOeffnen(id, 1); }, "knopf"),
    knopf(d ? "Anders zuordnen" : "Zuordnen", () => { bl.schliessen(); zuordnenZeigen(id); }),
  ];
  if (meta.zuordnung) weitere.push(knopf("Zuordnung aufheben", async () => { await metaAendern(id, { zuordnung: undefined, bestaetigt: undefined }); bl.schliessen(); }));
  else if (r.status !== "unbekannt") weitere.push(knopf("Nicht überwachen", async () => { await metaAendern(id, { zuordnung: "-", bestaetigt: undefined }); bl.schliessen(); }));
  if (r.status !== "ersetzt") weitere.push(knopf("Löschen", () => loeschen(id, bl), "knopf knopf-gefahr"));
  teile.push(h("div", { class: "knopfreihe" }, weitere));

  bl = blatt("Details", h("div", null, teile));
}

async function loeschen(id, bl) {
  const meta = zustand.dokumente.get(id);
  if (!confirm(`„${anzeigeTitel(meta)}“ von diesem iPhone löschen?`)) return;
  await db.dokumentLoeschen(id);
  zustand.dokumente.delete(id);
  zustand.index.delete(id);
  if (b.id === id) { await pdfSchliessen(b.pdf); b.pdf = null; b.id = null; }
  bl?.schliessen();
  neuAbgleichen();
  zeichnen();
  meldung("Gelöscht.");
}

function zuordnenZeigen(id) {
  const meta = zustand.dokumente.get(id);
  const v = zustand.versionen;
  const kandidaten = (v?.dokumente || []).filter((d) => !d.entfernt && (d.dateien || []).length);
  if (!kandidaten.length) {
    blatt("Zuordnen", h("p", null, "Die Versionsliste ist noch nicht verfügbar. Bitte später erneut versuchen."));
    return;
  }
  const eigene = titelWoerter(`${meta.dateiname} ${meta.titel || ""} ${meta.ersteSeite || ""}`);
  const wertung = (d) => {
    const w = titelWoerter(titelOhneJahr(d.titel));
    let t = 0;
    for (const x of w) if (eigene.has(x)) t++;
    return w.size ? t / w.size : 0;
  };
  const sortierteListe = kandidaten.map((d) => ({ d, s: wertung(d) }))
    .sort((a, b) => b.s - a.s || a.d.titel.localeCompare(b.d.titel, "de"));
  const liste = h("ul", { class: "liste" });
  let bl;
  const fuellen = (filter) => {
    const f = falte(filter.trim());
    const treffer = sortierteListe.filter(({ d }) => !f || falte(d.titel).includes(f)).slice(0, 60);
    liste.replaceChildren(...treffer.map(({ d }) => h("li", null,
      h("button", { class: "zeile-haupt", type: "button", onclick: () => { bl.schliessen(); zuordnungBestaetigen(id, d); } },
        h("span", { class: "dok-titel" }, titelBereinigen(d.titel)),
        h("span", { class: "zeile-unter" }, [d.art, (d.kategorien || [])[0]].filter(Boolean).join(", "))))));
  };
  const filter = h("input", { class: "filter", type: "search", placeholder: "Titel filtern", "aria-label": "Titel filtern" });
  filter.addEventListener("input", () => fuellen(filter.value));
  fuellen("");
  bl = blatt("Dokument zuordnen", h("div", null,
    h("p", null, `Zu welchem Dokument von DOG und BVA gehört „${meta.dateiname}“? Die passendsten stehen oben.`),
    filter, liste));
}

function zuordnungBestaetigen(id, d) {
  let bl;
  bl = blatt("Gleiche Fassung?", h("div", null,
    h("p", null, `Ist deine Datei dieselbe Fassung wie die aktuelle von „${titelBereinigen(d.titel)}“?`),
    h("div", { class: "knopfreihe" },
      h("button", { class: "knopf", type: "button", onclick: async () => { await metaAendern(id, { zuordnung: d.schluessel, bestaetigt: fingerabdruck(d) }); bl.schliessen(); meldung("Zugeordnet, als aktuell markiert."); } }, "Ja, dieselbe Fassung"),
      h("button", { class: "knopf knopf-zweit", type: "button", onclick: async () => { await metaAendern(id, { zuordnung: d.schluessel, bestaetigt: undefined }); bl.schliessen(); meldung("Zugeordnet."); } }, "Nein oder unklar"))));
}

function onlineListeZeigen() {
  const v = zustand.versionen;
  const alle = (v?.dokumente || []).filter((d) => !d.entfernt).sort((a, b) => titelBereinigen(a.titel).localeCompare(titelBereinigen(b.titel), "de"));
  const gespeichert = new Map();
  for (const r of zustand.abgleich.values()) if (r.online) gespeichert.set(r.online.schluessel, r.status);
  const liste = h("ul", { class: "liste" });
  const fuellen = (filter) => {
    const f = falte(filter.trim());
    const treffer = alle.filter((d) => !f || falte(`${d.titel} ${(d.kategorien || []).join(" ")}`).includes(f));
    liste.replaceChildren(...treffer.map((d) => h("li", null, onlineZeile(d, gespeichert.get(d.schluessel)))));
  };
  const filter = h("input", { class: "filter", type: "search", placeholder: "Titel oder Thema filtern", "aria-label": "Titel oder Thema filtern" });
  filter.addEventListener("input", () => fuellen(filter.value));
  fuellen("");
  blatt("DOG und BVA", h("div", null,
    h("p", null, "Leitlinien, Stellungnahmen und Empfehlungen. Tippe auf einen Titel, um das PDF zu öffnen, und sichere es dann über Teilen › „In Dateien sichern“ in deinem Ordner."),
    filter, liste));
}

async function hilfeZeigen() {
  const belegung = await db.speicherbelegung();
  const v = zustand.versionen;
  const teile = [
    h("h3", null, "PDFs hinzufügen"),
    h("ol", { class: "schritte" },
      h("li", null, "„PDFs hinzufügen“ antippen, dann „Durchsuchen“."),
      h("li", null, "Deinen Leitlinien-Ordner öffnen, oben rechts „Auswählen“ und „Alle auswählen“."),
      h("li", null, "„Öffnen“ antippen. Schon gespeicherte Dateien werden übersprungen.")),
    h("h3", null, "Suchen"),
    h("p", null, "Mehrere Wörter müssen alle auf derselben Seite stehen. \"In Anführungszeichen\" sucht die genaue Wortfolge. Groß- und Kleinschreibung, Umlaute und Silbentrennung spielen keine Rolle, Wortteile genügen."),
    h("h3", null, "Neue Versionen"),
    h("p", null, "Jeden Morgen wird automatisch die Liste der Leitlinien, Stellungnahmen und Empfehlungen von DOG und BVA geprüft, einschließlich der Fassungen im AWMF-Register. Abgefragt werden nur Titel, Datum und Dateigröße der PDFs."),
    h("p", null, v?.stand ? `Letzte Prüfung: ${wann(v.stand)}.` : "Die Prüfung ist noch nicht gelaufen."),
    h("h3", null, "Neue Fassung speichern"),
    h("ol", { class: "schritte" },
      h("li", null, "Bei der Leitlinie „Neue Fassung öffnen“ antippen."),
      h("li", null, "Im PDF auf Teilen tippen und „In Dateien sichern“ wählen, in deinen Ordner."),
      h("li", null, "Hier „PDFs hinzufügen“ und die alte Fassung danach löschen.")),
    h("h3", null, "Datenschutz"),
    h("p", null, "Deine PDFs und ihr Text bleiben auf diesem Gerät. Die App lädt aus dem Internet nur die Versionsliste."),
  ];
  if (belegung?.usage) teile.push(h("p", { class: "hinweis-text" }, `Belegter Speicher: ${groesse(belegung.usage)}.`));
  let bl;
  if (zustand.dokumente.size) {
    teile.push(h("div", { class: "knopfreihe" }, h("button", {
      class: "knopf knopf-gefahr", type: "button",
      onclick: async () => {
        if (!confirm("Alle gespeicherten PDFs von diesem iPhone löschen? Die Dateien in deinem Ordner bleiben erhalten.")) return;
        await db.allesLoeschen();
        zustand.dokumente.clear();
        zustand.index.clear();
        await pdfSchliessen(b.pdf);
        b.pdf = null; b.id = null;
        neuAbgleichen();
        zeichnen();
        bl.schliessen();
        meldung("Alle Dokumente gelöscht.");
      },
    }, "Alle PDFs aus der App löschen")));
  }
  bl = blatt("Hilfe", h("div", null, teile));
}

// ---------- Betrachter ----------

const b = {
  offen: false, id: null, pdf: null, seiten: 0, seite: 1, zoom: 1,
  begriffe: [], liste: [], pos: -1, marken: [], darstellung: null, huelle: null, nummer: 0,
};

async function betrachterOeffnen(id, seite = 1, { trefferAufSeite = 0 } = {}) {
  const meta = zustand.dokumente.get(id);
  if (!meta) return;
  if (!b.offen) {
    b.offen = true;
    $("#betrachter").hidden = false;
    document.documentElement.style.overflow = "hidden";
    history.pushState({ betrachter: true }, "");
  }
  $("#b-titel").textContent = anzeigeTitel(meta);
  b.zoom = 1;
  $("#b-zoom").hidden = true;
  b.begriffe = zustand.anfrage ? anfrageZerlegen(zustand.anfrage) : [];
  const eintrag = zustand.index.get(id);
  b.liste = [];
  if (b.begriffe.length && eintrag) {
    eintrag.norm.forEach((n, i) => {
      const anzahl = alleFundstellen(b.begriffe, n).length;
      for (let k = 0; k < anzahl; k++) b.liste.push({ seite: i + 1, k });
    });
  }
  $("#b-treffer").hidden = !b.liste.length;
  ladeAnzeige(true);
  try {
    if (b.id !== id || !b.pdf) {
      await pdfSchliessen(b.pdf);
      b.pdf = null;
      b.id = id;
      const eintragPdf = await db.holen("pdfs", id);
      if (!eintragPdf) throw new Error("PDF fehlt");
      const daten = eintragPdf.daten || (eintragPdf.blob && (await eintragPdf.blob.arrayBuffer()));
      b.pdf = await pdfOeffnen(new Uint8Array(daten));
    }
    b.seiten = b.pdf.numPages;
    let pos = b.liste.findIndex((t) => t.seite === seite && t.k === trefferAufSeite);
    if (pos < 0) pos = b.liste.findIndex((t) => t.seite === seite);
    b.pos = pos;
    if (pos >= 0) b.zoom = await lesezoom(seite);
    $("#b-zoom").hidden = b.zoom <= 1.01;
    await seiteZeigen(seite, pos >= 0 ? b.liste[pos].k : null);
  } catch (e) {
    console.error(e);
    ladeAnzeige(false);
    meldung(`Das PDF konnte nicht geöffnet werden. (${technikText(e, "Öffnen")})`);
  }
}

// Fundstellen werden so groß geöffnet, dass normaler Fließtext gut lesbar ist (ca. 1,35 px je Punkt)
async function lesezoom(n) {
  try {
    const seite = await b.pdf.getPage(n);
    const breitePt = seite.getViewport({ scale: 1 }).width;
    const passend = Math.min($("#b-flaeche").clientWidth - 16, 1000) / breitePt;
    return Math.max(1, Math.min(2.6, 1.35 / passend));
  } catch {
    return 1;
  }
}

function betrachterSchliessen() {
  b.offen = false;
  b.nummer++;
  $("#betrachter").hidden = true;
  document.documentElement.style.overflow = "";
  b.darstellung?.freigeben();
  b.darstellung = null;
  b.marken = [];
  $("#b-flaeche").replaceChildren();
}

let ladeUhr;
function ladeAnzeige(an) {
  clearTimeout(ladeUhr);
  const flaeche = $("#b-flaeche");
  flaeche.querySelector(".b-laden")?.remove();
  if (an) {
    ladeUhr = setTimeout(() => flaeche.append(h("div", { class: "b-laden dreht" }, symbol("landolt"))), 180);
  }
}

async function seiteZeigen(n, k = null, punkt = null) {
  if (!b.pdf) return;
  n = Math.max(1, Math.min(b.seiten, n));
  const nummer = ++b.nummer;
  b.seite = n;
  leisteAktualisieren();
  const flaeche = $("#b-flaeche");
  const huelle = h("div", { class: "b-seite" });
  const breite = Math.min(flaeche.clientWidth - 16, 1000);
  ladeAnzeige(true);
  let darstellung;
  try {
    darstellung = await seiteZeichnen(b.pdf, n, huelle, {
      breite, zoom: b.zoom,
      stellenFinden: b.begriffe.length ? (norm) => alleFundstellen(b.begriffe, norm) : null,
    });
  } catch (e) {
    if (nummer === b.nummer) { ladeAnzeige(false); meldung("Die Seite konnte nicht angezeigt werden."); }
    console.error(e);
    return;
  }
  if (nummer !== b.nummer) { darstellung.freigeben(); return; }
  ladeAnzeige(false);
  b.darstellung?.freigeben();
  b.darstellung = darstellung;
  b.marken = darstellung.marken;
  b.huelle = huelle;
  flaeche.replaceChildren(huelle);
  if (punkt) {
    const r = huelle.getBoundingClientRect();
    flaeche.scrollLeft += r.left + punkt.x - punkt.bx;
    flaeche.scrollTop += r.top + punkt.y - punkt.by;
  } else if (k !== null && b.marken.length) {
    markeHervorheben(k, true);
  } else {
    flaeche.scrollTo(textspalteLinks(), 0);
  }
  leisteAktualisieren();
}

// Linker Rand der Textspalte: beim Vergrößern den leeren Seitenrand überspringen
function textspalteLinks() {
  if (!b.huelle || b.zoom <= 1.01) return 0;
  const flaeche = $("#b-flaeche");
  const fr = flaeche.getBoundingClientRect();
  let min = Infinity;
  for (const span of b.huelle.querySelectorAll(".textLayer span")) {
    if (!span.textContent.trim()) continue;
    const x = span.getBoundingClientRect().left;
    if (x < min) min = x;
  }
  if (!isFinite(min)) return 0;
  return Math.max(0, flaeche.scrollLeft + min - fr.left - 14);
}

function markeHervorheben(k, sofort = false) {
  for (const gruppe of b.marken) for (const m of gruppe) m.classList.remove("aktuell");
  const gruppe = b.marken[Math.min(k, b.marken.length - 1)];
  if (!gruppe) return;
  for (const m of gruppe) m.classList.add("aktuell");
  const flaeche = $("#b-flaeche");
  const fr = flaeche.getBoundingClientRect();
  const r = gruppe[0].getBoundingClientRect();
  const rEnde = gruppe[gruppe.length - 1].getBoundingClientRect();
  // waagerecht: möglichst am Zeilenanfang bleiben, aber die Fundstelle muss ganz sichtbar sein
  const links = flaeche.scrollLeft + Math.min(r.left, rEnde.left) - fr.left;
  const rechts = flaeche.scrollLeft + Math.max(r.right, rEnde.right) - fr.left;
  let x = textspalteLinks();
  if (rechts + 16 - x > fr.width) x = rechts + 16 - fr.width;
  if (links - 16 < x) x = links - 16;
  flaeche.scrollTo({
    top: flaeche.scrollTop + r.top - fr.top - fr.height * 0.33,
    left: Math.max(0, x),
    behavior: sofort ? "auto" : "smooth",
  });
}

function leisteAktualisieren() {
  $("#b-seitenzahl").textContent = `${b.seite} / ${b.seiten || "…"}`;
  $("#b-unter").textContent = b.liste.length
    ? `${mehrzahl(b.liste.length, "Fundstelle", "Fundstellen")} für „${zustand.anfrage}“`
    : mehrzahl(b.seiten || 0, "Seite", "Seiten");
  $("#b-seite-zurueck").disabled = b.seite <= 1;
  $("#b-seite-vor").disabled = b.seite >= b.seiten;
  const t = b.liste[b.pos];
  $("#b-trefferzahl").textContent = t && t.seite === b.seite ? `${b.pos + 1} / ${b.liste.length}` : `– / ${b.liste.length}`;
}

function trefferSchritt(richtung) {
  if (!b.liste.length) return;
  const t0 = b.liste[b.pos];
  if (!t0 || t0.seite !== b.seite) {
    // vom aktuellen Blatt aus die nächste bzw. vorige Fundstelle suchen
    if (richtung > 0) {
      const i = b.liste.findIndex((t) => t.seite >= b.seite);
      b.pos = i >= 0 ? i : 0;
    } else {
      let i = -1;
      b.liste.forEach((t, j) => { if (t.seite <= b.seite) i = j; });
      b.pos = i >= 0 ? i : b.liste.length - 1;
    }
  } else {
    b.pos = (b.pos + richtung + b.liste.length) % b.liste.length;
  }
  const t = b.liste[b.pos];
  if (t.seite === b.seite && b.marken.length) {
    markeHervorheben(t.k);
    leisteAktualisieren();
  } else {
    seiteZeigen(t.seite, t.k);
  }
}

function blaettern(richtung) {
  const ziel = b.seite + richtung;
  if (ziel < 1 || ziel > b.seiten) return;
  seiteZeigen(ziel);
}

function zoomSetzen(neu, punkt) {
  neu = Math.max(1, Math.min(4, neu));
  if (Math.abs(neu - b.zoom) < 0.02) {
    if (b.huelle) b.huelle.style.transform = "";
    return;
  }
  const verhaeltnis = neu / b.zoom;
  b.zoom = neu;
  $("#b-zoom").hidden = neu <= 1.01;
  // Punkt (x, y) innerhalb der Seite soll nach dem Neuzeichnen unter dem Finger (bx, by) bleiben
  const p = punkt ? { x: punkt.x * verhaeltnis, y: punkt.y * verhaeltnis, bx: punkt.bx, by: punkt.by } : null;
  const t = b.liste[b.pos];
  seiteZeigen(b.seite, p ? null : (t && t.seite === b.seite ? t.k : null), p);
}

function gestenBinden() {
  const flaeche = $("#b-flaeche");
  let wisch = null, kneifen = null, letzterTipp = 0;
  const abstand = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  flaeche.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2 && b.huelle) {
      const r = b.huelle.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      kneifen = { d0: abstand(e.touches), z0: b.zoom, f: 1, x: mx - r.left, y: my - r.top, bx: mx, by: my };
      b.huelle.style.transformOrigin = `${kneifen.x}px ${kneifen.y}px`;
      wisch = null;
    } else if (e.touches.length === 1) {
      wisch = { x: e.touches[0].clientX, y: e.touches[0].clientY, zeit: Date.now() };
    }
  }, { passive: true });

  flaeche.addEventListener("touchmove", (e) => {
    if (kneifen && e.touches.length === 2) {
      e.preventDefault();
      kneifen.f = abstand(e.touches) / kneifen.d0;
      const z = Math.max(1, Math.min(4, kneifen.z0 * kneifen.f));
      b.huelle.style.transform = `scale(${z / kneifen.z0})`;
    }
  }, { passive: false });

  flaeche.addEventListener("touchend", (e) => {
    if (kneifen) {
      if (e.touches.length === 0) {
        const k = kneifen;
        kneifen = null;
        zoomSetzen(k.z0 * k.f, { x: k.x, y: k.y, bx: k.bx, by: k.by });
      }
      return;
    }
    if (!wisch || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - wisch.x, dy = t.clientY - wisch.y, dauer = Date.now() - wisch.zeit;
    wisch = null;
    if (b.zoom <= 1.01 && Math.abs(dx) > 70 && Math.abs(dy) < 50 && dauer < 700) {
      blaettern(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dauer < 300) {
      const jetzt = Date.now();
      if (jetzt - letzterTipp < 320 && b.huelle) {
        letzterTipp = 0;
        e.preventDefault();
        const r = b.huelle.getBoundingClientRect();
        zoomSetzen(b.zoom > 1.01 ? 1 : 2, { x: t.clientX - r.left, y: t.clientY - r.top, bx: t.clientX, by: t.clientY });
      } else {
        letzterTipp = jetzt;
      }
    }
  });

  // Safari: Seitenzoom des Browsers im Betrachter unterdrücken
  for (const typ of ["gesturestart", "gesturechange"]) $("#betrachter").addEventListener(typ, (e) => e.preventDefault());
}

// ---------- Ereignisse ----------

function ereignisseBinden() {
  const suchfeld = $("#suchfeld");
  suchfeld.addEventListener("input", sucheAnstossen);
  suchfeld.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(suchUhr); sucheAusfuehren(); suchfeld.blur(); }
  });
  $("#such-leeren").addEventListener("click", () => {
    suchfeld.value = "";
    sucheAusfuehren();
    suchfeld.focus();
  });
  $("#hinzufuegen").addEventListener("click", dateiWahl);
  $("#datei-eingabe").addEventListener("change", (e) => {
    const dateien = e.target.files;
    if (dateien?.length) importieren(dateien);
  });
  $("#hilfe-knopf").addEventListener("click", hilfeZeigen);

  window.addEventListener("scroll", () => $("#oben").classList.toggle("gescrollt", window.scrollY > 4), { passive: true });

  $("#b-zurueck").addEventListener("click", () => (history.state?.betrachter ? history.back() : betrachterSchliessen()));
  window.addEventListener("popstate", () => { if (b.offen) betrachterSchliessen(); });
  $("#b-seite-zurueck").addEventListener("click", () => blaettern(-1));
  $("#b-seite-vor").addEventListener("click", () => blaettern(1));
  $("#b-treffer-zurueck").addEventListener("click", () => trefferSchritt(-1));
  $("#b-treffer-vor").addEventListener("click", () => trefferSchritt(1));
  $("#b-zoom").addEventListener("click", () => zoomSetzen(1));
  document.addEventListener("keydown", (e) => {
    if (!b.offen || document.querySelector(".blatt-grund")) return;
    if (e.key === "Escape") $("#b-zurueck").click();
    else if (e.key === "ArrowRight") blaettern(1);
    else if (e.key === "ArrowLeft") blaettern(-1);
    else if (e.key === "Enter" || e.key === "F3") trefferSchritt(e.shiftKey ? -1 : 1);
  });
  gestenBinden();

  let groessenUhr;
  window.addEventListener("resize", () => {
    clearTimeout(groessenUhr);
    groessenUhr = setTimeout(() => { if (b.offen && b.pdf) seiteZeigen(b.seite); }, 250);
  });
}

start();

// Für Tests im Browser erreichbar
window.__leitlinien = { zustand, b, sucheAusfuehren, importieren, versionenAktualisieren, neuAbgleichen, detailsZeigen };
