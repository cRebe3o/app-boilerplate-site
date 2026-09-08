# app-boilerplate-site

Sito della documentazione del template **app-boilerplate**, da cui nascono i progetti gestionali
(monorepo .NET + Vue 3). Pubblicato con GitHub Pages.

## Come funziona

I file **Markdown in `docs/` sono l'unica fonte**. L'HTML è generato da `build.mjs` e non va
modificato a mano: la prossima build lo sovrascrive.

```bash
npm install      # una volta sola
npm run build    # rigenera tutti gli .html
```

Poi si committano **sia i `.md` sia gli `.html`**: GitHub Pages serve file statici, non esegue la
build. Il workflow `.github/workflows/build.yml` rigenera tutto a ogni push e **fallisce se gli
HTML committati non corrispondono ai Markdown**: è la rete contro un `.md` modificato senza build.

La build produce anche `docs/assets/search-index.js`, l'indice della ricerca nella barra laterale
(una voce per sezione di ogni pagina): si committa come gli HTML.

## Modificare una pagina

Si modifica il `.md`, si esegue `npm run build`, si committa.

## Aggiungere una pagina

1. Crea il `.md` nella cartella della sezione (o in una nuova).
2. Aggiungi una voce alla struttura `SITE` in [`build.mjs`](build.mjs), con titolo e sommario.

Da lì la pagina compare **da sola** nella barra laterale, nella home, nell'ordine di lettura e
nell'indice di ricerca: `SITE` è l'unica fonte per tutti.

## Versione del template

Il piè di pagina dichiara a quale versione di `app-boilerplate` corrispondono le pagine:
`SITE.templateVersion` in [`build.mjs`](build.mjs). Va aggiornata quando il template riceve un tag
(vedi il suo `CHANGELOG.md`).

## Struttura

```
build.mjs               il generatore + la struttura del sito
.github/workflows/      la verifica che gli HTML siano allineati ai Markdown
docs/
├── index.md            la home (le schede le genera build.mjs)
├── assets/style.css    l'unico foglio di stile
├── assets/search-index.js   generato: l'indice della ricerca
├── progetto/           panoramica, generazione, configurazione, skill Claude, contribuire
├── architettura/       Clean Architecture, dominio, comandi e query
├── frontend/           struttura del progetto Vue, convenzioni e flussi
├── infrastructure/     doppio provider SQL e impianto: modello EF, codice, audit log,
│                       decisioni
├── autenticazione/     JWT, MSAL e Windows; app registration Azure
├── guide/              aggiungere una feature, testare il backend
└── deploy/             Render
```

## Tenerlo allineato al template

La documentazione descrive il codice di [`app-boilerplate`](https://github.com/cRebe3o/app-boilerplate):
quando il template cambia in modo visibile — una convenzione, una variabile Copier, una skill, un
pacchetto pinnato — la pagina corrispondente va aggiornata qui.
