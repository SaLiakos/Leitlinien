// Service Worker: macht die App offline nutzbar.
// Bei jeder Änderung an der App VERSION erhöhen, damit iPhones die neue Fassung laden.
const VERSION = "2026-10-06.1";
const KERN = `leitlinien-kern-${VERSION}`;
const ZUSATZ = "leitlinien-zusatz"; // Schriften, CMaps, WASM von pdf.js (bei Bedarf geladen)
const LISTE = "leitlinien-versionsliste";

const KERNDATEIEN = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/db.js",
  "./js/pdf.js",
  "./js/text.js",
  "./js/versionen.js",
  "./vendor/pdfjs/pdf.min.js",
  "./vendor/pdfjs/pdf.worker.min.js",
  "./icons/icon.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

const ZUSATZDATEIEN = [
  "standard_fonts/FoxitDingbats.pfb", "standard_fonts/FoxitFixed.pfb", "standard_fonts/FoxitFixedBold.pfb",
  "standard_fonts/FoxitFixedBoldItalic.pfb", "standard_fonts/FoxitFixedItalic.pfb", "standard_fonts/FoxitSerif.pfb",
  "standard_fonts/FoxitSerifBold.pfb", "standard_fonts/FoxitSerifBoldItalic.pfb", "standard_fonts/FoxitSerifItalic.pfb",
  "standard_fonts/FoxitSymbol.pfb", "standard_fonts/LiberationSans-Bold.ttf", "standard_fonts/LiberationSans-BoldItalic.ttf",
  "standard_fonts/LiberationSans-Italic.ttf", "standard_fonts/LiberationSans-Regular.ttf",
  "wasm/openjpeg.wasm", "wasm/jbig2.wasm", "wasm/qcms_bg.wasm",
].map((p) => `./vendor/pdfjs/${p}`);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const kern = await caches.open(KERN);
    await kern.addAll(KERNDATEIEN.map((u) => new Request(u, { cache: "reload" })));
    // Zusatzdateien im Hintergrund, Fehler sind hier nicht schlimm
    const zusatz = await caches.open(ZUSATZ);
    await Promise.allSettled(ZUSATZDATEIEN.map(async (u) => {
      if (!(await zusatz.match(u))) await zusatz.add(new Request(u, { cache: "reload" }));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("leitlinien-kern-") && name !== KERN) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Versionsliste: immer zuerst aus dem Netz, offline der letzte Stand
  if (url.pathname.endsWith("/versions.json")) {
    event.respondWith((async () => {
      const cache = await caches.open(LISTE);
      try {
        const antwort = await fetch(req, { cache: "no-store" });
        if (antwort.ok) await cache.put("versions.json", antwort.clone());
        return antwort;
      } catch {
        const alt = await cache.match("versions.json");
        return alt || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
      }
    })());
    return;
  }

  // Seitenaufrufe: App-Hülle aus dem Speicher
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const kern = await caches.open(KERN);
      return (await kern.match("./index.html")) || fetch(req);
    })());
    return;
  }

  // Alles andere: zuerst Speicher, sonst Netz (und pdf.js-Zusätze merken)
  event.respondWith((async () => {
    const vorhanden = await caches.match(req, { ignoreSearch: true });
    if (vorhanden) return vorhanden;
    const antwort = await fetch(req);
    if (antwort.ok && url.pathname.includes("/vendor/pdfjs/")) {
      const zusatz = await caches.open(ZUSATZ);
      zusatz.put(req, antwort.clone());
    }
    return antwort;
  })());
});
