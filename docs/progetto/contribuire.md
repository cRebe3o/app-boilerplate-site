# Contribuire al template

Il lavoro sul template segue poche regole, scritte nel `CLAUDE.md` alla radice di
`app-boilerplate`: si riparte da un backlog, una modifica che si vede si prova prima in `app-demo`
su un branch, si rilascia a lotti. Questa pagina descrive il giro: che cos'è `app-demo`, dove si
lavora, come si porta una modifica nel template, come si verifica e si rilascia, e come si tiene
aggiornato questo sito.

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

## Da dove si parte: il backlog

I lavori aperti stanno in `docs/backlog.md`, nel repository del template. Ogni voce dice che cosa,
perché, dove (template, app-demo, sito), la priorità, le decisioni già prese ed eventualmente che
cosa la blocca.

- Si riparte dalla voce con priorità più alta che non sia bloccata.
- Ciò che emerge per strada e non si fa subito diventa una voce nuova.
- Una voce finita si sposta in `docs/backlog-done.md`, in cima: titolo, una riga su che cosa è stato
  fatto, versione ("prossima versione" finché non esce, poi `vx.y.z` al rilascio) e commit.
- Le decisioni già scritte in una voce non si ridiscutono: chi la riprende parte da lì.

## Dove si lavora

Dipende da una domanda: **la modifica si vede?**

| La modifica | Dove si lavora |
|---|---|
| non si vede: una skill, uno script, un test, una regola di lint, una correzione del backend senza effetti sull'interfaccia | direttamente nel template, verificando con un progetto generato |
| si vede: una pagina, un componente, un comportamento dell'app | in `app-demo` **su un branch**, poi si porta nel template e il branch si butta |

```
app-demo, branch di prova  ──►  template  ──►  rilascio (tag)  ──►  app-demo main
   (alla fine si butta)                                              con /aggiorna-dal-template
```

Il branch di prova si butta perché in `app-demo` la modifica deve arrivare **dal rilascio**, con
`/aggiorna-dal-template`, come arriva a qualsiasi progetto generato. Così l'update prova il tag
vero, e un conflitto o un passo a mano che toccherà agli altri progetti si vede prima su
`app-demo`.

## Portare una modifica da app-demo al template

### 1. Confrontare, normalizzando lo slug

I due repository differiscono per lo slug in **percorsi e contenuti**: `apps/backend/AppDemo.Api`
contro `apps/backend/[[ project_slug ]].Api`, `namespace AppDemo.Domain` contro
`namespace [[ project_slug ]].Domain`. Il confronto più affidabile non sostituisce stringhe: **rende
il template con le stesse risposte di app-demo** e confronta il risultato.

```bash
copier copy --trust --skip-tasks -f \
  -d project_name=AppDemo -d project_slug=AppDemo \
  -d api_port=5080 -d frontend_port=5173 \
  -d db_provider=SqlServer -d access_mode=public -d include_docker=true \
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

### 2. Riportare le modifiche

Per pochi file si copia a mano, sostituendo `AppDemo` → `[[ project_slug ]]`. Per più commit del
branch di prova conviene un **merge a tre vie** per file, che applica al template solo il delta del
branch e lascia intatto ciò che nel template è diverso di proposito:

```bash
# base   = app-demo main, prima del branch, slug normalizzato
# theirs = la punta del branch di prova,   slug normalizzato
# ours   = il file del template (dal blob HEAD, per evitare i falsi conflitti CRLF)
git -C C:\repos\app-demo show main:<file>     | sed 's/AppDemo/[[ project_slug ]]/g' > base
git -C C:\repos\app-demo show <branch>:<file> | sed 's/AppDemo/[[ project_slug ]]/g' > theirs
git show HEAD:template/<file-normalizzato> > template/<file-normalizzato>
git merge-file -L template -L base -L app-demo template/<file-normalizzato> base theirs
```

I conflitti restano con i marcatori `<<<<<<<` e si risolvono a mano. Sono quasi sempre nei punti
elencati qui sotto. Finito il merge, il branch di prova si cancella.

### 3. Che cosa resta diverso, sempre

L'elenco che fa fede è `docs/differenze-app-demo.yml`, nel repository del template. Il comando
`node scripts/confronta-app-demo.mjs` genera il progetto dalla versione registrata in app-demo e
mostra solo ciò che esce da quell'elenco. La tabella qui sotto ne spiega il senso.

| Nel template | In app-demo | Perché |
|---|---|---|
| `[[ project_slug ]]`, `[[ api_port ]]`, `[[ access_mode ]]`, `[[ db_provider ]]`, blocchi `[% if include_docker %]` | valori concreti | Sono le variabili Copier: i file di configurazione si modificano **in place**, non si copiano |
| Nessuna sezione Noleggi: né entità, né endpoint, né pagine, né permessi, né dati demo, né migration `AddRentalsSection` | tutta la sezione | Il template non porta un dominio |
| Migration: solo `InitialCreate` | anche quelle del dominio | Le migration del dominio sono del progetto |
| Esempi nelle skill e nei `CLAUDE.md` con nomi neutri (`Supplier`, `Prenotazione`) | esempi con `Equipment`, `RentalContract` | Un progetto generato non deve trovare riferimenti a codice che non ha |
| `appsettings.local.json` assente, `coverage/` ignorata | presenti in locale | Sono gitignored da entrambe le parti |

Dopo il merge, una ricerca di `Rental`, `Equipment`, `Customer`, `Noleggi`, `AppDemo` nel template
è il controllo più rapido.

## Verificare

Il template non compila: lo si verifica **generando** un progetto in una cartella temporanea e
lanciando `pnpm verify`. La parte di verifica di `/rilascio-template`, alla radice di
`app-boilerplate`, si può usare a ogni modifica: genera un progetto per provider (SQL Server e
PostgreSQL) dal commit corrente, lancia `pnpm verify` su entrambi e poi introduce apposta un errore,
per provare che il controllo sappia diventare rosso.

> **Percorsi brevi.** Su Windows una cartella temporanea con un percorso lungo fa fallire pnpm in
> modo silenzioso: i link dentro `node_modules/.pnpm` superano i 260 caratteri e Vitest o Vite non
> trovano più i pacchetti. `C:\tmp\prova` va bene; una cartella annidata sotto `AppData` no.

### La Action

`.github/workflows/verify.yml` fa la stessa cosa su GitHub a ogni push su `main` e a ogni pull
request: genera i due progetti e lancia `pnpm verify` su ciascuno. Non parte quando cambiano solo
`docs/**`, `CHANGELOG.md` e il `CLAUDE.md` della radice, che non entrano nei progetti generati.

`/rilascio-template` legge il suo esito: se riguarda esattamente ciò che si sta rilasciando, e i due
job sono verdi, non ripete in locale la verifica dei due progetti. Un job rosso è un rosso anche se
in locale passa. La Action gira su Linux: non prova Windows, ma vede le maiuscole nei percorsi, il
fuso orario e i fine riga, che contano per chi fa il deploy su Linux.

## Rilasciare a lotti

- Una correzione resta sotto *Non rilasciato* nel `CHANGELOG.md`, scritta per chi aggiorna un
  progetto: che cosa cambia e che cosa deve fare.
- Si rilascia a lotti, quando ce n'è abbastanza da valere un update. Subito solo per una
  vulnerabilità o un bug grave.
- Il rilascio lo avvia chi mantiene il template, con `/rilascio-template [versione]`. Claude dice
  quando il lotto è pronto o quando c'è un caso urgente, ma non lo avvia da solo.

La skill verifica, sceglie il numero, sposta la voce del CHANGELOG sotto la versione con la data, poi
crea commit e tag. Prima di pubblicare chiede una conferma, che vale anche per il sito:

```bash
git push --atomic origin main v1.4.0
```

`--atomic` pubblica il commit e il suo tag insieme, o nessuno dei due: `copier update` lavora sui
tag, e senza tag i progetti generati non hanno una versione a cui aggiornarsi.

`major` quando un progetto generato deve intervenire a mano per aggiornarsi (rinomine, migration
dell'impianto, skill rimosse), `minor` per funzionalità nuove compatibili, `patch` per correzioni.

### L'ordine: template → app-demo → sito

1. **Template**: rilasciato, con il tag.
2. **app-demo**: l'update al nuovo tag lo avvia chi mantiene il template, con
   `/aggiorna-dal-template` in app-demo: Claude si ferma dopo il push del template e lo chiede. Poi
   `node scripts/confronta-app-demo.mjs` deve finire con `Nessuna differenza inattesa.` Una
   correzione fatta solo nel template e non arrivata con l'update si riporta in app-demo,
   altrimenti al giro dopo ricompare come differenza; una differenza voluta si aggiunge
   all'elenco, con il motivo. Un diff già in elenco ma cambiato si rilegge e poi si registra con
   `--approva <file>`.
3. **Sito**: si aggiornano le pagine toccate, secondo la mappa qui sotto.

In quest'ordine perché ogni passo documenta quello prima: app-demo prova il tag vero, e il sito
descrive ciò che è stato rilasciato e provato.

## Aggiornare questo sito

Il sito vive in `app-boilerplate-site`: i Markdown in `docs/` sono la fonte, `npm run build`
genera gli HTML, e si committano entrambi (GitHub Pages serve i file statici, e una GitHub Action
fallisce se Markdown e HTML divergono).

Quando il template cambia in modo visibile — una convenzione, una chiave di configurazione, una
skill, un pacchetto pinnato — la pagina corrispondente va aggiornata **nello stesso giro**, dopo il
rilascio. La mappa:

| Cambia… | Pagina |
|---|---|
| una variabile Copier o un passo post-generazione | [Generare e aggiornare](generazione.md) |
| una chiave `appsettings` o una `VITE_*` | [Configurazione](configurazione.md) |
| una skill o un comando | [Le skill Claude](../claude/skill.md) |
| una convenzione del backend | [Comandi e query](../architettura/comandi-e-query.md), [Il codice](../infrastructure/implementazione.md) |
| una convenzione del frontend | [Struttura](../frontend/struttura.md), [Convenzioni e flussi](../frontend/convenzioni.md) |
| il percorso di una feature | [Aggiungere una feature](../guide/nuova-feature.md) |
| una scelta di progetto | [Decisioni](../infrastructure/decisioni.md) |
| il modo di lavorare sul template | questa pagina |

Gli esempi presi da app-demo restano tali, con la nota che lo dice: si aggiornano quando cambia
app-demo, non il template. Un controllo che vale la pena fare a ogni giro è cercare nei Markdown i
nomi che non esistono più (una skill rinominata, un pacchetto rimosso): un `grep` sui `docs/`
costa un minuto e trova le pagine rimaste indietro.

## Da qui

- [Generare e aggiornare](generazione.md) — `copier copy` e `copier update`, dall'altra parte del giro
- [Le skill Claude](../claude/skill.md) — le skill nascono nei progetti e tornano al template per questa strada
