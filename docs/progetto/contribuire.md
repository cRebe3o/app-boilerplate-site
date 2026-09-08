# Contribuire al template

Il template non si sviluppa dentro il template. Si sviluppa in un **progetto generato**, dove il
codice compila, gira e si prova; poi le modifiche che si rivelano generali si riportano in
`app-boilerplate`. Questa pagina descrive quel giro: che cos'è `app-demo`, come si riportano le
modifiche, che cosa deve restare diverso, come si rilascia una versione e come si tiene aggiornato
questo sito.

## `app-demo`: il progetto di riferimento

`app-demo` è un progetto generato dal template e tenuto **allineato** ad esso: stesso codice
dell'impianto, con lo slug `AppDemo` al posto di `[[ project_slug ]]`. In più ha una sezione di
dominio dimostrativa — **Noleggi**: attrezzature, clienti, contratti — che nel template non
esiste e che serve a due cose:

- **provare l'impianto su un dominio vero**, con aggregati che hanno invarianti, value object,
  domain service, macchine a stati ed eventi fra aggregati;
- **fornire gli esempi** di questa documentazione: `RentalContract`, `Equipment`, `Customer`
  sono la reference implementation che le pagine di [Architettura](../architettura/il-dominio.md)
  descrivono.

La regola: **il template porta l'impianto, app-demo porta anche un dominio**. Tutto ciò che è
impianto va in entrambi; tutto ciò che è Noleggi resta in app-demo.

## Il giro: da app-demo al template

```
app-demo (branch di lavoro)            app-boilerplate/template
  modifica → build → test → commit  ──►  diff normalizzato → merge → verifica → commit → tag
```

### 1. Lavorare in app-demo

Si sviluppa e si committa in `app-demo` come in qualsiasi progetto. Conviene tenere le modifiche
dell'impianto in commit separati da quelle del dominio Noleggi: al momento di riportarle, il
confine è già tracciato.

### 2. Confrontare, normalizzando lo slug

I due repository differiscono per lo slug in **percorsi e contenuti**: `apps/backend/AppDemo.Api`
contro `apps/backend/[[ project_slug ]].Api`, `namespace AppDemo.Domain` contro
`namespace [[ project_slug ]].Domain`. Il confronto più affidabile non sostituisce stringhe: **rende
il template con le stesse risposte di app-demo** e confronta il risultato.

```bash
copier copy --trust --skip-tasks -f \
  -d project_name=AppDemo -d project_slug=AppDemo \
  -d api_port=5080 -d frontend_port=5173 \
  -d db_provider=SqlServer -d access_mode=public -d include_docker=false \
  -r HEAD C:\repos\app-boilerplate C:\tmp\render

diff -rq --strip-trailing-cr \
  --exclude=node_modules --exclude=.git --exclude=bin --exclude=obj --exclude=.nx \
  --exclude=coverage --exclude=dist --exclude=.copier-answers.yml \
  --exclude=appsettings.local.json --exclude=.env.local \
  C:\tmp\render C:\repos\app-demo
```

Due dettagli che risparmiano tempo:

- `-r HEAD` su un repository locale con modifiche non committate **le include**: si può
  confrontare il template mentre lo si sta modificando.
- `--strip-trailing-cr`, perché con `core.autocrlf` alcuni file del working tree sono CRLF e
  senza quell'opzione ogni file risulta diverso.

### 3. Riportare le modifiche

Per pochi file si copia a mano, sostituendo `AppDemo` → `[[ project_slug ]]`. Per un intervallo di
commit conviene un **merge a tre vie** per file, che applica al template solo il delta di app-demo
e lascia intatto ciò che nel template è diverso di proposito:

```bash
# base   = app-demo prima delle modifiche, slug normalizzato
# theirs = app-demo dopo,                  slug normalizzato
# ours   = il file del template (dal blob HEAD, per evitare i falsi conflitti CRLF)
git -C C:\repos\app-demo show <prima>:<file> | sed 's/AppDemo/[[ project_slug ]]/g' > base
git -C C:\repos\app-demo show <dopo>:<file>  | sed 's/AppDemo/[[ project_slug ]]/g' > theirs
git show HEAD:template/<file-normalizzato> > template/<file-normalizzato>
git merge-file -L template -L base -L app-demo template/<file-normalizzato> base theirs
```

I conflitti restano con i marcatori `<<<<<<<` e si risolvono a mano. Sono quasi sempre nei punti
elencati qui sotto.

### 4. Che cosa resta diverso, sempre

| Nel template | In app-demo | Perché |
|---|---|---|
| `[[ project_slug ]]`, `[[ api_port ]]`, `[[ access_mode ]]`, `[[ db_provider ]]`, blocchi `[% if include_docker %]` | valori concreti | Sono le variabili Copier: i file di configurazione si modificano **in place**, non si copiano |
| Nessuna sezione Noleggi: né entità, né endpoint, né pagine, né permessi, né dati demo, né migration `AddRentalsSection` | tutta la sezione | Il template non porta un dominio |
| Seed con `admin` / `Administrator` e `Seed:*` vuoti | identità reali | Niente account personali nel template |
| Migration: solo `InitialCreate` | anche quelle del dominio | Le migration del dominio sono del progetto |
| Esempi nelle skill e nei `CLAUDE.md` con nomi neutri (`Supplier`, `Prenotazione`) | esempi con `Equipment`, `RentalContract` | Un progetto generato non deve trovare riferimenti a codice che non ha |
| `appsettings.local.json` assente, `coverage/` ignorata | presenti in locale | Sono gitignored da entrambe le parti |

Dopo il merge, una ricerca di `Rental`, `Equipment`, `Customer`, `Noleggi`, `AppDemo` nel template
è il controllo più rapido.

### 5. Verificare generando un progetto

Il template non compila: lo si verifica **generando** un progetto in una cartella temporanea e
facendo girare tutto.

```bash
copier copy --trust -f -d project_name=Prova -d project_slug=Prova \
  -d api_port=5090 -d frontend_port=5174 -d db_provider=SqlServer \
  -d access_mode=public -d include_docker=true -r HEAD C:\repos\app-boilerplate C:\tmp\prova

cd C:\tmp\prova\apps\backend  && dotnet build Prova.sln && dotnet test Prova.sln
cd C:\tmp\prova\apps\frontend && pnpm vue-tsc --noEmit && pnpm eslint . && pnpm vitest run && pnpm build
```

> **Percorsi brevi.** Su Windows una cartella temporanea con un percorso lungo fa fallire pnpm in
> modo silenzioso: i link dentro `node_modules/.pnpm` superano i 260 caratteri e Vitest o Vite non
> trovano più i pacchetti. `C:\tmp\prova` va bene; una cartella annidata sotto `AppData` no.

Poi il confronto del punto 2, di nuovo: devono restare **solo** le differenze della tabella sopra.

### 6. Committare, aggiornare il changelog, taggare

Il commit sul template descrive le modifiche per area (backend, frontend, skill, documentazione).
Poi:

1. Una voce in `CHANGELOG.md` sotto *Non rilasciato*.
2. Quando si rilascia: si sposta il blocco sotto un numero di versione con la data, e si crea il
   tag — `copier update` lavora sui tag, e senza tag i progetti generati non hanno una versione a
   cui aggiornarsi.

```bash
git tag -a v1.1.0 -m "v1.1.0"
git push --tags
```

`major` quando un progetto generato deve intervenire a mano per aggiornarsi (rinomine, migration
dell'impianto, skill rimosse), `minor` per funzionalità nuove compatibili, `patch` per correzioni.

### 7. Riportare anche su app-demo

Se durante il merge si sono fatte pulizie o correzioni **solo nel template**, vanno riportate in
app-demo con lo stesso metodo al contrario, altrimenti al giro successivo ricompaiono come
differenze. Il criterio è sempre lo stesso: i due repository devono differire solo per la tabella
del punto 4.

## Aggiornare questo sito

Il sito vive in `app-boilerplate-site`: i Markdown in `docs/` sono la fonte, `npm run build`
genera gli HTML, e si committano entrambi (GitHub Pages serve i file statici).

Quando il template cambia in modo visibile — una convenzione, una chiave di configurazione, una
skill, un pacchetto pinnato — la pagina corrispondente va aggiornata **nello stesso giro**, non
dopo. La mappa:

| Cambia… | Pagina |
|---|---|
| una variabile Copier o un passo post-generazione | [Generare e aggiornare](generazione.md) |
| una chiave `appsettings` o una `VITE_*` | [Configurazione](configurazione.md) |
| una skill o un comando | [Le skill Claude](skill.md) |
| una convenzione del backend | [Comandi e query](../architettura/comandi-e-query.md), [Il codice](../infrastructure/implementazione.md) |
| una convenzione del frontend | [Struttura](../frontend/struttura.md), [Convenzioni e flussi](../frontend/convenzioni.md) |
| il percorso di una feature | [Aggiungere una feature](../guide/nuova-feature.md) |
| una scelta di progetto | [Decisioni](../infrastructure/decisioni.md) |

Gli esempi presi da app-demo restano tali, con la nota che lo dice: si aggiornano quando cambia
app-demo, non il template. Un controllo che vale la pena fare a ogni giro è cercare nei Markdown i
nomi che non esistono più (una skill rinominata, un pacchetto rimosso): un `grep` sui `docs/`
costa un minuto e trova le pagine rimaste indietro.

## Da qui

- [Generare e aggiornare](generazione.md) — `copier copy` e `copier update`, dall'altra parte del giro
- [Le skill Claude](skill.md) — le skill nascono nei progetti e tornano al template per questa strada
