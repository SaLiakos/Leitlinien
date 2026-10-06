// PDF-Verarbeitung mit pdf.js (läuft komplett im Browser).

import { seiteAufbereiten, falte } from "./text.js";

const BASIS = new URL("../vendor/pdfjs/", import.meta.url).href;
let bibliothek = null;
let arbeiter = null;

export async function pdfjs() {
  if (!bibliothek) {
    bibliothek = import("../vendor/pdfjs/pdf.min.js").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = BASIS + "pdf.worker.min.js";
      return lib;
    });
  }
  return bibliothek;
}

async function worker(lib) {
  if (!arbeiter || arbeiter.destroyed) arbeiter = new lib.PDFWorker({ name: "leitlinien" });
  return arbeiter;
}

/** Öffnet ein PDF aus Bytes (ArrayBuffer/Uint8Array). */
export async function pdfOeffnen(daten) {
  const lib = await pdfjs();
  const aufgabe = lib.getDocument({
    data: daten,
    worker: await worker(lib),
    isEvalSupported: false,
    enableXfa: false,
    standardFontDataUrl: BASIS + "standard_fonts/",
    wasmUrl: BASIS + "wasm/",
    iccUrl: BASIS + "iccs/",
  });
  return aufgabe.promise;
}

/** Schließt ein geöffnetes PDF und gibt den Speicher frei (der gemeinsame Worker bleibt bestehen). */
export async function pdfSchliessen(pdf) {
  if (!pdf) return;
  try {
    await (pdf.loadingTask?.destroy?.() ?? pdf.destroy?.());
  } catch { /* schon geschlossen */ }
}

export async function sha256(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Liest den Text aller Seiten. fortschritt(seite, seitenGesamt) wird je Seite aufgerufen.
 * Ergebnis: { seiten: [Anzeigetext je Seite], titel }
 */
export async function textAuslesen(buffer, fortschritt) {
  // pdf.js übernimmt den Buffer – Kopie geben, damit das Original (für den Hash/Blob) heil bleibt
  const pdf = await pdfOeffnen(new Uint8Array(buffer.slice(0)));
  try {
    const seiten = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const seite = await pdf.getPage(n);
      const inhalt = await seite.getTextContent();
      seiten.push(seiteAufbereiten(inhalt.items).text);
      seite.cleanup();
      fortschritt?.(n, pdf.numPages);
    }
    let titel = "";
    try {
      const meta = await pdf.getMetadata();
      titel = (meta?.info?.Title || "").trim();
    } catch { /* ohne Metadaten */ }
    return { seiten, titel };
  } finally {
    await pdfSchliessen(pdf);
  }
}

// ---------- Anzeige einer Seite mit markierten Fundstellen ----------

const MAX_PIXEL = 12_000_000; // iOS begrenzt die Größe einer Zeichenfläche

/**
 * Zeichnet eine Seite in `huelle` (leeres Element) und markiert die Fundstellen.
 * begriffe: Ergebnis von anfrageZerlegen(); stellenFinden(norm) liefert [[a,b],…].
 * Gibt { marken: Element[][] (je Fundstelle), abbrechen } zurück.
 */
export async function seiteZeichnen(pdf, nummer, huelle, { breite, zoom = 1, stellenFinden }) {
  const lib = await pdfjs();
  const seite = await pdf.getPage(nummer);
  const basis = seite.getViewport({ scale: 1 });
  const massstab = (breite / basis.width) * zoom;
  const viewport = seite.getViewport({ scale: massstab });

  const dpr = window.devicePixelRatio || 1;
  let ausgabe = dpr;
  const flaeche = viewport.width * viewport.height * dpr * dpr;
  if (flaeche > MAX_PIXEL) ausgabe = Math.sqrt(MAX_PIXEL / (viewport.width * viewport.height));

  const leinwand = document.createElement("canvas");
  leinwand.width = Math.floor(viewport.width * ausgabe);
  leinwand.height = Math.floor(viewport.height * ausgabe);
  leinwand.style.width = `${Math.floor(viewport.width)}px`;
  leinwand.style.height = `${Math.floor(viewport.height)}px`;
  leinwand.className = "pdf-leinwand";

  const textEbene = document.createElement("div");
  textEbene.className = "textLayer";

  huelle.style.setProperty("--scale-factor", String(massstab));
  huelle.style.width = `${Math.floor(viewport.width)}px`;
  huelle.style.height = `${Math.floor(viewport.height)}px`;
  huelle.replaceChildren(leinwand, textEbene);

  const zeichnen = seite.render({
    canvas: leinwand,
    viewport,
    transform: ausgabe !== 1 ? [ausgabe, 0, 0, ausgabe, 0, 0] : null,
  });

  const inhalt = await seite.getTextContent();
  const ebene = new lib.TextLayer({ textContentSource: inhalt, container: textEbene, viewport });
  await ebene.render();
  const marken = markieren(inhalt.items, ebene.textDivs, stellenFinden);

  await zeichnen.promise;
  return {
    marken,
    freigeben() {
      leinwand.width = 0; // Speicher unter iOS sofort freigeben
      leinwand.height = 0;
      seite.cleanup();
    },
  };
}

/** Umschließt die Fundstellen in der Textebene mit <mark>-Elementen. */
function markieren(items, textDivs, stellenFinden) {
  const textItems = items.filter((it) => it.str !== undefined);
  const { text, mi, mc } = seiteAufbereiten(textItems, true);
  const stellen = stellenFinden ? stellenFinden(falte(text)) : [];
  if (!stellen.length) return [];

  // je Element: Liste von [start, ende, trefferNr]
  const jeElement = new Map();
  stellen.forEach(([a, b], nr) => {
    for (let p = a; p < b; p++) {
      const i = mi[p], j = mc[p];
      if (j >= (textItems[i].str || "").length) continue; // eingefügtes Leerzeichen am Zeilenende
      let liste = jeElement.get(i);
      if (!liste) jeElement.set(i, (liste = []));
      const letzte = liste[liste.length - 1];
      if (letzte && letzte[2] === nr && letzte[1] === j) letzte[1] = j + 1;
      else liste.push([j, j + 1, nr]);
    }
  });

  const marken = stellen.map(() => []);
  for (const [i, liste] of jeElement) {
    const div = textDivs[i];
    if (!div) continue;
    const s = textItems[i].str;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b, nr] of liste) {
      if (a > pos) frag.append(s.slice(pos, a));
      const mark = document.createElement("mark");
      mark.textContent = s.slice(a, b);
      mark.dataset.treffer = String(nr);
      frag.append(mark);
      marken[nr].push(mark);
      pos = b;
    }
    if (pos < s.length) frag.append(s.slice(pos));
    div.replaceChildren(frag);
  }
  return marken.filter((m) => m.length);
}
