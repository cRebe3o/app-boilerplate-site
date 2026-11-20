# Generare e aggiornare un progetto

Un progetto non si clona dal template: si **genera**. Lo strumento è
[Copier](https://copier.readthedocs.io), che rende il template ripetibile in due modi — crea un
progetto nuovo rispondendo a delle domande, e sa **riportare nei progetti già generati** le
migliorie fatte al template dopo.

> Il repository `app-boilerplate` contiene le due guide operative complete, con i comandi
> PowerShell passo per passo: `docs/01-new-project.md` e `docs/02-update-project.md`. Questa pagina
> ne è il riassunto ragionato.

## Prerequisiti

| Strumento | Versione | Note |
|---|---|---|
| **.NET SDK** | 10 | `dotnet --version`. Il tool `dotnet-ef` non va installato globalmente: è un tool locale del progetto, ripristinato da `dotnet tool restore` (il manifest è nella cartella del progetto Api) |
| **Node.js** | 26 LTS (minimo 22.22.2, o 24.15.0 sulla 24) | Il minimo lo fissano Vitest 5, vue-i18n 11 e `nopt` (da `@vue/test-utils`). Node 20 non è più supportato |
| **pnpm** | 12 | Il `packageManager` del progetto è `pnpm@12.18.0`. Si installa in qualsiasi modo, per esempio `npm install -g pnpm`; un pnpm 10 o 11 già installato va bene lo stesso, perché passa da solo alla 12. Node 26 non contiene più Corepack: chi lo preferisce lo installa con `npm install -g corepack`, poi `corepack enable`. Un pnpm 9 avvisa ma resta alla 9: va aggiornato o tolto |
| **Python + Copier** | Python 3.10+, Copier 9 | Solo per generare e aggiornare; conviene un ambiente virtuale dedicato (sotto) |
| **Git** | qualsiasi recente | Copier lavora sui tag del template e `git init` fa parte dei task post-generazione |
| **Database** | SQL Server o PostgreSQL | In locale: LocalDB (arriva con Visual Studio), un container Docker (`include_docker=true` genera il `docker-compose.yml`), o un'installazione nativa di PostgreSQL |
| **Docker Desktop** | facoltativo | Solo per il database in container |

Le versioni esatte dei pacchetti .NET e npm sono pinnate nei `.csproj` e nei `package.json` del
template: non serve sceglierle.

## Le variabili del template

Alla generazione Copier fa otto domande. Sono definite in `copier.yml` e determinano com'è fatto
il progetto che ne esce:

| Variabile | Che cos'è | Default | Dove si vede nel generato |
|---|---|---|---|
| `project_name` | Nome leggibile del progetto (può contenere spazi) | — | Titoli, etichette dell'interfaccia |
| `project_slug` | Nome tecnico, **PascalCase senza spazi** | `project_name` senza spazi | Namespace C#, nomi di cartelle, `.csproj` e `.sln`, `Issuer`/`Audience` del JWT |
| `api_port` | Porta dell'API in sviluppo | `5080` | `launchSettings.json`, `VITE_API_BASE_URL` |
| `frontend_port` | Porta del dev server Vite | `5173` | `vite.config.ts`, origin CORS di sviluppo |
| `db_provider` | `SqlServer` o `PostgreSQL` | `SqlServer` | `Database:Provider` in `appsettings.json`, immagine del `docker-compose.yml` |
| `access_mode` | `public` o `private` | `public` | `VITE_APP_ACCESS_MODE`, comportamento del router e della pagina di login |
| `include_docker` | Generare o no il `docker-compose.yml` del database | `true` | Presenza del file in radice |
| `include_jobs` | I lavori programmati con Hangfire, e il loro pannello | `false` | Cartelle `Jobs` in Api, Application, Infrastructure e test; voce "Lavori programmati" in Sistema; permesso `jobs.dashboard` |
| `include_grafana` | Grafana per metriche, log e tracce, in sviluppo e in produzione | `false` | Container `lgtm` al posto dell'Aspire Dashboard nel `docker-compose.yml`; cartella `observability/`; voce "Metriche" in Sistema; permesso `telemetry.dashboard`; chiavi di sviluppo create da `scripts/grafana-keys.mjs` |

Due avvertenze che costano tempo:

> **`project_slug` non può contenere spazi.** Diventa un namespace C# e dei nomi di file: usa
> PascalCase (`GestioneOrdini`, non `Gestione Ordini`). `project_name` invece è solo un'etichetta.

> **`include_jobs` si può cambiare dopo.** Chi risponde no non riceve niente di Hangfire: né
> pacchetti, né codice, né tabelle. Per averli più avanti, `copier update --trust --data
> include_jobs=true`. Vedi [Lavori programmati](../infrastructure/lavori-programmati.md).

> **Anche `include_grafana` si può cambiare dopo**, con `copier update --trust --data
> include_grafana=true`: arrivano container, dashboard, proxy e configurazione di produzione, il
> seed aggiunge il permesso al primo avvio e Copier crea le chiavi di sviluppo. Vedi
> [Observability](../deploy/observability.md#con-grafana-include-grafana).

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
   utente amministratore iniziale (`Seed:AdminUsername`, `Seed:AdminEmail`,
   `Seed:AdminDisplayName`, `Seed:AdminPassword`; i default sono `admin` / `Administrator`, e in
   sviluppo una password vuota vale `Admin@1234`, che la pagina di login mostra). Con
   `access_mode` `private` in produzione il login con password è spento: l'admin entra con
   Microsoft o Windows (vedi [Configurazione](configurazione.md#auth)).
2. Copiare `apps/frontend/.env.local.example` in `apps/frontend/.env.local` e valorizzarlo.
3. **Avviare il backend.** La migration `InitialCreate` è già inclusa per entrambi i provider: si
   applica da sola all'avvio (`MigrateAsync`), crea il database se non esiste e, su un database
   vuoto, parte il seed di permessi, ruoli e utenti.

Le migration **successive** — quelle del tuo dominio — vanno generate una per provider:

```bash
cd apps/backend/<Progetto>.Api

dotnet dotnet-ef migrations add <Nome>   --project ../<Progetto>.Infrastructure/<Progetto>.Infrastructure.csproj   --startup-project <Progetto>.Api.csproj   --context SqlServerAppDbContext --output-dir Persistence/Migrations/SqlServer

dotnet dotnet-ef migrations add <Nome>   --project ../<Progetto>.Infrastructure/<Progetto>.Infrastructure.csproj   --startup-project <Progetto>.Api.csproj   --context PostgresAppDbContext  --output-dir Persistence/Migrations/Postgres
```

> **Perché `InitialCreate` è nel template.** Descrive lo schema dell'impianto (utenti, ruoli,
> permessi, log, configurazione), che è identico per ogni progetto generato: rigenerarla a mano
> in ogni progetto produrrebbe lo stesso file con un timestamp diverso. Le migration del *tuo*
> dominio vengono dopo, e sono la storia del tuo progetto.

### Verificare che il progetto sia sano

Tre controlli, in ordine di costo crescente:

| Controllo | Comando | Cerca |
|---|---|---|
| **Residui del template** | ricerca di `[[` o `[%` nei file generati | nessun risultato |
| **Nomi e porte coerenti** | ispezione di `launchSettings.json`, `vite.config.ts`, `.sln` | lo slug e le porte che hai scelto |
| **Compila e passa i test** | `dotnet build apps/backend/<Progetto>.sln`, `dotnet test apps/backend/<Progetto>.sln`; in `apps/frontend`: `pnpm vue-tsc --noEmit`, `pnpm eslint .`, `pnpm vitest run` | nessun errore |

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
| 2 | `copier update --trust` | Ri-pone le domande precompilate: Invio per tenere le risposte, oppure cambiane qualcuna. Le domande **nuove** del template compaiono con il loro default |
| 3 | Risolvi i **conflitti** | Dove il template e il tuo codice toccano le stesse righe restano i marcatori `<<<<<<<` / `=======` / `>>>>>>>`, in stile Git. Copier può anche lasciare file `.rej`: hunk non applicati, da riportare a mano |
| 4 | Verifica che compili | Stesso giro dei controlli sulla generazione |
| 5 | Committa, `.copier-answers.yml` incluso | È così che il prossimo update saprà da dove ripartire |

Opzioni utili: `--pretend` mostra che cosa succederebbe senza scrivere nulla, `--vcs-ref v1.2.0`
aggiorna a una versione precisa invece che all'ultima.

> **Con `--defaults` le domande nuove non si vedono.** Senza terminale (uno script, Claude Code)
> si lancia `copier update --trust --skip-tasks --defaults`, che tiene le risposte salvate e dà
> **in silenzio** il default a ogni domanda nuova: con la v7.1.0 `include_grafana` è finita a no
> così. Prima si confrontano le domande di `copier.yml` della versione di arrivo con
> `.copier-answers.yml`, e la risposta a ognuna di quelle nuove si passa con
> `--data <domanda>=<risposta>`. `--skip-tasks` salta anche i `_tasks` del template: dopo l'update
> si lanciano a mano quelli che valgono per il progetto (`pnpm install`, `dotnet tool restore`,
> `node scripts/grafana-keys.mjs` con Grafana). `/aggiorna-dal-template` fa entrambe le cose da
> sé.

**Alcuni file sono del progetto dopo la generazione**: il template li crea e l'update non li
sovrascrive più (`_skip_if_exists` in `copier.yml`). Oggi è uno solo,
`Domain/Exceptions/ErrorCode.Project.cs`, con i codici di errore del progetto; quelli del template
stanno in `ErrorCode.cs`, che invece si aggiorna.

**Il template deve avere dei tag di versione** (`v1.0.0`, `v1.1.0`, …): Copier aggiorna "all'ultimo
tag", e senza tag non ha una versione a cui puntare.

> Finché non committi, l'update vive solo nel working tree: se va storto, si scarta con Git come
> qualsiasi altra modifica.

### Le versioni che chiedono qualcosa a mano

Una versione **maggiore** del template vuol dire che dopo l'update qualcosa si fa a mano. Il
dettaglio è nel `CHANGELOG.md` del template, alla voce *Che cosa fa chi aggiorna* di ogni versione.

**7.0.0 — correzioni di sicurezza.** Dopo l'update:

| Chi | Che cosa fa |
|---|---|
| Tutti | Niente, ma lo sa: **tutti gli utenti escono una volta**. I refresh token salvati prima non valgono più (ora c'è l'hash) e i token di accesso senza impronta vengono rifiutati: si rientra con un login |
| Chi pubblica dietro un proxy (Render, IIS, nginx) | Configura `ForwardedHeaders`, **altrimenti il login con password si blocca per tutti** dopo dieci errori. Vedi [Configurazione](configurazione.md#forwardedheaders) e, per Render, [Deploy su Render](../deploy/render.md#indirizzo-del-client-e-limite-dei-login) |
| Chi usa il login Windows fuori da Development | Imposta `Auth__Windows__Enabled=true`: senza, `/api/auth/windows-login` risponde 404 |
| Chi ha un database creato fuori da Development con una versione precedente | Controlla nella pagina Utenti: il seed creava un utente Windows SuperAdmin senza password, con il nome dell'account del servizio. Se nessuno lo usa, va eliminato |
| Chi è in produzione | Controlla che `Auth__Jwt__Secret` sia casuale e lungo almeno 32 caratteri: altrimenti l'API non parte |
| Chi usa Swagger in produzione | Lo riaccende con `OpenApi__Enabled=true` |
| Chi aveva dato apposta `permissions.read` ai Viewer | Lo dà a un ruolo personalizzato: il seed lo toglie ai ruoli di sistema (lo scrive nel log, una volta). Per il resto i database esistenti non chiedono niente |
| Chi ha scritto codice nel progetto | Un handler che assegna ruoli, gruppi o permessi usa `IAdministrationRules`; un endpoint anonimo nuovo va nell'elenco di `EndpointAuthorizationTests`; un test che costruisce a mano `CreateUserHandler`, `ChangePasswordHandler`, `SystemConfigRepository` o i due handler di reset riceve i parametri nuovi dei costruttori; una `v-snackbar` copiata fuori da `App.vue` prende `:close-on-back="false"` |

Che cosa cambia, nel dettaglio: [Autenticazione](../autenticazione/autenticazione.md#sicurezza-che-cosa-e-in-piedi)
per sessioni, ruoli e intestazioni, [Configurazione](configurazione.md) per le chiavi nuove,
[Audit log](../infrastructure/audit-log.md) per i reset registrati.

**7.0.1** riporta la barra in alto al blu della 6.1.0 (la 7.0.0 l'aveva resa grigio scuro): chi
passa dalla 6.1.0 direttamente alla 7.0.1 o successiva non vede cambiamenti di colore. **7.0.2**
non chiede niente: cambia solo l'intestazione di `api.generated.ts`, e se l'update la segna in
conflitto si tiene una delle due versioni e si lancia `pnpm gen:api`.

**8.0.0 — login con password spegnibile, permessi e regola di riserva.** Dopo l'update:

| Chi | Che cosa fa |
|---|---|
| Chi ha `access_mode` `private` | **In produzione il login con password si spegne** (`appsettings.Production.json`). Prima di pubblicare configura `Auth:Msal` (o accende `Auth:Windows:Enabled`) e controlla che chi amministra abbia un utente con il suo account Microsoft o Windows; le password già salvate restano nel database ma non servono più. Per tenere la password: `Auth__Password__Enabled=true`. Se l'update segna in conflitto `appsettings.Production.json`, si tiene il blocco `Password` |
| Chi ha endpoint anonimi propri | Un endpoint senza `RequireAuthorization` che deve restare pubblico ora risponde 401 (regola di riserva): gli aggiunge `.AllowAnonymous()` e la riga in `Anonymous` di `EndpointAuthorizationTests` |
| Chi ha ruoli personalizzati con permessi riservati al SuperAdmin | Al primo avvio il seed li toglie (riga "Seed: tolti ai ruoli i permessi riservati al SuperAdmin" nel log). Chi apriva il pannello dei lavori o Grafana con un ruolo personalizzato ora deve avere il ruolo SuperAdmin |
| Chi ha scritto codice nel progetto | `CreateUserCommand.Password` può essere `null`; `CreateUserValidator` riceve `IAuthMethods`; `Role.AssignPermissions` sul SuperAdmin lancia (per dargli permessi nuovi si usa `AddPermissions`); un test che costruisce a mano `PermissionResponse` riceve `SuperAdminOnly`. Un progetto che usa davvero `Microsoft.Identity.Web`, tolto dal template, lo rimette nel suo csproj |
| Tutti | I tipi del frontend cambiano: se `api.generated.ts` va in conflitto, si tiene una delle due versioni e si lancia `pnpm gen:api` |

Che cosa cambia, nel dettaglio: [Autenticazione](../autenticazione/autenticazione.md#come-si-passa-dall-una-all-altra)
per i metodi di accesso e il cambio della propria password,
[Chi può dare ruoli e permessi](../autenticazione/autenticazione.md#chi-puo-dare-ruoli-e-permessi)
per i ruoli di sistema e i permessi riservati, [Configurazione](configurazione.md#auth) per
`Auth:Password:Enabled`.

## Problemi tipici in locale

I problemi di autenticazione hanno la loro tabella in
[Autenticazione](../autenticazione/autenticazione.md#diagnostica); questi sono quelli della
macchina di sviluppo.

| Sintomo | Causa e rimedio |
|---|---|
| **Il backend non parte: indirizzo già in uso** | Un altro progetto (spesso app-demo) usa già la porta dell'API, `api_port` alla generazione (5080 di base). Si ferma l'altro, oppure si avvia questo su un'altra porta (`ASPNETCORE_URLS=http://localhost:5081`) e la si scrive in `VITE_API_BASE_URL` di `.env.local` |
| **Il frontend si apre su una porta diversa da quella attesa** | Vite, se `frontend_port` (5173 di base) è occupata, prende in silenzio la successiva libera. In Development il CORS accetta ogni porta di `localhost`, quindi funziona lo stesso; per fallire invece di cambiare porta, `npx vite --port <porta> --strictPort` |
| **Il container PostgreSQL non parte: porta 5432 già usata** | Sulla macchina c'è un PostgreSQL installato, che ascolta già sulla 5432. Nel `docker-compose.yml` si cambia la porta esterna (`"127.0.0.1:5433:5432"`) e si mette `Port=5433` nella connection string; oppure si usa il PostgreSQL installato e non il container |
| **L'API non parte o si ferma al primo accesso al database** | Docker Desktop è spento, o il container del database non è avviato: `docker compose up -d` dalla radice del progetto. Con SQL Server su LocalDB Docker non serve |
| **pnpm segnala errori strani su `node_modules` dopo un cambio di versione di pnpm** | La versione di pnpm è in `packageManager` del `package.json` e cambia con gli update del template. Si cancella `node_modules` (anche quello di `apps/frontend`) e si rilancia `pnpm install` |
| **Vitest o Vite non trovano pacchetti installati, in una cartella con un percorso lungo** | Su Windows i link dentro `node_modules/.pnpm` superano i 260 caratteri. Si genera il progetto in un percorso corto (`C:\repos\…`, `C:\tmp\…`), non sotto `AppData` |
| **`node` o `claude` lenti, o segnalati dall'antivirus** | L'antivirus analizza ogni file che pnpm, Vite, `dotnet` e Claude Code toccano. Si esclude la **cartella dei repository** (per esempio `C:\repos`), non gli eseguibili: escludere `node.exe` o `claude` toglierebbe la protezione a tutto ciò che lanciano |

## Da qui

- [Panoramica](panoramica.md) — che cosa contiene il progetto che hai appena generato
- [Configurazione](configurazione.md) — le chiavi da valorizzare in `appsettings.local.json` e `.env.local`
- [Le skill Claude](../claude/skill.md) — come aggiungere codice seguendo le convenzioni del template
- [Aggiungere una feature](../guide/nuova-feature.md) — la prima feature di dominio, end to end
