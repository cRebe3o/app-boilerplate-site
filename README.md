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
build.

## Modificare una pagina

Si modifica il `.md`, si esegue `npm run build`, si committa.

## Aggiungere una pagina

1. Crea il `.md` nella cartella della sezione (o in una nuova).
2. Aggiungi una voce alla struttura `SITE` in [`build.mjs`](build.mjs), con titolo e sommario.

Da lì la pagina compare **da sola** nella barra laterale, nella home e nell'ordine di lettura:
`SITE` è l'unica fonte per tutti e tre.

## Struttura

```
build.mjs               il generatore + la struttura del sito
docs/
├── index.md            la home (le schede le genera build.mjs)
├── assets/style.css    l'unico foglio di stile
├── progetto/           panoramica, generazione con Copier, skill Claude
├── infrastructure/     doppio provider SQL e impianto: panoramica, architettura,
│                       implementazione, decisioni
├── autenticazione/     JWT, MSAL e Windows; app registration Azure
├── deploy/             Render
└── guide/              come si aggiunge una feature
```

## Tenerlo allineato al template

La documentazione descrive il codice di [`app-boilerplate`](https://github.com/cRebe3o/app-boilerplate):
quando il template cambia in modo visibile — una convenzione, una variabile Copier, una skill, un
pacchetto pinnato — la pagina corrispondente va aggiornata qui.
