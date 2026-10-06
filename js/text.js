// Textaufbereitung und Volltextsuche.
//
// Jede PDF-Seite wird einmal beim Import in einen "Anzeigetext" umgewandelt
// (Leerraum zusammengefasst, Silbentrennung am Zeilenende aufgelöst).
// Für die Suche wird daraus ein "gefalteter" Text gebildet (klein, ohne
// Akzente/Umlautpunkte), der Zeichen für Zeichen gleich lang bleibt –
// so passen Trefferpositionen direkt auf den Anzeigetext.

// ---------- Zeichen falten ----------

const FOLD = new Uint16Array(0x250);
for (let c = 0; c < 0x250; c++) {
  let s = String.fromCharCode(c).toLowerCase();
  if (s.length !== 1) s = String.fromCharCode(c);
  FOLD[c] = s.normalize("NFD").charCodeAt(0);
}

function faltCode(c) {
  if (c < 0x250) return FOLD[c];
  if ((c >= 0x2010 && c <= 0x2015) || c === 0x2212 || c === 0xfe63 || c === 0xff0d) return 45; // Striche → "-"
  if (c === 0x2018 || c === 0x2019 || c === 0x201a || c === 0x2032) return 39; // ’ → '
  if (c === 0x201c || c === 0x201d || c === 0x201e || c === 0x00ab || c === 0x00bb) return 34; // „“ → "
  if (c >= 0xd800 && c <= 0xdfff) return c;
  const l = String.fromCharCode(c).toLowerCase();
  return l.length === 1 ? l.charCodeAt(0) : c;
}

/** Faltet Text zeichengenau (gleiche Länge): klein, ohne Diakritika, einheitliche Striche. */
export function falte(s) {
  const n = s.length;
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) codes[i] = faltCode(s.charCodeAt(i));
  let out = "";
  for (let i = 0; i < n; i += 8192) out += String.fromCharCode.apply(null, codes.subarray(i, i + 8192));
  return out;
}

const RE_BUCHSTABE = /\p{L}/u;
const istBuchstabe = (ch) => RE_BUCHSTABE.test(ch);
const istKlein = (ch) => istBuchstabe(ch) && ch === ch.toLowerCase() && ch !== ch.toUpperCase();
const istStrich = (ch) => ch === "-" || ch === "‐" || ch === "‑";

function istLeerraum(code) {
  return code <= 32 || code === 0xa0 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

function naechstesZeichen(items, ab) {
  for (let i = ab; i < items.length; i++) {
    const s = items[i].str || "";
    for (let j = 0; j < s.length; j++) {
      const code = s.charCodeAt(j);
      if (!istLeerraum(code) && code !== 0xad) return s[j];
    }
  }
  return null;
}

/**
 * Baut aus den Textelementen einer PDF-Seite (pdf.js getTextContent().items)
 * den Anzeigetext. Mit `mitKarte` wird zusätzlich für jedes Zeichen vermerkt,
 * aus welchem Element (mi) und welcher Position darin (mc) es stammt –
 * damit lassen sich Treffer später auf der Seite markieren.
 */
export function seiteAufbereiten(items, mitKarte = false) {
  const zeichen = [];
  const mi = mitKarte ? [] : null;
  const mc = mitKarte ? [] : null;
  let leer = true;
  const push = (ch, i, j) => {
    zeichen.push(ch);
    if (mi) { mi.push(i); mc.push(j); }
  };
  const pop = () => {
    zeichen.pop();
    if (mi) { mi.pop(); mc.pop(); }
  };

  for (let i = 0; i < items.length; i++) {
    const s = items[i].str;
    if (s === undefined) continue;
    let weichesTrennzeichenAmEnde = false;
    for (let j = 0; j < s.length; j++) {
      const code = s.charCodeAt(j);
      if (code === 0xad) { weichesTrennzeichenAmEnde = j === s.length - 1; continue; }
      if (code === 0x200b || code === 0xfeff) continue;
      if (istLeerraum(code)) {
        if (!leer) { push(" ", i, j); leer = true; }
        continue;
      }
      push(s[j], i, j);
      leer = false;
    }
    if (items[i].hasEOL) {
      const n = zeichen.length;
      if (weichesTrennzeichenAmEnde && n && istBuchstabe(zeichen[n - 1])) continue; // "Makula­" + "degeneration"
      if (n >= 2 && istStrich(zeichen[n - 1]) && istBuchstabe(zeichen[n - 2])) {
        const naechstes = naechstesZeichen(items, i + 1);
        if (naechstes && istKlein(naechstes)) pop(); // Trennstrich entfernen
        continue; // nach Strich am Zeilenende kein Leerzeichen
      }
      if (!leer) { push(" ", i, s.length); leer = true; }
    }
  }
  while (zeichen.length && zeichen[zeichen.length - 1] === " ") pop();
  return { text: zeichen.join(""), mi, mc };
}

// ---------- Suchanfrage ----------

const RE_SONDER = /[.*+?^${}()|[\]\\]/g;
const istAlnumCode = (c) =>
  (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 0xdf && c <= 0x24f && c !== 0xf7) || (c > 0x370 && c < 0x2000);

/**
 * Zerlegt die Eingabe in Suchbegriffe. Mehrere Wörter = alle müssen auf
 * derselben Seite vorkommen. "In Anführungszeichen" = genaue Wortfolge.
 * Bindestriche sind optional: "Anti-VEGF" findet auch "Anti VEGF" und
 * "AntiVEGF", "Makuladegeneration" auch "Makula-Degeneration".
 */
export function anfrageZerlegen(eingabe) {
  const q = eingabe.replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, "").replace(/[„“”«»]/g, '"');
  const begriffe = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    const roh = m[1] !== undefined ? m[1] : m[2];
    let f = falte(roh.trim()).replace(/\s+/g, " ");
    f = f.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!f) continue;
    let quelle = "";
    for (let i = 0; i < f.length; i++) {
      const ch = f[i];
      if (ch === "-" || ch === " ") {
        if (!quelle.endsWith("[- ]?")) quelle += "[- ]?";
        continue;
      }
      quelle += ch.replace(RE_SONDER, "\\$&");
      const nx = f[i + 1];
      if (nx !== undefined && nx !== "-" && nx !== " " && istAlnumCode(ch.charCodeAt(0)) && istAlnumCode(nx.charCodeAt(0))) {
        quelle += "-?";
      }
    }
    const kurz = f.replace(/[- ]/g, "").length <= 3;
    begriffe.push({ text: f, roh, re: new RegExp(quelle, "g"), wortanfang: kurz, phrase: m[1] !== undefined });
  }
  // Doppelte entfernen, längere (seltenere) Begriffe zuerst prüfen
  const gesehen = new Set();
  return begriffe
    .filter((b) => (gesehen.has(b.text) ? false : gesehen.add(b.text)))
    .sort((a, b) => b.text.length - a.text.length);
}

/** Alle Fundstellen eines Begriffs in einem gefalteten Text: [[start, ende], …] */
export function fundstellen(begriff, norm, max = 400) {
  const re = begriff.re;
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(norm))) {
    const a = m.index;
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (begriff.wortanfang && a > 0 && istAlnumCode(norm.charCodeAt(a - 1))) {
      re.lastIndex = a + 1;
      continue;
    }
    out.push([a, a + m[0].length]);
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Suche über alle Dokumente ----------

function kleinstesFenster(listen) {
  // kleinster Textabschnitt, der von jedem Begriff mindestens eine Fundstelle enthält
  if (listen.length === 1) return [listen[0][0][0], listen[0][0][1]];
  const ereignisse = [];
  listen.forEach((l, k) => l.forEach(([a, b]) => ereignisse.push([a, b, k])));
  ereignisse.sort((x, y) => x[0] - y[0]);
  const zaehler = new Array(listen.length).fill(0);
  let abgedeckt = 0, links = 0, best = null;
  for (let r = 0; r < ereignisse.length; r++) {
    if (zaehler[ereignisse[r][2]]++ === 0) abgedeckt++;
    while (abgedeckt === listen.length) {
      const start = ereignisse[links][0];
      const ende = Math.max(ereignisse[r][1], ereignisse[links][1]);
      if (!best || ende - start < best[1] - best[0]) best = [start, ende];
      if (--zaehler[ereignisse[links][2]] === 0) abgedeckt--;
      links++;
    }
  }
  return best;
}

/**
 * index: Map docId → { norm: string[], anzeige: string[], titelNorm: string }
 * Ergebnis: { begriffe, modus: 'alle'|'einzelne', dokumente: [{ id, score, seiten: [{ seite, score, fenster, stellen }] }], gesamt }
 */
export function suchen(index, eingabe, { maxSeitenJeDok = 50 } = {}) {
  const begriffe = anfrageZerlegen(eingabe);
  if (!begriffe.length) return null;

  const lauf = (modus) => {
    const dokumente = [];
    let gesamt = 0;
    for (const [id, eintrag] of index) {
      const seiten = [];
      for (let p = 0; p < eintrag.norm.length; p++) {
        const norm = eintrag.norm[p];
        if (!norm) continue;
        const listen = [];
        let score = 0;
        let fehlt = false;
        for (const b of begriffe) {
          const f = fundstellen(b, norm);
          if (!f.length) {
            if (modus === "alle") { fehlt = true; break; }
            continue;
          }
          listen.push(f);
          score += (1 + Math.log2(f.length)) * Math.min(1.6, 0.6 + b.text.length / 10);
        }
        if (fehlt || !listen.length) continue;
        if (modus === "einzelne") score *= listen.length / begriffe.length;
        const fenster = kleinstesFenster(listen);
        if (listen.length > 1 && fenster) score += 2.5 * Math.max(0, 1 - (fenster[1] - fenster[0]) / 400);
        const stellen = listen.flat().sort((x, y) => x[0] - y[0]);
        gesamt += stellen.length;
        seiten.push({ seite: p + 1, score, fenster, stellen });
      }
      if (!seiten.length) continue;
      seiten.sort((a, b) => b.score - a.score || a.seite - b.seite);
      let score = seiten[0].score + Math.min(1.5, 0.15 * (seiten.length - 1));
      if (begriffe.some((b) => fundstellen(b, eintrag.titelNorm || "", 1).length)) score += 2;
      dokumente.push({ id, score, seiten: seiten.slice(0, maxSeitenJeDok), seitenGesamt: seiten.length });
    }
    dokumente.sort((a, b) => b.score - a.score);
    return { dokumente, gesamt };
  };

  let modus = "alle";
  let erg = lauf(modus);
  if (!erg.dokumente.length && begriffe.length > 1) {
    modus = "einzelne";
    erg = lauf(modus);
  }
  return { begriffe, modus, ...erg };
}

/**
 * Textausschnitt rund um die beste Fundstelle, als Liste von Teilen
 * [{ text, markiert }] – markiert sind alle Fundstellen im Ausschnitt.
 */
export function ausschnitt(anzeige, seitenTreffer, laenge = 230) {
  const { fenster, stellen } = seitenTreffer;
  const mitte = fenster ? (fenster[0] + fenster[1]) / 2 : stellen[0][0];
  const spanne = fenster ? fenster[1] - fenster[0] : 0;
  const rand = Math.max(60, (laenge - spanne) / 2);
  let a = Math.max(0, Math.floor(mitte - spanne / 2 - rand * 0.8));
  let b = Math.min(anzeige.length, Math.ceil(mitte + spanne / 2 + rand * 1.2));
  if (a > 0) { const sp = anzeige.indexOf(" ", a); if (sp !== -1 && sp < a + 25) a = sp + 1; }
  if (b < anzeige.length) { const sp = anzeige.lastIndexOf(" ", b); if (sp > b - 25) b = sp; }
  const teile = [];
  let pos = a;
  for (const [s, e] of stellen) {
    if (e <= a || s >= b) continue;
    const s2 = Math.max(s, pos), e2 = Math.min(e, b);
    if (s2 > pos) teile.push({ text: anzeige.slice(pos, s2), markiert: false });
    if (e2 > s2) teile.push({ text: anzeige.slice(s2, e2), markiert: true });
    pos = Math.max(pos, e2);
  }
  if (pos < b) teile.push({ text: anzeige.slice(pos, b), markiert: false });
  return { vorne: a > 0, hinten: b < anzeige.length, teile };
}

/** Fundstellen aller Begriffe auf einem gefalteten Text, sortiert und ohne Überlappung. */
export function alleFundstellen(begriffe, norm) {
  const alle = begriffe.flatMap((b) => fundstellen(b, norm, 2000));
  alle.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const out = [];
  for (const st of alle) {
    const letzte = out[out.length - 1];
    if (letzte && st[0] < letzte[1]) { letzte[1] = Math.max(letzte[1], st[1]); continue; }
    out.push([st[0], st[1]]);
  }
  return out;
}

// ---------- Hilfen für den Abgleich von Titeln ----------

const STOPP = new Set(("der die das und oder bei von vom zur zum des den dem mit fur im in am an auf aus als " +
  "eine einer eines ein einem leitlinie leitlinien stellungnahme stellungnahmen empfehlung empfehlungen dog bva " +
  "awmf neu final version teil kurzfassung langfassung fassung deutschen deutsche gesellschaft ophthalmologischen " +
  "ophthalmologische berufsverbandes berufsverband augenarzte augenarztinnen deutschlands retinologischen retinologische " +
  "sowie uber nach gemeinsame gemeinsamen").split(" "));

function stamm(w) {
  return w.replace(/(en|er|es|em|e|n|s)$/, "");
}

export function titelWoerter(s) {
  const out = new Set();
  for (const w of falte(s).split(/[^a-z0-9ß]+/)) {
    if (w.length < 4 || STOPP.has(w) || /^\d+$/.test(w)) continue;
    out.add(stamm(w));
  }
  return out;
}
