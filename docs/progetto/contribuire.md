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

## Che cosa serve a chi mantiene il template

Oltre ai prerequisiti di un progetto generato (vedi [Generare e aggiornare](generazione.md)):

- **Copier alla versione della Action**: è fissata in `.github/workflows/verify.yml`
  (`pipx install copier==…`), e Renovate la aggiorna lì;
- **`gh` autenticato** sul repository: `/rilascio-template` legge l'esito della Action con
  `gh run list` e `gh run view`, e senza ripete in locale la verifica di tutte le combinazioni;
- **l'estensione Claude in Chrome**, con cui Claude fa la prova nel browser prima di rilasciare
  (vedi [La prova nel browser](#la-prova-nel-browser));
- **l'app Renovate** installata sul repository del template (vedi
  [Aggiornare le dipendenze](#aggiornare-le-dipendenze)).

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
| non si vede: una skill, uno script, un test, una regola di lint, una correzione del backend senza effetti sull'interfaccia | direttamente nel template, verificando con la parte di verifica di `/rilascio-template` (vedi [Verificare](#verificare)) |
| si vede: una pagina, un componente, un comportamento dell'app | in `app-demo` **su un branch**, poi si porta nel template e il branch si butta |

Sono gli unici due modi di provare una modifica. Il "progetto LAB" generato a mano e rigenerato
a ogni modifica, descritto nelle vecchie guide `docs/01-new-project.md` e
`docs/02-update-project.md` del template, non si usa più: quelle guide ora rimandano a questo
sito.

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
`app-boilerplate`, si può usare a ogni modifica: genera dal commit corrente sei progetti, SQL Server
e PostgreSQL con e senza lavori programmati, più PostgreSQL con lavori e Grafana e SQL Server con
Grafana; lancia `pnpm verify` su tutti e sei, uno alla volta (insieme, un worker di Vitest può
morire per memoria); poi introduce apposta un errore, per provare che il controllo sappia diventare
rosso. Se la Action ha già un esito verde per lo stesso commit, si genera solo il progetto che serve
all'errore introdotto e alla prova nel browser.

> **Percorsi brevi.** Su Windows una cartella temporanea con un percorso lungo fa fallire pnpm in
> modo silenzioso: i link dentro `node_modules/.pnpm` superano i 260 caratteri e Vitest o Vite non
> trovano più i pacchetti. `C:\tmp\prova` va bene; una cartella annidata sotto `AppData` no.

### La Action

`.github/workflows/verify.yml` fa la stessa cosa su GitHub a ogni push su `main` e a ogni pull
request. Non parte quando cambiano solo `docs/**`, `CHANGELOG.md`, `renovate.json` e il `CLAUDE.md`
della radice, che non entrano nei progetti generati. I job sono **sette**:

| Job | Che cosa fa |
|---|---|
| `migration rilasciate` | Confronta le migration dell'impianto con l'ultimo tag: una migration rilasciata e poi cambiata, cancellata o rinominata fa fallire. Nei progetti generati quel controllo non ha una base con cui confrontare |
| `pnpm verify (SqlServer)` · `(PostgreSQL)` | Genera il progetto con quel provider e lancia `pnpm verify` |
| `pnpm verify (SqlServer, lavori)` · `(PostgreSQL, lavori)` | Lo stesso, con `include_jobs` |
| `pnpm verify (PostgreSQL, lavori, Grafana)` · `(SqlServer, Grafana)` | Lo stesso, con `include_grafana`: due combinazioni e non il doppio, così ogni provider e ogni risposta sui lavori passa almeno una volta con Grafana |

I job usano Node 26, .NET 10, pnpm alla versione di `packageManager` nel `package.json` del
template (con `pnpm/action-setup`: Node 26 non contiene più Corepack) e Copier alla versione
fissata. Il progetto si genera con `--vcs-ref HEAD`, cioè dal commit e non dall'ultimo tag. Una
combinazione rossa non ferma le altre.

`/rilascio-template` legge il suo esito: se riguarda esattamente ciò che si sta rilasciando (stesso
commit, o dopo cambiati solo file che la Action salta) e i sette job sono verdi, non ripete in
locale `pnpm verify` sulle sei combinazioni. La Action gira su Linux: non prova Windows, ma vede le
maiuscole nei percorsi, il fuso orario e i fine riga, che contano per chi fa il deploy su Linux.

#### Se è rossa

Un job rosso è un rosso anche se in locale passa, e non si rilascia finché non torna verde.

1. Si apre il job su GitHub (o `gh run view <id> --log-failed`) e si legge il passo fallito:
   `pnpm verify` stampa solo le righe d'errore dei passi rossi.
2. Si rigenera in locale **la stessa combinazione** dallo stesso commit (le risposte sono nel nome
   del job) e si lancia `pnpm verify` lì.
3. Si corregge nel template, si rigenera, si riverifica, si fa un push nuovo.

Vale anche per le pull request di Renovate: la correzione va nel branch della pull request, o in
`main` prima di unirla.

## Rilasciare a lotti

- Una correzione resta sotto *Non rilasciato* nel `CHANGELOG.md`, scritta per chi aggiorna un
  progetto: che cosa cambia e che cosa deve fare.
- Si rilascia a lotti, quando ce n'è abbastanza da valere un update. Subito solo per una
  vulnerabilità o un bug grave.
- Il rilascio lo avvia chi mantiene il template, con `/rilascio-template [versione]`. Claude dice
  quando il lotto è pronto o quando c'è un caso urgente, ma non lo avvia da solo.

La skill verifica, fa la prova nel browser, sceglie il numero, sposta la voce del CHANGELOG sotto la
versione con la data, poi crea commit e tag. Prima di pubblicare chiede **una sola conferma**, che
copre il push del template e quello del sito; **non** copre l'update e il push di app-demo, che fa
chi mantiene il template (vedi [L'ordine](#l-ordine-template-app-demo-sito)):

```bash
git push --atomic origin main v1.4.0
```

`--atomic` pubblica il commit e il suo tag insieme, o nessuno dei due: `copier update` lavora sui
tag, e senza tag i progetti generati non hanno una versione a cui aggiornarsi.

`major` quando un progetto generato deve intervenire a mano per aggiornarsi (rinomine, migration
dell'impianto, skill rimosse), `minor` per funzionalità nuove compatibili, `patch` per correzioni.
Che cosa chiede a mano ogni versione maggiore è in
[Generare e aggiornare](generazione.md#le-versioni-che-chiedono-qualcosa-a-mano).

### La prova nel browser

`pnpm verify` non apre l'app. Le modifiche che si vedono si provano una volta sola, a fine lotto, e la
prova la fa **Claude con Chrome** (l'estensione Claude in Chrome), dentro `/rilascio-template`, su
uno dei progetti di prova, prima di cancellarli. Non si chiede mai a chi mantiene il template.

- **Che cosa si prova.** In `docs/backlog.md` c'è la lista "Da provare nel browser a fine lotto":
  chi fa una modifica da vedere aggiunge la sua riga, con che cosa cliccare e che cosa aspettarsi.
  La lista si svuota quando il lotto esce, nello stesso commit del CHANGELOG. Vuota, la prova
  non si fa.
- **Come si prepara.** Claude scrive `appsettings.local.json` (segreto JWT casuale, database con un
  nome nuovo: LocalDB per SQL Server, un container su una porta diversa dalla 5432 per PostgreSQL)
  e `.env.local`, poi avvia backend e frontend. Se 5080 o 5173 sono occupate, di solito da
  app-demo, usa altre porte (per esempio 5081 e 5174) e non ferma processi che non ha avviato lui.
- **Come si clicca.** Le pagine si raggiungono con menu, voci e link, come fa chi usa l'app, mai
  scrivendo l'indirizzo: un indirizzo scritto a mano arriva alla pagina anche quando il link che
  dovrebbe portarci non naviga. Dalla 3.1.0 alla 6.0.0 le voci del menu laterale non navigavano, e
  nessuna prova se n'è accorta.
- **L'esito** è una tabella, una riga per prova. Un problema trovato si corregge prima di rilasciare,
  con il suo test; ciò che non blocca diventa una voce del backlog. Alla fine Claude chiude la
  scheda, ferma i processi che ha avviato e cancella il database di prova.

### L'ordine: template → app-demo → sito

1. **Template**: rilasciato, con il tag.
2. **app-demo**: l'update al nuovo tag lo avvia chi mantiene il template, con
   `/aggiorna-dal-template` in app-demo: Claude si ferma dopo il push del template e lo chiede. Poi
   `node scripts/confronta-app-demo.mjs` deve finire con `Nessuna differenza inattesa.` Una
   correzione fatta solo nel template e non arrivata con l'update si riporta in app-demo,
   altrimenti al giro dopo ricompare come differenza; una differenza voluta si aggiunge
   all'elenco, con il motivo. Un diff già in elenco ma cambiato si rilegge e poi si registra con
   `--approva <file>`.
3. **Sito**: si aggiornano le pagine toccate, secondo la mappa qui sotto, e la versione nel piè di
   pagina (`SITE.templateVersion` in `build.mjs`), a ogni rilascio anche quando nessuna pagina
   cambia.

In quest'ordine perché ogni passo documenta quello prima: app-demo prova il tag vero, e il sito
descrive ciò che è stato rilasciato e provato.

## Aggiornare le dipendenze

Le regole stanno in `docs/aggiornamenti.md` del template; in breve:

1. **Solo versioni LTS**, di .NET e di Node. .NET 11 si salta (finisce il supporto lo stesso giorno
   di .NET 10); i pacchetti legati a .NET restano sulla 10, tutti sulla stessa patch.
2. **Sicurezza subito**: una patch di .NET con CVE o un advisory su un pacchetto si mette nel
   template e si rilascia senza aspettare.
3. **Il resto, un lotto al mese**, dopo il Patch Tuesday di Microsoft: patch e versioni minori, uscite
   da almeno 7 giorni. Una versione maggiore diventa una voce del backlog.
4. **Si aggiorna solo il template**: i progetti generati ricevono tutto con `/aggiorna-dal-template`
   e non hanno un bot loro.

Le applica [Renovate](https://docs.renovatebot.com/), con `renovate.json` alla radice del template:
una pull request al mese con gli aggiornamenti del mese, una subito per la sicurezza, e le versioni
maggiori nella Dependency Dashboard, ferme finché non si approvano. Ogni pull request fa partire la
Action. Renovate e non Dependabot perché legge i file come testo, e i nomi con `[[ project_slug ]]`
non gli danno problemi.

### Quando arriva e che cosa si fa

| Arriva | Che cosa si fa |
|---|---|
| **"aggiornamenti del mese"**, dal 22 al 24 di ogni mese | Patch e minori uscite da almeno 7 giorni, in una pull request sola. Il 22 perché il Patch Tuesday di Microsoft cade fra l'8 e il 14 e, con i 7 giorni di attesa, la patch di .NET è matura al più tardi il 21. Con la Action verde si rilegge l'elenco (produzione o sviluppo, note di rilascio delle minori che cambiano comportamento), si fanno i controlli dei pacchetti di `/rilascio-template` (Hangfire.PostgreSql e il pin di Newtonsoft.Json), si scrive la voce sotto *Non rilasciato* nel CHANGELOG e si unisce. Il rilascio segue le regole dei lotti |
| **una pull request con l'etichetta `sicurezza`**, in qualsiasi momento | Si controlla, si unisce e si rilascia subito |
| **una versione maggiore**, nella issue "Dependency Dashboard" | Non apre una pull request da sola. Prima diventa una voce del backlog; quando si lavora a quella voce, si spunta la casella della maggiore nella Dashboard e Renovate apre la pull request |
| **una pull request rossa** | Come per la Action: si legge il passo fallito, si rigenera in locale la stessa combinazione, si corregge (vedi [Se è rossa](#se-e-rossa)) |

**Perché si saltano .NET 11 e i Node dispari.** Si resta sulle LTS: .NET 11 è una STS e finisce il
supporto lo stesso giorno di .NET 10, il 14 novembre 2028, quindi passarci costerebbe una
migrazione senza un giorno di supporto in più; il passaggio sarà a .NET 12. Di Node si usano solo
le maggiori pari: la Action è su Node 26. Il calendario, con le date di fine supporto e quando
diventa una voce del backlog il passaggio alla LTS successiva, è in `docs/aggiornamenti.md` del
template.

**Che cosa Renovate non copre:**

- l'SDK e il runtime di .NET e Node **installati sulle macchine** di sviluppo e sui server: una
  patch di .NET aggiorna i pacchetti, non le installazioni, e il CHANGELOG lo dice a chi aggiorna;
- le **immagini con un tag mobile**, come `2022-latest` di SQL Server: il tag si sposta da solo, si
  cambia solo la maggiore;
- le immagini `aspnet:10.0` e `sdk:10.0` prendono le patch alla build: sta a chi fa il deploy
  ricostruirle con `docker build --pull`.

## Aggiornare questo sito

Il sito vive in `app-boilerplate-site`: i Markdown in `docs/` sono la fonte, `npm run build`
genera gli HTML (e l'indice della ricerca), e si committano entrambi.

**Chi pubblica.** GitHub Pages serve i file di `docs/` dal branch `main` così come sono, senza
eseguire la build. La Action `build.yml` del sito **non pubblica**: a ogni push e pull request su
`main` rigenera gli HTML con `npm run build` (su Node 22) e fallisce se differiscono da quelli
committati, cioè se un `.md` è cambiato senza build o un `.html` è stato toccato a mano. Se è rossa,
si lancia `npm run build` e si committano gli HTML rigenerati.

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
| Hangfire, un lavoro programmato o il pannello | [Lavori programmati](../infrastructure/lavori-programmati.md) |
| una scelta di progetto | [Decisioni](../infrastructure/decisioni.md) |
| il modo di lavorare sul template | questa pagina |

Gli esempi presi da app-demo restano tali, con la nota che lo dice: si aggiornano quando cambia
app-demo, non il template. Un controllo che vale la pena fare a ogni giro è cercare nei Markdown i
nomi che non esistono più (una skill rinominata, un pacchetto rimosso): un `grep` sui `docs/`
costa un minuto e trova le pagine rimaste indietro.

## Da qui

- [Generare e aggiornare](generazione.md) — `copier copy` e `copier update`, dall'altra parte del giro
- [Le skill Claude](../claude/skill.md) — le skill nascono nei progetti e tornano al template per questa strada
