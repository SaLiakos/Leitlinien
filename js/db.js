// Lokale Ablage im Browser (IndexedDB). Alles bleibt auf dem Gerät.
//
// dokumente: Metadaten je PDF (Schlüssel = SHA-256 der Datei)
// pdfs:      die PDF-Dateien selbst
// texte:     Anzeigetext je Seite (für die Suche)
// kv:        Einstellungen und die zuletzt geladene Versionsliste

const NAME = "leitlinien";
const VERSION = 1;
let dbPromise = null;

function oeffnen() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("dokumente")) db.createObjectStore("dokumente", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pdfs")) db.createObjectStore("pdfs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("texte")) db.createObjectStore("texte", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Die Datenbank ist blockiert. Bitte die App schließen und neu öffnen."));
  });
  return dbPromise;
}

function anfrage(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function speicher(name, modus = "readonly") {
  const db = await oeffnen();
  return db.transaction(name, modus).objectStore(name);
}

export async function holen(name, schluessel) {
  return anfrage((await speicher(name)).get(schluessel));
}

export async function alle(name) {
  return anfrage((await speicher(name)).getAll());
}

export async function setzen(name, wert) {
  return anfrage((await speicher(name, "readwrite")).put(wert));
}

export async function kvHolen(k) {
  const e = await holen("kv", k);
  return e ? e.v : undefined;
}

export async function kvSetzen(k, v) {
  return setzen("kv", { k, v });
}

/**
 * Speichert ein neues Dokument vollständig in einer Transaktion (alles oder nichts).
 * Das PDF wird als ArrayBuffer abgelegt: Blobs in IndexedDB sind in Safari/WebKit
 * immer wieder fehleranfällig gewesen, ArrayBuffer funktionieren überall.
 */
export async function dokumentSpeichern(meta, daten, seiten) {
  const db = await oeffnen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["dokumente", "pdfs", "texte"], "readwrite");
    tx.objectStore("pdfs").put({ id: meta.id, daten });
    tx.objectStore("texte").put({ id: meta.id, seiten });
    tx.objectStore("dokumente").put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Speichern abgebrochen"));
  });
}

export async function dokumentLoeschen(id) {
  const db = await oeffnen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["dokumente", "pdfs", "texte"], "readwrite");
    for (const n of ["dokumente", "pdfs", "texte"]) tx.objectStore(n).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function allesLoeschen() {
  const db = await oeffnen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["dokumente", "pdfs", "texte"], "readwrite");
    for (const n of ["dokumente", "pdfs", "texte"]) tx.objectStore(n).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Bittet den Browser, die Daten nicht bei Platzmangel zu löschen. */
export async function dauerhaftAnfordern() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* nicht unterstützt */ }
  return false;
}

export async function speicherbelegung() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* nicht unterstützt */ }
  return null;
}
