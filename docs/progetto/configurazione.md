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
| 2 | `appsettings.{Environment}.json` | sì | Le differenze per ambiente. `Development`: livelli di log, login Windows acceso, telemetria verso il collector locale (Aspire Dashboard, o Grafana con `include_grafana`); `Production`: livelli di log, origin CORS |
| 3 | `appsettings.local.json` | **no** (gitignored) | I segreti e i valori della tua macchina: connection string, secret JWT, admin del seed |
| 4 | Variabili d'ambiente | — | Il deploy. Vincono sui file |
| 5 | Argomenti della riga di comando | — | Vincono su tutto. Fra questi arrivano anche le impostazioni dei test (`UseSetting` di `WebApplicationFactory`), che così non vengono coperte dall'`appsettings.local.json` di chi lancia i test |

Le variabili d'ambiente usano il **doppio underscore** al posto dei due punti:
`Auth__Jwt__Secret` è `Auth:Jwt:Secret`. Un elemento di array si indicizza: `Cors__AllowedOrigins__0`.

> `appsettings.local.json` **non esiste** in un progetto appena generato: si crea copiando
> `appsettings.local.json.example`, che è committato e commentato riga per riga. È il primo passo
> dopo la generazione, e senza di esso l'applicazione non parte (manca il secret JWT).

`ASPNETCORE_ENVIRONMENT` decide quale file `{Environment}` viene letto e cambia alcuni
comportamenti: in `Development` il CORS accetta qualsiasi porta su `localhost`, il rate limiting
del login è più permissivo, i dettagli delle eccezioni arrivano al client, il login Windows è
acceso e, da questo computer, accetta l'header `X-Dev-Windows-User`, Swagger UI e lo schema OpenAPI
sono pubblicati, il segreto JWT di esempio è accettato, e il login mostra le credenziali dell'admin,
che il seed tiene allineate alla configurazione (vedi [sotto](#credenziali-di-sviluppo-nel-login)).
`launchSettings.json` lo imposta a `Development` per `dotnet run`; in produzione va impostato
esplicitamente a `Production`.

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
| `Auth:Jwt:Secret` | **sì, sempre** | Firma i JWT interni; senza, l'app lancia `InvalidOperationException` all'avvio. Fuori da `Development` deve essere casuale, di almeno 32 caratteri e diverso da quello di esempio, altrimenti l'API non parte |
| `Auth:Jwt:ExpiresInMinutes` | no (60) | Durata dell'access token |
| `Auth:Jwt:RefreshExpiresInDays` | no (7) | Durata del refresh token (cookie HttpOnly) |
| `Auth:Jwt:Issuer` · `Audience` | no (`<Progetto>` / `<Progetto>Clients`) | Claim di validazione del token |
| `Auth:Msal:TenantId` · `ClientId` | solo con login Microsoft | Tenant Entra ID e client id dell'**app API**, contro cui viene validato il token Azure — vedi [App registration Azure](../autenticazione/azure-app-registration.md). Vuoti, `/api/auth/msal-login` risponde 404 |
| `Auth:Msal:Instance` | no | `https://login.microsoftonline.com/` |
| `Auth:Windows:Enabled` | solo con login Windows (`false`) | Accende `/api/auth/windows-login`, che altrimenti risponde 404. È `true` in `appsettings.Development.json`; fuori da `Development` si imposta `Auth__Windows__Enabled=true`. Usa Negotiate, e su Windows funziona anche fuori dominio |
| `Auth:Password:Enabled` | no (`true`) | Login con username e password. Spento: `/api/auth/login` e i cambi password rispondono 404, gli utenti nascono senza password, il frontend toglie form, campo password e pulsanti di cambio; si entra con Microsoft o Windows. Con `access_mode` `private` è `false` in `appsettings.Production.json`: si riaccende con `Auth__Password__Enabled=true`. Vedi [Autenticazione](../autenticazione/autenticazione.md#come-si-passa-dall-una-all-altra) |

Quali metodi sono attivi lo dice `GET /api/auth/methods`, da cui il frontend li legge; la schermata
fra quelli attivi la sceglie `VITE_AUTH_STRATEGY`. Fino alla 7.x `appsettings.local.json.example`
aveva una chiave `Auth:Strategy` che il codice non leggeva: dalla 8.0.0 non c'è più.

### `Seed`

Letti **al primo avvio su un database vuoto**, per creare gli utenti: se esiste già anche un solo
ruolo il seed aggiunge soltanto i permessi nuovi del catalogo, e cambiare queste chiavi non ha
effetto. L'eccezione è `Development`: lì username e password dell'admin valgono a ogni avvio (vedi
[sotto](#credenziali-di-sviluppo-nel-login)).

| Chiave | Default | Valore |
|---|---|---|
| `Seed:AdminUsername` | `admin` | Username dell'amministratore iniziale. Con il login Microsoft dev'essere l'email aziendale con cui si entra (`preferred_username` del token) |
| `Seed:AdminEmail` | vuoto | Email dell'admin. Vuoto = si riusa lo username, se ha la forma di un'email |
| `Seed:AdminDisplayName` | `Administrator` | Nome visualizzato |
| `Seed:AdminPassword` | vuoto | Password dell'admin. Vuota in `Development` = `Admin@1234`; vuota fuori da `Development` = ne viene generata una casuale, **non stampata**: in produzione, con il login con password, di fatto va impostata. Con `Auth:Password:Enabled` spento non è letta: l'admin nasce senza password ed entra con Microsoft (`Seed:AdminUsername` è allora l'email aziendale) o con l'utente Windows, e il seed lo scrive nel log |
| `Seed:WindowsUsername` | vuoto | Account per il login Windows, nella forma `DOMINIO\utente`, letto solo con `Auth:Windows:Enabled`. Vuoto = in `Development` l'account del processo corrente, che lì è quasi sempre quello giusto; fuori da `Development` nessun utente Windows |

Il seed crea anche permessi, ruoli (`SuperAdmin`, `Admin`, `Viewer`, `Custom`) e gruppi
(`Administrators`, `Viewers`): l'elenco è in `DataSeeder.cs`. I permessi di una feature nuova si
aggiungono lì: su un database già avviato il seed li crea all'avvio successivo, li dà solo al
SuperAdmin e lo scrive nel log ("Seed: aggiunti i permessi …").

`Viewer` legge tutto ciò che legge `Admin`, e niente di più. I permessi riservati al SuperAdmin
(`permissions.*` e, con i lavori programmati e Grafana, `jobs.dashboard` e `telemetry.dashboard`)
non vanno a **nessun altro ruolo**, nemmeno personalizzato: darli risponde 403
`SuperAdminOnlyPermission`, e a ogni avvio il seed li toglie ai ruoli che li hanno e lo scrive nel
log ("Seed: tolti ai ruoli i permessi riservati al SuperAdmin"). Vedi
[Chi può dare ruoli e permessi](../autenticazione/autenticazione.md#chi-puo-dare-ruoli-e-permessi).

Dei ruoli di sistema si cambiano i **permessi** dalla pagina Ruoli, non nome e descrizione; il
SuperAdmin non si modifica. Su un database già avviato il seed dà i permessi nuovi del catalogo solo
al SuperAdmin: ad Admin e Viewer si assegnano da lì.

#### Credenziali di sviluppo nel login

In `Development`, con il login username e password (`VITE_AUTH_STRATEGY=jwt` e
`Auth:Password:Enabled` acceso), la pagina di login mostra username e password dell'admin. Non sono scritte nel frontend: le chiede al backend,
`GET /api/auth/dev-credentials`, che restituisce `Seed:AdminUsername` e `Seed:AdminPassword` (con i
default della tabella sopra).

L'endpoint risponde solo se l'ambiente è `Development` **e** la richiesta arriva da questo computer
(loopback). Un `X-Forwarded-For: 127.0.0.1` scritto a mano non basta: conta anche l'indirizzo della
connessione vera. In tutti gli altri casi risponde 404 e il riquadro non compare.

Perché le credenziali mostrate funzionino sempre, in `Development` il seed a ogni avvio riporta
l'admin già esistente alla configurazione:

- **password e attivazione** sì: se una prova le ha cambiate, al riavvio tornano quelle di
  `appsettings.local.json`;
- **i ruoli** no: una prova sui permessi resta com'è.

Quindi in sviluppo la password dell'admin si cambia in `Seed:AdminPassword`, non dall'app: dall'app
dura fino al riavvio. Se `Seed:AdminUsername` non corrisponde a nessun utente (cambiato dopo il
primo avvio), o se l'admin entra con un identity provider e non ha una password locale, il seed lo
scrive nel log e non tocca niente. Anche l'endpoint se ne accorge: risponde `userExists: false`
oppure `hasLocalPassword: false`, senza la password, e il login mostra al posto delle credenziali un
avviso, in italiano e in inglese, con che cosa fare (correggere `Seed:AdminUsername` e riavviare il
backend, svuotare il database, oppure entrare con l'identity provider impostando
`VITE_AUTH_STRATEGY`). Fuori da `Development` non c'è né il riquadro né il riallineamento.

### `Cors` e `Logging`

| Chiave | Valore |
|---|---|
| `Cors:AllowedOrigins` | Array degli origin del frontend, esatti (`https://app.example.com`). In `Development` è ignorato: qualsiasi porta su `localhost` è ammessa |
| `Logging:LogLevel:*` | Standard .NET. Per vedere le query EF: `Microsoft.EntityFrameworkCore.Database.Command` a `Information` |

### `ForwardedHeaders`

I limiti di frequenza (il login con password, gli errori del frontend) contano per indirizzo del
client, e anche il registro di audit lo scrive. Dietro un proxy (Render, IIS, nginx) l'indirizzo
della connessione è quello del proxy, e quello vero arriva in un'intestazione. L'API la accetta
**solo dai proxy configurati qui**: da un client qualsiasi sarebbe inventata, e cambiandola a ogni
tentativo si aggirerebbe il limite del login.

| Chiave | Default | Valore |
|---|---|---|
| `ForwardedHeaders:Enabled` | `false` | Accende la lettura dell'intestazione. Spento, l'indirizzo è quello della connessione |
| `ForwardedHeaders:KnownProxies` | vuoto | Indirizzi dei proxy da cui accettarla, es. `ForwardedHeaders__KnownProxies__0=10.0.0.5` |
| `ForwardedHeaders:KnownNetworks` | vuoto | Reti dei proxy, es. `ForwardedHeaders__KnownNetworks__0=10.0.0.0/8` |
| `ForwardedHeaders:TrustAllProxies` | `false` | Accetta l'intestazione da qualunque connessione. Solo con un'intestazione che il proxy **riscrive sempre**, mai con `X-Forwarded-For` |
| `ForwardedHeaders:ForwardedForHeader` | `X-Forwarded-For` | Il nome dell'intestazione con l'indirizzo del client |

> **Con un proxy davanti va configurata, altrimenti il login con password si blocca per tutti.**
> Senza, ogni richiesta ha l'indirizzo del proxy, e i limiti diventano uno solo per tutti gli
> utenti: dieci password sbagliate in 15 minuti, di chiunque, bloccano il login con password di
> tutti per il resto dei 15 minuti; anche gli errori del frontend si fermano a 5 al minuto per
> tutta l'app, e l'audit scrive per tutti l'indirizzo del proxy.

Due configurazioni tipiche:

- **IIS, nginx, un proxy con indirizzo noto**: `ForwardedHeaders__Enabled=true` e
  `ForwardedHeaders__KnownProxies__0=<indirizzo del proxy>` (o `KnownNetworks__0`).
- **Render**: gli indirizzi dei suoi proxy non sono pubblicati. Vedi
  [Deploy su Render](../deploy/render.md#indirizzo-del-client-e-limite-dei-login).

### `OpenApi`

| Chiave | Default | Valore |
|---|---|---|
| `OpenApi:Enabled` | `false` | Pubblica Swagger UI (`/swagger`) e lo schema (`/openapi/v1.json`) anche fuori da `Development`, dove altrimenti non ci sono. In `Development` ci sono sempre |

### `Telemetry`

| Chiave | Valore |
|---|---|
| `Telemetry:Endpoint` | Collector OTLP/gRPC verso cui esportare tracce, metriche e log. **Vuoto = telemetria spenta**, ed è il default |
| `Telemetry:ServiceName` | Nome con cui l'applicazione appare nel backend di observability |
| `Telemetry:SampleRatio` | Frazione di tracce da campionare, fra 0 e 1. `null` = tutte |

In sviluppo, con `include_docker`, l'endpoint punta già al container avviato da `docker compose`:
l'Aspire Dashboard, o con `include_grafana` il container `lgtm` di Grafana, sulla stessa porta 4317.
In produzione va impostato solo dopo aver scelto una destinazione. Se il valore non è un URI
assoluto valido l'applicazione non parte, invece di disattivare la telemetria in silenzio. Vedi
[Observability](../deploy/observability.md).

### `Grafana` (solo con `include_grafana`)

| Chiave | Valore |
|---|---|
| `Grafana:Url` | Dove il backend raggiunge Grafana, per inoltrare `/grafana`. In sviluppo `http://localhost:3000`. **Vuoto = niente `/grafana`** |
| `Grafana:Jwt:PrivateKeyFile` | La chiave privata (PEM) con cui il backend firma i token per Grafana, relativa alla cartella del progetto Api o assoluta. In deploy un *Secret File*: chi ha la chiave entra in Grafana |

La coppia di sviluppo la crea `node scripts/grafana-keys.mjs`; quella di produzione, diversa, con
`--out <cartella>`. Vedi [Observability](../deploy/observability.md#come-si-entra).

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
| `VITE_APP_ACCESS_MODE` | `public` · `private` | Impostata dalla variabile Copier `access_mode`. `private` manda al login qualsiasi anonimo; con `msal` il login va direttamente a Microsoft (non dopo "Esci", non di ritorno da Microsoft con un errore, non dopo una sessione scaduta) |
| `VITE_MSAL_CLIENT_ID` · `VITE_MSAL_TENANT_ID` | dal portale Azure | Solo con `msal`: l'app registration della **SPA** |
| `VITE_MSAL_API_CLIENT_ID` | dal portale Azure | Solo con `msal` e due app registration distinte: l'app dell'**API**, per lo scope del token. Vuota = SPA e API condividono la stessa app |
| `VITE_APP_VERSION` | per esempio `v1.0.0` | Facoltativa, commentata in `.env.production`. La versione nel piè di pagina viene da `git describe --tags` quando Vite parte; questa serve solo se la build non vede la cartella `.git`, per esempio in un'immagine Docker. Senza nessuna delle due, "sviluppo" |

Nel codice nessun file legge `import.meta.env` direttamente: lo fa solo `config/app.config.ts`,
che espone valori già normalizzati. Una variabile nuova si aggiunge in tre posti: `.env`,
`vite-env.d.ts` (il tipo) e `app.config.ts`.

## Le variabili Copier

Alcune chiavi nascono già valorizzate alla generazione, dalle risposte a Copier. Non sono
configurazione a runtime: sono il punto di partenza.

| Variabile Copier | Dove finisce |
|---|---|
| `project_slug` | Namespace, `.sln`, `Issuer`/`Audience` del JWT, nome del database nelle connection string d'esempio |
| `api_port` | `launchSettings.json`, `VITE_API_BASE_URL` |
| `frontend_port` | `vite.config.ts`, `Cors:AllowedOrigins` |
| `db_provider` | `Database:Provider`, immagine del `docker-compose.yml` |
| `access_mode` | `VITE_APP_ACCESS_MODE` |

Vedi [Generare e aggiornare](generazione.md) per il resto.

## I tre ambienti, in pratica

| | Sviluppo locale | Docker (solo il DB) | Produzione |
|---|---|---|---|
| Backend | `appsettings.local.json` | idem, con la connection string del container | Variabili d'ambiente (`Auth__Jwt__Secret`, `ConnectionStrings__*`, `Cors__AllowedOrigins__0`, `Seed__*`, `ForwardedHeaders__*` dietro un proxy) |
| Frontend | `.env.local` | idem | Variabili dell'hosting o `.env.production` al build |
| `ASPNETCORE_ENVIRONMENT` | `Development` (da `launchSettings.json`) | `Development` | `Production` |

La tabella completa per il deploy, con i valori, è in [Deploy su Render](../deploy/render.md).

## Checklist "non parte"

- **`JWT Secret is missing`** → manca `Auth:Jwt:Secret`: `appsettings.local.json` non esiste o non è
  nella cartella del progetto Api.
- **`Auth:Jwt:Secret non valido fuori da Development`** → in produzione il segreto è quello di
  esempio o è più corto di 32 caratteri: ne serve uno casuale.
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
