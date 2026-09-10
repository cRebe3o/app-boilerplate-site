# Configurazione

Tutto ciò che un progetto generato legge da fuori: le chiavi del backend, le variabili del
frontend, dove si mettono in sviluppo e in produzione, e quali sono obbligatorie. È la pagina da
aprire quando l'applicazione non parte o parte con il database sbagliato.

## Backend: la gerarchia

ASP.NET compone la configurazione da più sorgenti, e **l'ultima vince**. `Program.cs` le registra
in quest'ordine:

| # | Sorgente | Committata? | A che cosa serve |
|---|---|---|---|
| 1 | `appsettings.json` | sì | I default e la **forma** della configurazione: ogni chiave esiste qui, anche vuota |
| 2 | `appsettings.{Environment}.json` | sì | Le differenze per ambiente. Nel template solo `Development` (livelli di log) |
| 3 | `appsettings.local.json` | **no** (gitignored) | I segreti e i valori della tua macchina: connection string, secret JWT, admin del seed |
| 4 | Variabili d'ambiente | — | Il deploy. Vincono su tutto |

Le variabili d'ambiente usano il **doppio underscore** al posto dei due punti:
`Auth__Jwt__Secret` è `Auth:Jwt:Secret`. Un elemento di array si indicizza: `Cors__AllowedOrigins__0`.

> `appsettings.local.json` **non esiste** in un progetto appena generato: si crea copiando
> `appsettings.local.json.example`, che è committato e commentato riga per riga. È il primo passo
> dopo la generazione, e senza di esso l'applicazione non parte (manca il secret JWT).

`ASPNETCORE_ENVIRONMENT` decide quale file `{Environment}` viene letto e cambia alcuni
comportamenti: in `Development` il CORS accetta qualsiasi porta su `localhost`, il rate limiting
del login è più permissivo, i dettagli delle eccezioni arrivano al client, e l'endpoint di login
Windows accetta l'header `X-Dev-Windows-User`. `launchSettings.json` lo imposta a `Development` per
`dotnet run`; in produzione va impostato esplicitamente a `Production`.

## Backend: le chiavi

### `Database` e `ConnectionStrings`

| Chiave | Obbligatoria | Valore |
|---|---|---|
| `Database:Provider` | sì | `SqlServer` o `PostgreSQL`. Decide quale `DbContext`, quale set di migration e quale connection string |
| `ConnectionStrings:SqlServer` | se il provider è SqlServer | es. `Server=(localdb)\MSSQLLocalDB;Database=<Progetto>;Trusted_Connection=True;TrustServerCertificate=True` |
| `ConnectionStrings:PostgreSQL` | se il provider è PostgreSQL | es. `Host=localhost;Database=<progetto>;Username=postgres;Password=…` |
| `Database:SizeLimitMb` | no | Tetto di spazio del piano di hosting, per la pagina Monitoraggio. Il motore non lo conosce; senza, la pagina usa un riferimento indicativo e lo segnala |

Le due connection string possono restare entrambe valorizzate: viene letta solo quella del
provider attivo. Cambiare database è cambiare `Database:Provider`, niente altro.

### `Auth`

| Chiave | Obbligatoria | Valore |
|---|---|---|
| `Auth:Jwt:Secret` | **sì, sempre** | Almeno 32 caratteri. Firma i JWT interni; senza, l'app lancia `InvalidOperationException` all'avvio |
| `Auth:Jwt:ExpiresInMinutes` | no (60) | Durata dell'access token |
| `Auth:Jwt:RefreshExpiresInDays` | no (7) | Durata del refresh token (cookie HttpOnly) |
| `Auth:Jwt:Issuer` · `Audience` | no (`<Progetto>` / `<Progetto>Clients`) | Claim di validazione del token |
| `Auth:Msal:TenantId` · `ClientId` | solo con login Microsoft | Tenant Entra ID e client id dell'**app API**, contro cui viene validato il token Azure — vedi [App registration Azure](../autenticazione/azure-app-registration.md) |
| `Auth:Msal:Instance` | no | `https://login.microsoftonline.com/` |
| `Auth:Strategy` | no | **Solo documentazione**: il backend accetta sempre tutti e tre i login. La schermata la sceglie il frontend con `VITE_AUTH_STRATEGY` |

Il login Windows integrato non ha chiavi: usa Negotiate, e su Windows funziona anche fuori
dominio.

### `Seed`

Letti **solo al primo avvio su un database vuoto**: se esiste già anche un solo ruolo, il seed
esce senza fare nulla. Cambiarli dopo non ha effetto.

| Chiave | Default | Valore |
|---|---|---|
| `Seed:AdminUsername` | `admin` | Username dell'amministratore iniziale. Con il login Microsoft dev'essere l'email aziendale con cui si entra (`preferred_username` del token) |
| `Seed:AdminEmail` | vuoto | Email dell'admin. Vuoto = si riusa lo username, se ha la forma di un'email |
| `Seed:AdminDisplayName` | `Administrator` | Nome visualizzato |
| `Seed:AdminPassword` | vuoto | Password dell'admin. Vuota = ne viene generata una casuale, **non stampata**: di fatto va impostata |
| `Seed:WindowsUsername` | vuoto | Account per il login Windows, nella forma `DOMINIO\utente`. Vuoto = l'account del processo corrente, che in sviluppo è quasi sempre quello giusto |

Il seed crea anche permessi, ruoli (`SuperAdmin`, `Admin`, `Viewer`, `Custom`) e gruppi
(`Administrators`, `Viewers`): l'elenco è in `DataSeeder.cs`. I permessi di una feature nuova si
aggiungono lì, ma su un database già avviato vanno creati dal pannello Permessi.

### `Cors` e `Logging`

| Chiave | Valore |
|---|---|
| `Cors:AllowedOrigins` | Array degli origin del frontend, esatti (`https://app.example.com`). In `Development` è ignorato: qualsiasi porta su `localhost` è ammessa |
| `Logging:LogLevel:*` | Standard .NET. Per vedere le query EF: `Microsoft.EntityFrameworkCore.Database.Command` a `Information` |

### `Telemetry`

| Chiave | Valore |
|---|---|
| `Telemetry:Endpoint` | Collector OTLP/gRPC verso cui esportare tracce, metriche e log. **Vuoto = telemetria spenta**, ed è il default |
| `Telemetry:ServiceName` | Nome con cui l'applicazione appare nel backend di observability |
| `Telemetry:SampleRatio` | Frazione di tracce da campionare, fra 0 e 1. `null` = tutte |

In sviluppo, con `include_docker`, l'endpoint punta già all'Aspire Dashboard avviato da
`docker compose`. In produzione va impostato solo dopo aver scelto una destinazione. Se il valore
non è un URI assoluto valido l'applicazione non parte, invece di disattivare la telemetria in
silenzio. Vedi [Observability](../deploy/observability.md).

### Come arrivano agli handler

Gli handler **non leggono `IConfiguration`**: i test di architettura vietano ASP.NET in
`Application`, e una chiave letta a mano in un handler è una dipendenza nascosta. Le impostazioni
che servono alla logica applicativa passano da `IAppSettings`, tipizzata e dichiarata in
`Application/Abstractions`, implementata in `Infrastructure/Services/AppSettings.cs`. Oggi espone
`DatabaseSizeLimitMb`; una chiave nuova che serve a un handler si aggiunge lì.

Tutto il resto (`Auth`, `Cors`, `Seed`) lo legge il composition root — `Program.cs`,
`AuthExtensions`, `DataSeeder` — che è l'unico posto in cui la configurazione è un dettaglio
legittimo.

## Frontend: le variabili `VITE_*`

Vite legge i file `.env` in ordine, e anche qui l'ultimo vince:

| File | Committato? | Quando viene letto |
|---|---|---|
| `.env` | sì | Sempre: i default di sviluppo |
| `.env.production` | sì | Con `vite build`: i segnaposto per il deploy, da sovrascrivere nell'hosting |
| `.env.local` | **no** (gitignored) | Sempre, sopra `.env`: i valori della tua macchina. Si crea da `.env.local.example` |

Le variabili sono **incorporate nel bundle al build**: cambiarle in produzione significa
ricostruire, oppure impostarle nell'hosting prima della build (su Render, la dashboard vince sul
file).

| Variabile | Valore | Note |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:<api_port>` in sviluppo, l'URL pubblico del **backend** in produzione | Senza slash finale |
| `VITE_AUTH_STRATEGY` | `jwt` · `msal` · `windows` | Quale schermata di login mostrare. Il backend accetta sempre tutte e tre |
| `VITE_APP_ACCESS_MODE` | `public` · `private` | Impostata dalla variabile Copier `access_mode`. `private` manda al login qualsiasi anonimo |
| `VITE_MSAL_CLIENT_ID` · `VITE_MSAL_TENANT_ID` | dal portale Azure | Solo con `msal`: l'app registration della **SPA** |
| `VITE_MSAL_API_CLIENT_ID` | dal portale Azure | Solo con `msal` e due app registration distinte: l'app dell'**API**, per lo scope del token. Vuota = SPA e API condividono la stessa app |

Nel codice nessun file legge `import.meta.env` direttamente: lo fa solo `config/app.config.ts`,
che espone valori già normalizzati. Una variabile nuova si aggiunge in tre posti: `.env`,
`vite-env.d.ts` (il tipo) e `app.config.ts`.

## Le variabili Copier

Alcune chiavi nascono già valorizzate alla generazione, dalle risposte a Copier. Non sono
configurazione a runtime: sono il punto di partenza.

| Variabile Copier | Dove finisce |
|---|---|
| `project_slug` | Namespace, `.sln`, `Issuer`/`Audience` del JWT, nome del database nelle connection string d'esempio |
| `api_port` | `launchSettings.json`, `VITE_API_BASE_URL`, `scripts/generate-api-types.mjs` |
| `frontend_port` | `vite.config.ts`, `Cors:AllowedOrigins` |
| `db_provider` | `Database:Provider`, immagine del `docker-compose.yml` |
| `access_mode` | `VITE_APP_ACCESS_MODE` |

Vedi [Generare e aggiornare](generazione.md) per il resto.

## I tre ambienti, in pratica

| | Sviluppo locale | Docker (solo il DB) | Produzione |
|---|---|---|---|
| Backend | `appsettings.local.json` | idem, con la connection string del container | Variabili d'ambiente (`Auth__Jwt__Secret`, `ConnectionStrings__*`, `Cors__AllowedOrigins__0`, `Seed__*`) |
| Frontend | `.env.local` | idem | Variabili dell'hosting o `.env.production` al build |
| `ASPNETCORE_ENVIRONMENT` | `Development` (da `launchSettings.json`) | `Development` | `Production` |

La tabella completa per il deploy, con i valori, è in [Deploy su Render](../deploy/render.md).

## Checklist "non parte"

- **`JWT Secret is missing`** → manca `Auth:Jwt:Secret`: `appsettings.local.json` non esiste o non è
  nella cartella del progetto Api.
- **Provider sbagliato** → `Database:Provider` in `appsettings.local.json` o in una variabile
  d'ambiente `Database__Provider` che vince sul file.
- **`database does not exist` su Postgres** → `MigrateAsync` non ha il permesso di creare il
  database (tipico dietro un connection pooler): va creato a monte.
- **CORS in produzione** → `Cors:AllowedOrigins` deve contenere l'origin esatto del frontend,
  schema compreso.
- **Login MSAL "utente non trovato"** → `Seed:AdminUsername` non coincide con l'email dell'account
  Entra ID, oppure il seed è già stato fatto con un altro username.
- **Il frontend chiama `localhost` in produzione** → `VITE_API_BASE_URL` non è stata impostata
  prima della build.

## Da qui

- [Generare e aggiornare](generazione.md) — le variabili Copier e i primi passi
- [JWT, MSAL e Windows](../autenticazione/autenticazione.md) — le chiavi `Auth` nel dettaglio
- [Deploy su Render](../deploy/render.md) — le variabili d'ambiente di produzione
