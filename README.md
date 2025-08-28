PartStore — webbasert lagerstyring

## Funksjoner
* Lokasjoner (navn + strekkode)
* Deler (min-beholdning, automatisk strekkode, beholdningsoversikt per lokasjon)
* Inn / Ut registrering (med antall) + historikk (lagres i stock_movements)
* Automatisk e‑postvarsel når total beholdning < min_qty (Office365 / SMTP)
* Generering av strekkode PNG via endpoint
* Mobilvennlig side med kamera‑skanning (QuaggaJS) og enkel innlogging

## Rask start (lokalt)
1. Kopier `.env.example` til `.env` og fyll ut SMTP variabler (se under) + ALERT_EMAIL.
2. Installer avhengigheter:
	```powershell
	npm install
	```
3. (Valgfritt) Kjør seed for å legge inn eksempeldata:
	```powershell
	npm run seed
	```
4. Start server:
	```powershell
	npm start
	```
5. Åpne http://localhost:3000 for desktop UI. Mobilside: http://localhost:3000/mobile.html

## Mobil kamera‑skanning
Krever HTTPS eller localhost. Når appen er deployet (f.eks. på Render) vil siden ha HTTPS og kameraet fungerer i moderne nettlesere (Chrome/Edge på Android, Safari på iOS).

## Miljøvariabler (.env)
```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=din_bruker@domene.no
SMTP_PASS=hemmelig_passord
ALERT_EMAIL=epost_som_skal_motta_varsel@domene.no
FROM_EMAIL=avsending@domene.no
```

## E‑postvarsling
Når en UT‑registrering fører til at total beholdning for en del synker under `min_qty`, sendes e‑post til `ALERT_EMAIL`.

## Deploy til Render (HTTPS)
1. Opprett et nytt Git repository og push prosjektet til GitHub/GitLab.
2. Logg inn på https://render.com og velg New + Web Service.
3. Koble til repoet ditt.
4. Velg: 
	* Environment: Node
	* Build Command: `npm install`
	* Start Command: `node server.js`
	* Region: nærmest brukerne
5. Legg inn miljøvariabler under Settings -> Environment (kopier innhold fra din lokale `.env`). Ikke sjekk inn `.env` i Git.
6. Deploy. Render gir deg en HTTPS URL (f.eks. https://partstore.onrender.com). 
7. Åpne `/mobile.html` på mobilen for kamera‑skanning.

## Backup av database
Filen `partstore.db` ligger i rot. Ta jevnlige kopier (cold backup) eller eksporter til CSV ved behov. For Render (ephemeral disk) bør du bruke en ekstern vedvarende lagring (Render disk eller flytt til Postgres).

## Videre forbedringer (forslag)
* Rollebasert autentisering / JWT
* Paginering og søk i deler
* Eksport / rapporter (CSV / Excel)
* Dashboard med kritisk lav lagerstatus
* Migrering til Postgres for multi‑instance drift
* Rate limiting / audit logging

## Lisens
Intern bruk – legg til lisensfil hvis delt eksternt.

---
Kort sagt: push til Git, deploy på Render, legg inn miljøvariabler, og du får HTTPS (kamera fungerer). Trenger du hjelp med Postgres / auth, si fra.
