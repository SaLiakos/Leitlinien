#!/usr/bin/env python3
"""Tägliche Versionsprüfung der Leitlinien von DOG und BVA (inkl. AWMF-Register).

Liest die öffentliche Übersichtsseite, die verlinkten Dokumentseiten und die
AWMF-Registerseiten und schreibt eine Versionsliste nach versions.json.

Es werden KEINE PDFs heruntergeladen: Für jede PDF-Datei werden nur
Dateigröße, Änderungsdatum und ETag beim Server abgefragt (HEAD-Anfrage).
In der Versionsliste stehen nur Titel, Links, Datum und Dateigröße.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.robotparser
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

import requests
from bs4 import BeautifulSoup, Tag

WURZEL = Path(__file__).resolve().parent.parent
REPO = os.environ.get("GITHUB_REPOSITORY", "")
UA = ("Mozilla/5.0 (compatible; Leitlinien-Versionspruefung/1.0; "
      f"privat, einmal taeglich{'; +https://github.com/' + REPO if REPO else ''})")

AWMF_ARTEN = {
    "l": "Langfassung", "k": "Kurzfassung", "m": "Leitlinienreport", "p": "Patienteninformation",
    "i": "Interessenerklärungen", "e": "Evidenzbericht", "a": "Anhang", "s": "Sondervotum",
    "t": "Tabellen", "d": "Dokumentation", "z": "Zusatzdokument",
}
ALLGEMEINE_LINKTEXTE = {"", "pdf", "[pdf]", "link", "[link]", "hier", "download", "herunterladen", "datei", "dokument"}

SITZUNG = requests.Session()
SITZUNG.headers.update({"User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.5"})

_letzte_anfrage: dict[str, float] = {}
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
PAUSE = 0.6


def jetzt_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(*teile) -> None:
    print(*teile, flush=True)


# ---------------------------------------------------------------- HTTP

def hoeflich_warten(url: str) -> None:
    host = urlparse(url).netloc
    seit = time.monotonic() - _letzte_anfrage.get(host, 0)
    if seit < PAUSE:
        time.sleep(PAUSE - seit)
    _letzte_anfrage[host] = time.monotonic()


def erlaubt(url: str) -> bool:
    teile = urlparse(url)
    basis = f"{teile.scheme}://{teile.netloc}"
    if basis not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = SITZUNG.get(basis + "/robots.txt", timeout=20)
            if r.status_code == 200:
                rp.parse(r.text.splitlines())
            else:
                rp = None  # keine robots.txt → erlaubt
        except requests.RequestException:
            rp = None
        _robots[basis] = rp
    rp = _robots[basis]
    return True if rp is None else rp.can_fetch(UA, url)


def anfrage(methode: str, url: str, **kw) -> requests.Response:
    kw.setdefault("timeout", 30)
    kw.setdefault("allow_redirects", True)
    letzter_fehler = None
    for versuch in range(3):
        hoeflich_warten(url)
        try:
            r = SITZUNG.request(methode, url, **kw)
            if r.status_code >= 500 or r.status_code == 429:
                letzter_fehler = requests.HTTPError(f"HTTP {r.status_code}")
                time.sleep(3 * (versuch + 1))
                continue
            return r
        except requests.RequestException as e:
            letzter_fehler = e
            time.sleep(3 * (versuch + 1))
    raise letzter_fehler or RuntimeError("Anfrage fehlgeschlagen")


def html_holen(url: str) -> str:
    if not erlaubt(url):
        raise PermissionError(f"robots.txt erlaubt keinen Abruf von {url}")
    r = anfrage("GET", url)
    r.raise_for_status()
    if "charset" not in r.headers.get("Content-Type", "").lower():
        # ohne Angabe im Kopf: Meta-Angabe der Seite oder Erkennung (sonst wird UTF-8 falsch gelesen)
        m = re.search(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9_-]+)", r.content[:4096], re.I)
        r.encoding = m.group(1).decode() if m else (r.apparent_encoding or "utf-8")
    return r.text


def datei_info(url: str) -> dict:
    """Größe, Datum und ETag einer Datei – ohne sie herunterzuladen."""
    kopf = {"Accept-Encoding": "identity"}
    r = anfrage("HEAD", url, headers=kopf)
    groesse = None
    if r.status_code < 400 and r.headers.get("Content-Length", "").isdigit():
        groesse = int(r.headers["Content-Length"])
    else:
        # Manche Server beantworten HEAD nicht: nur das erste Byte anfordern,
        # die Gesamtgröße steht dann im Content-Range-Kopf.
        r = anfrage("GET", url, headers={**kopf, "Range": "bytes=0-0"}, stream=True)
        r.close()
        bereich = r.headers.get("Content-Range", "")
        if "/" in bereich and bereich.rsplit("/", 1)[1].isdigit():
            groesse = int(bereich.rsplit("/", 1)[1])
        elif r.status_code == 200 and r.headers.get("Content-Length", "").isdigit():
            groesse = int(r.headers["Content-Length"])
    if r.status_code >= 400:
        raise requests.HTTPError(f"HTTP {r.status_code}")
    art = r.headers.get("Content-Type", "").lower()
    if "html" in art:
        raise ValueError("Link führt nicht zu einem PDF")
    return {
        "groesse": groesse,
        "geaendert": r.headers.get("Last-Modified"),
        "etag": r.headers.get("ETag"),
    }


# ---------------------------------------------------------------- HTML lesen

# Klassen/IDs von Seitenbereichen, die nicht zum eigentlichen Inhalt gehören (exakte Namen)
STOERER = {"sidebar", "widget-area", "site-header", "site-footer", "breadcrumb", "breadcrumbs",
           "post-navigation", "nav-links", "navigation", "menu", "sharedaddy", "share-buttons",
           "social-share", "related-posts", "comments-area", "cookie-notice", "cookie-banner"}
KATEGORIE_KLASSE = re.compile(r"(accordion|toggle|tab)[-_]?(title|header|heading|label|toggle)|"
                              r"elementor-tab-title|et_pb_toggle_title|vc_tta-title", re.I)


def text_von(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()


def hauptbereich(soup: BeautifulSoup, uebersicht: bool = False) -> Tag:
    reihenfolge = ("main", "article") if uebersicht else ("article", "main")
    haupt = (soup.find(reihenfolge[0]) or soup.find(reihenfolge[1])
             or soup.find(class_=re.compile(r"\b(entry-content|site-content|content-area)\b"))
             or soup.body or soup)
    for el in haupt.find_all(["nav", "header", "footer", "aside", "script", "style", "noscript", "form", "template"]):
        el.decompose()
    for el in haupt.find_all(True):
        if getattr(el, "decomposed", False):
            continue
        namen = set(el.get("class") or [])
        if el.get("id"):
            namen.add(el["id"])
        if namen & STOERER:
            el.decompose()
    return haupt


def hat_echten_link(el: Tag) -> bool:
    for a in el.find_all("a", href=True):
        h = a["href"].strip()
        if h and not h.startswith("#") and not h.lower().startswith("javascript:"):
            return True
    return False


def ist_kategorie(el: Tag) -> bool:
    if el.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
        return not hat_echten_link(el)
    klassen = " ".join(el.get("class") or [])
    return bool(klassen and KATEGORIE_KLASSE.search(klassen) and not hat_echten_link(el) and len(text_von(el)) < 120)


def liste_lesen(html: str, basis: str, muster: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    haupt = hauptbereich(soup, uebersicht=True)
    regel = re.compile(muster)
    gefunden: dict[str, dict] = {}
    kategorie = None
    for el in haupt.descendants:
        if not isinstance(el, Tag):
            continue
        if ist_kategorie(el):
            t = text_von(el)
            if t:
                kategorie = t
            continue
        if el.name != "a" or not el.get("href"):
            continue
        url = urljoin(basis, el["href"]).split("#")[0]
        if not regel.match(url):
            continue
        titel = text_von(el)
        if len(titel) < 4:
            continue
        if ist_verzeichnisseite(url, titel, muster):
            continue
        eintrag = gefunden.setdefault(url, {"seite": url, "titel": titel, "kategorien": []})
        if len(titel) > len(eintrag["titel"]):
            eintrag["titel"] = titel
        if kategorie and kategorie not in eintrag["kategorien"]:
            eintrag["kategorien"].append(kategorie)
    return list(gefunden.values())


def ist_verzeichnisseite(url: str, titel: str, muster: str) -> bool:
    """Themen- und Unterverzeichnisse (z. B. …/glaukom/leitlinien-glaukom/) sind keine Dokumente."""
    pfad = [s for s in urlparse(url).path.split("/") if s]
    try:
        start = pfad.index("leitlinien-stellungnahmen-empfehlungen") + 1
    except ValueError:
        start = 0
    rest = pfad[start:]
    hat_jahr = re.search(r"\(\s*(19|20)\d{2}", titel) is not None
    if len(rest) <= 1 and not hat_jahr:
        return True
    if len(rest) == 2 and re.match(r"^(leitlinien|stellungnahmen)-", rest[-1]) and not hat_jahr:
        return True
    return False


def linkbezeichnung(a: Tag) -> str:
    t = text_von(a)
    return "PDF" if t.lower().strip("[]() ") in ALLGEMEINE_LINKTEXTE else t[:80]


def detail_lesen(html: str, url: str, register_muster: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    geaendert = None
    for name in ("article:modified_time", "og:updated_time"):
        m = soup.find("meta", attrs={"property": name})
        if m and m.get("content"):
            geaendert = m["content"]
            break
    haupt = hauptbereich(soup)
    regel = re.compile(register_muster) if register_muster else None
    pdfs: dict[str, dict] = {}
    register: list[str] = []
    for a in haupt.find_all("a", href=True):
        ziel = urljoin(url, a["href"]).split("#")[0]
        pfad = urlparse(ziel).path
        if pfad.lower().endswith(".pdf"):
            pdfs.setdefault(ziel, {"url": ziel, "name": unquote(pfad.rsplit("/", 1)[-1]), "bezeichnung": linkbezeichnung(a)})
        elif regel and regel.match(ziel) and ziel not in register:
            register.append(ziel)
    return {"pdfs": list(pdfs.values()), "register": register, "seite_geaendert": geaendert}


# ---------------------------------------------------------------- AWMF-Register

def registernummer(text: str) -> str | None:
    m = re.search(r"(\d{3})[-_/](\d{3})", text or "")
    return f"{m.group(1)}-{m.group(2)}" if m else None


def awmf_bezeichnung(name: str, linktext: str) -> str:
    m = re.match(r"\d{3}-\d{3}([a-z])_", name, re.I)
    if m and m.group(1).lower() in AWMF_ARTEN:
        return AWMF_ARTEN[m.group(1).lower()]
    t = (linktext or "").strip()
    return t[:80] if t and t.lower() not in ALLGEMEINE_LINKTEXTE else "PDF"


def register_lesen(urls: list[str]) -> dict[str, dict]:
    """Rendert die Registerseiten (JavaScript-Anwendung) in einem Browser ohne Fenster."""
    ergebnisse: dict[str, dict] = {}
    if not urls:
        return ergebnisse
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {u: {"fehler": "Playwright ist nicht installiert"} for u in urls}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        kontext = browser.new_context(user_agent=UA, locale="de-DE")
        seite = kontext.new_page()
        for url in urls:
            nummer = registernummer(urlparse(url).path)
            in_antworten: set[str] = set()

            def bei_antwort(antwort, ablage=in_antworten):
                try:
                    if "json" in antwort.headers.get("content-type", ""):
                        for m in re.finditer(r"[A-Za-z0-9_\-./%]+\.pdf", antwort.text()):
                            ablage.add(m.group(0))
                except Exception:
                    pass

            seite.on("response", bei_antwort)
            try:
                if not erlaubt(url):
                    raise PermissionError("robots.txt erlaubt den Abruf nicht")
                hoeflich_warten(url)
                seite.goto(url, wait_until="networkidle", timeout=60000)
                try:
                    seite.wait_for_selector("a[href*='.pdf']", timeout=15000)
                except Exception:
                    pass
                links = seite.eval_on_selector_all(
                    "a[href]", "els => els.map(e => [e.href, (e.innerText || e.textContent || '').trim()])")
                text = seite.inner_text("body")
            except Exception as e:  # noqa: BLE001
                ergebnisse[url] = {"fehler": str(e).splitlines()[0][:200]}
                seite.remove_listener("response", bei_antwort)
                continue
            seite.remove_listener("response", bei_antwort)

            aktuell: dict[str, dict] = {}
            archiv: dict[str, dict] = {}
            for href, linktext in links:
                ziel = href.split("#")[0]
                name = unquote(urlparse(ziel).path.rsplit("/", 1)[-1])
                if not name.lower().endswith(".pdf") or (nummer and nummer not in name.replace("_", "-")):
                    continue
                eintrag = {"url": ziel, "name": name, "bezeichnung": awmf_bezeichnung(name, linktext)}
                (archiv if "_bkp" in ziel or "archiv" in ziel.lower() else aktuell).setdefault(ziel, eintrag)
            if not aktuell and in_antworten:
                for roh in sorted(in_antworten):
                    name = roh.rsplit("/", 1)[-1]
                    if nummer and nummer not in name.replace("_", "-"):
                        continue
                    ziel = roh if roh.startswith("http") else urljoin("https://register.awmf.org/assets/guidelines/", name)
                    if "_bkp" in ziel:
                        archiv.setdefault(ziel, {"url": ziel, "name": name, "bezeichnung": awmf_bezeichnung(name, "")})
                    else:
                        aktuell.setdefault(ziel, {"url": ziel, "name": name, "bezeichnung": awmf_bezeichnung(name, "")})

            stand = re.search(r"Stand[^0-9]{0,20}(\d{1,2}\.\d{1,2}\.\d{4})", text)
            gueltig = re.search(r"g(?:ü|ue)ltig bis[^0-9]{0,20}(\d{1,2}\.\d{1,2}\.\d{4})", text, re.I)
            ergebnisse[url] = {
                "nummer": nummer,
                "pdfs": list(aktuell.values()),
                "archiv": list(archiv.values()),
                "stand": stand.group(1) if stand else None,
                "gueltig_bis": gueltig.group(1) if gueltig else None,
            }
            log(f"  AWMF {nummer}: {len(aktuell)} aktuelle PDF(s)")
        browser.close()
    return ergebnisse


# ---------------------------------------------------------------- Zusammenführen

def schluessel(titel: str, seite: str) -> str:
    t = titel.lower()
    t = re.sub(r"\bneu\b!?", " ", t)
    t = re.sub(r"\(\s*(19|20)\d{2}(\s*/\s*(19|20)\d{2})?\s*\)", " ", t)
    t = re.sub(r"\b(19|20)\d{2}\b", " ", t)
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t or urlparse(seite).path.rstrip("/").rsplit("/", 1)[-1]


def dokumentart(seite: str, titel: str, register: bool = False) -> str:
    teile = [t for t in urlparse(seite).path.lower().split("/") if t and t != "leitlinien-stellungnahmen-empfehlungen"]
    if any(t.startswith("interdisziplinaere-leitlinien") for t in teile):
        return "Leitlinie (interdisziplinär)"
    if register or any(t.startswith("leitlinien-") for t in teile):
        return "Leitlinie"
    if any(t.startswith("stellungnahmen-") for t in teile):
        return "Stellungnahme"
    if re.search(r"leitlinie", titel, re.I):
        return "Leitlinie"
    if re.search(r"empfehlung", titel, re.I):
        return "Empfehlung"
    return "Stellungnahme"


def fingerabdruck(dateien: list[dict]) -> set:
    return {(f["url"], f.get("groesse")) for f in dateien}


def seitenname(seite: str) -> str:
    return urlparse(seite).path.rstrip("/").rsplit("/", 1)[-1] or "seite"


def vorgaenger_finden(alt: list[dict], neu: list[dict]) -> dict[int, dict]:
    """Ordnet jedem aktuellen Dokument seinen Eintrag aus dem letzten Lauf zu.

    Zuerst über die Dokumentseite (bleibt bei WordPress meist gleich, auch wenn sich der Titel
    ändert), sonst über den Titel, falls die alte Seite nicht mehr gelistet ist (Dokument umgezogen).
    """
    nach_seite = {d.get("seite"): d for d in alt if d.get("seite")}
    nach_schluessel = {d["schluessel"]: d for d in alt}
    neue_seiten = {d["seite"] for d in neu}
    vergeben: set[str] = set()
    zuordnung: dict[int, dict] = {}
    for d in neu:
        a = nach_seite.get(d["seite"])
        if a and a["schluessel"] not in vergeben:
            zuordnung[id(d)] = a
            vergeben.add(a["schluessel"])
    for d in neu:
        if id(d) in zuordnung:
            continue
        a = nach_schluessel.get(d["schluessel"])
        if a and a["schluessel"] not in vergeben and a.get("seite") not in neue_seiten:
            zuordnung[id(d)] = a
            vergeben.add(a["schluessel"])
    return zuordnung


def zusammenfuehren(alt: list[dict], neu: list[dict], zeit: str, quelle_vollstaendig: bool) -> tuple[list[dict], list[str]]:
    zuordnung = vorgaenger_finden(alt, neu)

    # Schlüssel stabil halten (wichtig für Zuordnungen in der App) und eindeutig machen
    belegt = {a["schluessel"] for a in alt}
    for d in neu:
        if id(d) in zuordnung:
            d["schluessel"] = zuordnung[id(d)]["schluessel"]
    vergeben = {d["schluessel"] for d in neu if id(d) in zuordnung}
    for d in neu:
        if id(d) in zuordnung:
            continue
        basis = d["schluessel"]
        k = basis
        if k in vergeben or k in belegt:
            k = f"{basis}--{seitenname(d['seite'])}"
        n = 2
        while k in vergeben or k in belegt:
            k = f"{basis}--{seitenname(d['seite'])}-{n}"
            n += 1
        d["schluessel"] = k
        vergeben.add(k)

    aenderungen: list[str] = []
    ergebnis = []
    for d in neu:
        a = zuordnung.get(id(d))
        d["erstmals"] = (a or {}).get("erstmals") or zeit
        d["aktualisiert"] = (a or {}).get("aktualisiert")
        d["frueher"] = list((a or {}).get("frueher", []))
        d["entfernt"] = None
        alt_dateien = {f["url"]: f for f in (a or {}).get("dateien", [])}
        for f in d["dateien"]:
            vorher = alt_dateien.get(f["url"])
            if f.get("groesse") is None and vorher:
                # Abfrage diesmal fehlgeschlagen: letzten bekannten Stand behalten
                for k in ("groesse", "geaendert", "etag"):
                    if f.get(k) is None:
                        f[k] = vorher.get(k)
            f["seit"] = vorher.get("seit", zeit) if vorher and vorher.get("groesse") == f.get("groesse") else zeit
        if a is None:
            if alt:
                aenderungen.append(f"neu gelistet: {d['titel']}")
        elif d["dateien"] and fingerabdruck(d["dateien"]) != fingerabdruck(a.get("dateien", [])):
            neue_fp = fingerabdruck(d["dateien"])
            for f in a.get("dateien", []):
                if (f["url"], f.get("groesse")) not in neue_fp:
                    d["frueher"].append({"url": f["url"], "name": f.get("name"), "groesse": f.get("groesse"), "bis": zeit})
            d["aktualisiert"] = zeit
            aenderungen.append(f"neue Fassung: {d['titel']}")
        elif not d["dateien"] and a.get("dateien"):
            d["dateien"] = a["dateien"]  # PDF-Link vorübergehend nicht gefunden: alten Stand behalten
        d["frueher"] = d["frueher"][-25:]
        ergebnis.append(d)

    weitergefuehrt = {id(a) for a in zuordnung.values()}
    for a in alt:
        if id(a) in weitergefuehrt:
            continue
        if quelle_vollstaendig and not a.get("entfernt"):
            a["entfernt"] = zeit
            aenderungen.append(f"nicht mehr gelistet: {a['titel']}")
        ergebnis.append(a)
    return ergebnis, aenderungen


# ---------------------------------------------------------------- Ablauf

def quelle_pruefen(q: dict, alt_dokumente: list[dict], mindestanteil: float) -> tuple[list[dict], dict]:
    zeit = jetzt_iso()
    status = {"id": q["id"], "name": q["name"], "url": q["liste"], "ok": False, "fehler": None, "anzahl": 0}
    alt_eigene = [d for d in alt_dokumente if d.get("quelle") == q["id"]]
    alt_nach_seite = {d.get("seite"): d for d in alt_eigene}

    try:
        eintraege = liste_lesen(html_holen(q["liste"]), q["liste"], q["dokumentseiten"])
    except Exception as e:  # noqa: BLE001
        status["fehler"] = f"Übersicht nicht lesbar: {e}"
        log("FEHLER", status["fehler"])
        return alt_eigene, status

    vorher = len([d for d in alt_eigene if not d.get("entfernt")])
    log(f"{q['name']}: {len(eintraege)} Dokumente in der Übersicht (vorher {vorher})")
    if vorher >= 20 and len(eintraege) < vorher * mindestanteil:
        status["fehler"] = (f"Übersicht enthält nur {len(eintraege)} statt rund {vorher} Dokumente – "
                            "vermutlich wurde die Seite umgebaut. Alter Stand bleibt erhalten.")
        log("FEHLER", status["fehler"])
        return alt_eigene, status

    neu: list[dict] = []
    register_urls: list[str] = []
    seitenfehler = 0
    for i, e in enumerate(eintraege, 1):
        a = alt_nach_seite.get(e["seite"])
        try:
            info = detail_lesen(html_holen(e["seite"]), e["seite"], q.get("registerseiten", ""))
        except Exception as ex:  # noqa: BLE001
            seitenfehler += 1
            log(f"  Seite nicht lesbar ({ex}): {e['seite']}")
            if a:
                neu.append({**a, "titel": e["titel"], "kategorien": e["kategorien"] or a.get("kategorien", []),
                            "_uebernommen": True})
            continue
        titel = e["titel"]
        d = {
            "schluessel": schluessel(titel, e["seite"]),
            "quelle": q["id"],
            "titel": titel,
            "neu_markiert": bool(re.search(r"\bNEU\b", titel)),
            "art": dokumentart(e["seite"], titel),
            "kategorien": e["kategorien"],
            "seite": e["seite"],
            "seite_geaendert": info["seite_geaendert"],
            "register": None,
            "dateien": info["pdfs"],
            "_register_urls": info["register"],
        }
        register_urls.extend(u for u in info["register"] if u not in register_urls)
        neu.append(d)
        if i % 25 == 0:
            log(f"  … {i}/{len(eintraege)} Seiten gelesen")

    # AWMF-Registerseiten einmal rendern und den Dokumenten zuordnen
    register = register_lesen(register_urls) if register_urls else {}
    for d in neu:
        for u in d.pop("_register_urls", []) or []:
            r = register.get(u) or {}
            if r.get("fehler"):
                log(f"  AWMF nicht lesbar ({r['fehler']}): {u}")
                alt = alt_nach_seite.get(d["seite"])
                if alt and alt.get("register"):
                    d["register"] = alt["register"]
                    d["dateien"] = d["dateien"] or [f for f in alt.get("dateien", []) if "awmf" in f["url"]]
                continue
            d["register"] = {"nummer": r.get("nummer"), "url": u, "stand": r.get("stand"), "gueltig_bis": r.get("gueltig_bis")}
            d["art"] = dokumentart(d["seite"], d["titel"], register=True)
            bekannte = {f["url"] for f in d["dateien"]}
            d["dateien"] += [f for f in r.get("pdfs", []) if f["url"] not in bekannte]
            if r.get("archiv"):
                frueher_urls = {f["url"] for f in d.setdefault("_archiv", [])}
                d["_archiv"] += [f for f in r["archiv"] if f["url"] not in frueher_urls]

    # PDFs, die auf vielen Dokumentseiten verlinkt sind (z. B. in einer Seitenleiste), gehören zu keinem Dokument
    zaehler: dict[str, int] = {}
    for d in neu:
        for f in d["dateien"]:
            zaehler[f["url"]] = zaehler.get(f["url"], 0) + 1
    seitenweit = {u for u, n in zaehler.items() if n > 4}
    if seitenweit:
        log(f"  {len(seitenweit)} seitenweit verlinkte PDF(s) ignoriert")
        for d in neu:
            d["dateien"] = [f for f in d["dateien"] if f["url"] not in seitenweit]

    # Dateigröße der PDFs abfragen (ohne Download)
    for d in neu:
        if d.pop("_uebernommen", False):
            continue
        behalten = []
        for f in d["dateien"]:
            try:
                f.update(datei_info(f["url"]))
            except ValueError as ex:
                log(f"  übersprungen ({ex}): {f['url']}")
                continue
            except Exception as ex:  # noqa: BLE001
                f["groesse"] = None
                log(f"  PDF nicht abfragbar ({ex}): {f['url']}")
            behalten.append(f)
        d["dateien"] = behalten

    # bekannte Archivfassungen aus dem AWMF-Register als frühere Fassungen merken (nur Name/Link)
    for d in neu:
        archiv = d.pop("_archiv", None)
        if archiv:
            d["_archiv_frueher"] = [{"url": f["url"], "name": f["name"], "groesse": None, "bis": None} for f in archiv]

    vollstaendig = seitenfehler <= max(3, len(eintraege) // 10)
    ergebnis, aenderungen = zusammenfuehren(alt_eigene, neu, zeit, vollstaendig)
    for d in ergebnis:
        extra = d.pop("_archiv_frueher", None)
        if extra:
            bekannt = {f["url"] for f in d.get("frueher", [])}
            d.setdefault("frueher", []).extend(f for f in extra if f["url"] not in bekannt)

    status.update({
        "ok": vollstaendig,
        "anzahl": len([d for d in ergebnis if not d.get("entfernt")]),
        "erfolgreich": zeit if vollstaendig else None,
        "fehler": None if vollstaendig else f"{seitenfehler} Dokumentseiten nicht lesbar",
        "aenderungen": aenderungen,
    })
    return ergebnis, status


def main() -> int:
    global PAUSE
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quellen", default=str(WURZEL / "pruefung" / "quellen.json"))
    ap.add_argument("--ausgabe", default=str(WURZEL / "versions.json"))
    args = ap.parse_args()

    konfig = json.loads(Path(args.quellen).read_text(encoding="utf-8"))
    PAUSE = float(konfig.get("pause_sekunden", PAUSE))
    ausgabe = Path(args.ausgabe)
    alt = {}
    if ausgabe.exists():
        try:
            alt = json.loads(ausgabe.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            log("Alte Versionsliste unlesbar – beginne neu.")
    alt_dokumente = alt.get("dokumente") or []
    alte_quellen = {q.get("id"): q for q in alt.get("quellen") or []}

    dokumente: list[dict] = []
    quellen: list[dict] = []
    for q in konfig["quellen"]:
        ergebnis, status = quelle_pruefen(q, alt_dokumente, float(konfig.get("mindestanteil", 0.6)))
        if not status.get("erfolgreich"):
            status["erfolgreich"] = (alte_quellen.get(q["id"]) or {}).get("erfolgreich")
        dokumente += ergebnis
        quellen.append(status)

    zeit = jetzt_iso()
    dokumente.sort(key=lambda d: (d.get("titel") or "").lower())
    daten = {
        "format": 1,
        "stand": zeit,
        "basis": alt.get("basis") or zeit,
        "hinweis": "Nur Titel, Links, Datum und Dateigröße – keine Inhalte der Dokumente.",
        "quellen": quellen,
        "dokumente": dokumente,
    }
    ausgabe.write_text(json.dumps(daten, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    zeilen = [f"## Versionsprüfung {zeit}"]
    for q in quellen:
        zeilen.append(f"- **{q['name']}**: {'ok' if q['ok'] else 'FEHLER'}, {q['anzahl']} Dokumente"
                      + (f" – {q['fehler']}" if q.get("fehler") else ""))
        for a in q.get("aenderungen") or []:
            zeilen.append(f"  - {a}")
    bericht = "\n".join(zeilen)
    log(bericht)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(bericht + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
