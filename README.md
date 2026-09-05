# del-voltone-site

Sito della documentazione del progetto [DelVoltone](https://github.com/cRebe3o/del-voltone),
pubblicato con GitHub Pages.

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
build.mjs              il generatore + la struttura del sito
docs/
├── index.md           la home (le schede le genera build.mjs)
├── assets/style.css   l'unico foglio di stile
├── progetto/          panoramica del monorepo
├── database/          doppio provider: panoramica, architettura, implementazione, decisioni
├── autenticazione/    JWT e MSAL, app registration Azure
├── deploy/            Render
└── guide/             come si aggiunge una feature
```
