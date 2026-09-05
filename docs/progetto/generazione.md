# Generare e aggiornare un progetto

Un progetto non si clona dal template: si **genera**. Lo strumento è
[Copier](https://copier.readthedocs.io), che rende il template ripetibile in due modi — crea un
progetto nuovo rispondendo a delle domande, e sa **riportare nei progetti già generati** le
migliorie fatte al template dopo.

> Il repository `app-boilerplate` contiene le due guide operative complete, con i comandi
> PowerShell passo per passo: `docs/01-new-project.md` e `docs/02-update-project.md`. Questa pagina
> ne è il riassunto ragionato.

## Le variabili del template

Alla generazione Copier fa sette domande. Sono definite in `copier.yml` e determinano com'è fatto
il progetto che ne esce:

| Variabile | Che cos'è | Default | Dove si vede nel generato |
|---|---|---|---|
| `project_name` | Nome leggibile del progetto (può contenere spazi) | — | Titoli, etichette dell'interfaccia |
| `project_slug` | Nome tecnico, **PascalCase senza spazi** | `project_name` senza spazi | Namespace C#, nomi di cartelle, `.csproj` e `.sln`, `Issuer`/`Audience` del JWT |
| `api_port` | Porta dell'API in sviluppo | `5080` | `launchSettings.json`, `VITE_API_BASE_URL` |
| `frontend_port` | Porta del dev server Vite | `5173` | `vite.config.ts`, origin CORS di sviluppo |
| `db_provider` | `SqlServer` o `PostgreSQL` | `SqlServer` | `Database:Provider` in `appsettings.json`, immagine del `docker-compose.yml` |
| `access_mode` | `public` o `private` | `public` | `VITE_APP_ACCESS_MODE`, comportamento del router |
| `include_docker` | Generare o no il `docker-compose.yml` del database | `true` | Presenza del file in radice |

Due avvertenze che costano tempo:

> **`project_slug` non può contenere spazi.** Diventa un namespace C# e dei nomi di file: usa
> PascalCase (`GestioneOrdini`, non `Gestione Ordini`). `project_name` invece è solo un'etichetta.

> **`db_provider` non è una scelta definitiva.** Decide il valore iniziale di `Database:Provider` e
> quale database avvia Docker, ma il codice generato supporta **entrambi** i provider in ogni caso:
> si cambia idea da configurazione. Vedi [Infrastruttura](../infrastructure/panoramica.md).

### Come il template usa le variabili

Nel repository del template i file portano i segnaposto in una sintassi Jinja **ridefinita**:

```
[[ project_slug ]]      una variabile
[% if include_docker %] un blocco condizionale
```

I delimitatori standard `{{ }}` e `{% %}` non sono utilizzabili perché collidono con le
interpolazioni dei template Vue e delle stringhe C#. Per la stessa ragione il template non usa il
suffisso `.jinja`: **ogni** file viene renderizzato, comprese le cartelle
(`apps/backend/[[ project_slug ]].Api/`).

Conseguenza pratica: se in un progetto generato trovi un `[[` o un `[%`, una variabile non è stata
sostituita — è il primo controllo da fare sul generato.

## Generare un progetto nuovo

Serve Copier (via Python), preferibilmente in un ambiente isolato:

```powershell
python -m venv C:\tools\copier-venv
C:\tools\copier-venv\Scripts\pip install copier
```

Poi la generazione, che chiede le variabili in modo interattivo:

```powershell
copier copy --trust C:\repos\app-boilerplate C:\repos\mio-progetto
```

`--trust` serve perché il template esegue dei task post-generazione — `git init`, `pnpm install`,
`dotnet restore`, `dotnet tool restore` — che Copier non lancia senza autorizzazione esplicita. Con
`--skip-tasks` si generano i soli file, e allora `--trust` non serve.

Le risposte si possono passare anche da riga di comando con `--data project_slug="MioProgetto"` e
simili, utile per rigenerare lo stesso progetto più volte in modo identico.

**Il progetto nasce già nella sua sede definitiva**: non c'è un'area di staging da cui spostarlo. Se
qualcosa non torna, si cancella la cartella e si rigenera.

### Subito dopo la generazione

Il template lo dice da sé, in coda ai task, ma vale la pena averlo qui:

1. Copiare `apps/backend/<Progetto>.Api/appsettings.local.json.example` in
   `appsettings.local.json` (gitignored) e valorizzarlo: provider, connection string, secret JWT,
   password dell'amministratore iniziale.
2. Copiare `apps/frontend/.env.local.example` in `apps/frontend/.env.local` e valorizzarlo.
3. **Generare la prima migration** — una per provider:

```bash
dotnet dotnet-ef migrations add InitialCreate --project apps/backend/<Progetto>.Api --context SqlServerAppDbContext --output-dir Features/_Shared/Persistence/Migrations/SqlServer
dotnet dotnet-ef migrations add InitialCreate --project apps/backend/<Progetto>.Api --context PostgresAppDbContext  --output-dir Features/_Shared/Persistence/Migrations/Postgres
```

> **Il template non contiene migration**, e non è una dimenticanza: le cartelle
> `Migrations/SqlServer` e `Migrations/Postgres` nascono vuote. Una migration committata nel
> template diventerebbe un vincolo per ogni progetto generato — invece il primo `InitialCreate` è
> il primo file di storia del *tuo* progetto. Finché non le generi, l'applicazione parte ma il
> database resta senza schema.

Le migration si applicano poi da sole a ogni avvio (`MigrateAsync`).

### Verificare che il progetto sia sano

Tre controlli, in ordine di costo crescente:

| Controllo | Comando | Cerca |
|---|---|---|
| **Residui del template** | ricerca di `[[` o `[%` nei file generati | nessun risultato |
| **Nomi e porte coerenti** | ispezione di `launchSettings.json`, `vite.config.ts`, `.sln` | lo slug e le porte che hai scelto |
| **Compila** | `dotnet build apps/backend/<Progetto>.Api` e `npx vue-tsc --noEmit` | nessun errore |

## Aggiornare un progetto quando il template cambia

È la ragione per cui si usa un template Copier invece di un `git clone` iniziale. Quando
`app-boilerplate` riceve un bugfix, una convenzione nuova o dipendenze aggiornate, i progetti già
generati **non le prendono da soli**: le si porta con `copier update`.

```
   template                progetto generato
   ────────                ─────────────────
   v1.0.0  ─────────────▶  generato da qui  (_commit: v1.0.0 in .copier-answers.yml)
      │                          │
      │  bugfix, migliorie       │  il tuo lavoro: feature di dominio
      ▼                          ▼
   v1.1.0  ── copier update ──▶  il DELTA v1.0.0→v1.1.0 applicato come patch,
                                 conservando le tue modifiche
```

Il meccanismo si regge su un file: **`.copier-answers.yml`**, scritto in radice alla generazione.
Contiene le risposte date e `_commit`, cioè la versione del template da cui sei partito. Va
committato, e va committato di nuovo dopo ogni update.

### La procedura, in breve

| # | Passo | Perché |
|---|---|---|
| 1 | Working tree **pulito**, meglio su un branch dedicato | `copier update` sovrascrive file: senza commit non vedi cosa ha cambiato né puoi annullarlo |
| 2 | `copier update --trust` | Ri-pone le domande precompilate: Invio per tenere le risposte, oppure cambiane qualcuna |
| 3 | Risolvi i **conflitti** | Dove il template e il tuo codice toccano le stesse righe restano i marcatori `<<<<<<<` / `=======` / `>>>>>>>`, in stile Git. Copier può anche lasciare file `.rej`: hunk non applicati, da riportare a mano |
| 4 | Verifica che compili | Stesso giro dei controlli sulla generazione |
| 5 | Committa, `.copier-answers.yml` incluso | È così che il prossimo update saprà da dove ripartire |

Opzioni utili: `--pretend` mostra che cosa succederebbe senza scrivere nulla, `--vcs-ref v1.2.0`
aggiorna a una versione precisa invece che all'ultima.

**Il template deve avere dei tag di versione** (`v1.0.0`, `v1.1.0`, …): Copier aggiorna "all'ultimo
tag", e senza tag non ha una versione a cui puntare.

> Finché non committi, l'update vive solo nel working tree: se va storto, si scarta con Git come
> qualsiasi altra modifica.

## Da qui

- [Panoramica](panoramica.md) — che cosa contiene il progetto che hai appena generato
- [Le skill Claude](skill.md) — come aggiungere codice seguendo le convenzioni del template
- [Aggiungere una feature](../guide/nuova-feature.md) — la prima feature di dominio, end to end
