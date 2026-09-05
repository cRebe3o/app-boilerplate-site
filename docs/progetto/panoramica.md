# Panoramica del progetto

## Che cos'è

**app-boilerplate** è un template da cui si generano applicazioni gestionali. Non è un'applicazione
finita e non contiene un dominio: contiene l'**impianto** che ogni gestionale interno richiede
comunque, e che costa settimane rifare ogni volta.

Quello che un progetto generato ha già, il primo giorno:

| Area | Che cosa c'è |
|---|---|
| **Accesso** | Login con username e password, con account Microsoft (Azure AD) o con identità Windows integrata. JWT interno e refresh token con rotation |
| **Identità e autorizzazione** | Utenti, gruppi, ruoli, permessi granulari `risorsa.azione`, verificati dal backend e riflessi nel frontend |
| **Tracciamento** | Audit log di ogni scrittura con snapshot prima/dopo; log degli errori di backend e frontend |
| **Sistema** | Configurazione applicativa, retention dei log, monitoraggio delle dimensioni del database |
| **Frontend** | SPA Vue 3 + Vuetify con layout, navigazione filtrata per permessi, temi chiaro/scuro, italiano e inglese |
| **Impianto tecnico** | Pipeline MediatR con validazione e logging, gestione centralizzata degli errori, rate limiting, CORS, seed iniziale |

Due scelte caratterizzano il template, e sono il motivo per cui esiste buona parte di questa
documentazione.

| Scelta | In pratica |
|---|---|
| **Doppio provider di database** | La stessa applicazione gira su SQL Server o su PostgreSQL, via Entity Framework Core. Si sceglie da configurazione, senza toccare il codice. Vedi [Infrastruttura](../infrastructure/panoramica.md) |
| **Tripla strategia di autenticazione** | Username e password, account Microsoft o identità Windows. In tutti i casi il backend emette un JWT interno. Vedi [Autenticazione](../autenticazione/autenticazione.md) |

Il progetto nasce da `copier copy`, rispondendo a poche domande: nome, porte, provider del
database, modalità di accesso. Il percorso completo è in [Generare e aggiornare](generazione.md).

## Il monorepo

Un workspace **Nx** con **pnpm**, due applicazioni. `<Progetto>` sta per il nome tecnico scelto alla
generazione (la variabile `project_slug`):

```
<progetto>/
├── apps/
│   ├── backend/<Progetto>.Api/     # ASP.NET Core 10 — Minimal API, vertical slice
│   └── frontend/                   # Vue 3 + Vite + TypeScript + Vuetify
├── .claude/                        # skill e comandi per lo sviluppo assistito
├── docker-compose.yml              # opzionale: il database in locale
└── package.json                    # gli script di comodo del workspace
```

```bash
pnpm serve:backend      # API sulla porta scelta alla generazione
pnpm serve:frontend     # SPA sulla porta scelta alla generazione
pnpm build              # build di entrambe
pnpm test:frontend      # Vitest
pnpm test:backend       # dotnet test
```

Questa documentazione spiega *com'è fatto e perché*. Le convenzioni operative di scrittura del
codice — naming, struttura di una slice, regole del frontend — vivono **accanto al codice**, nei
file `CLAUDE.md` di `apps/backend/` e `apps/frontend/`.

## Backend — vertical slice

Il backend non è diviso per livelli tecnici (controller / service / repository), ma **per
funzionalità**: ogni operazione vive in una cartella che contiene tutto ciò che le serve.

```
Features/
├── Groups/                        # una feature
│   ├── CreateGroup/               # una slice: comando + handler + validator + response
│   │   ├── CreateGroupCommand.cs
│   │   ├── CreateGroupHandler.cs
│   │   ├── CreateGroupValidator.cs
│   │   └── CreateGroupResponse.cs
│   ├── GetGroups/  GetGroupById/  UpdateGroup/  DeleteGroup/
│   └── GroupEndpoints.cs          # solo routing, nessuna logica
└── _Shared/                       # ciò che è davvero comune a tutte le feature
    ├── Entities/                  # le POCO EF Core (int Id identity)
    ├── Persistence/               # AppDbContext + derivate per provider, migration
    ├── DatabaseStats/             # dimensioni DB e readiness, per provider
    ├── Seed/                      # DataSeeder (solo su DB vuoto)
    ├── Behaviors/                 # pipeline MediatR
    ├── Middleware/                # gestione errori
    ├── Helpers/                   # audit trail, normalizzazione dell'username
    └── Extensions/                # registrazione servizi ed endpoint
```

Le feature di dominio del progetto si aggiungono **allo stesso modo**, accanto a quelle già
presenti. Il percorso completo è in [Aggiungere una feature](../guide/nuova-feature.md).

Il percorso di una richiesta è sempre lo stesso:

```
HTTP  →  Endpoint (routing)  →  IMediator.Send(comando)
                                     │
                                     ├── LoggingBehavior      (durata, esito)
                                     ├── ValidationBehavior   (FluentValidation → 400)
                                     └── Handler              (la logica, qui e solo qui)
                                              │
                                              └── AppDbContext  →  SQL Server | PostgreSQL
```

Regole che tengono in piedi l'impianto:

- La logica sta **negli handler**. Gli endpoint instradano e basta; `Program.cs` non contiene logica.
- Gli handler dipendono **solo da `AppDbContext`**, che è astratto e provider-agnostico: è questo che
  rende possibile il doppio provider. Niente strato repository.
- Ogni scrittura (Create / Update / Delete) registra un **audit log** con attore, entità, azione, IP
  e — per modifiche e cancellazioni — gli snapshot JSON dell'entità.
- Le eccezioni non si gestiscono negli handler: `ExceptionHandlingMiddleware` le traduce in
  risposte **ProblemDetails** (RFC 7807).

| Eccezione | HTTP |
|---|---|
| `ValidationException` (FluentValidation) | 400 |
| `UnauthorizedException` | 401 |
| `ForbiddenException` | 403 |
| `NotFoundException` | 404 |
| `ConflictException` | 409 |
| qualsiasi altra | 500 |

### Le API incluse

Dieci gruppi di endpoint, tutti sotto `/api`:

| Area | Rotte |
|---|---|
| Accesso | `/api/auth` |
| Identità | `/api/users` · `/api/groups` · `/api/roles` · `/api/permissions` |
| Trasversali | `/api/public` |
| Sistema | `/api/audit-logs` · `/api/error-logs` · `/api/system-config` · `/api/monitoring` |

Sono le rotte dell'impianto: quelle del dominio si aggiungono accanto, registrandole in
`_Shared/Extensions/EndpointExtensions.cs`.

In esecuzione l'API espone la propria specifica OpenAPI, navigabile con Scalar (`/scalar`) o con
Swagger UI (`/swagger`).

### Cosa c'è in `Program.cs`

Oltre alla registrazione dei servizi, alcune scelte che vale la pena conoscere perché si notano
solo quando mancano:

- **`UseForwardedHeaders` come primissimo middleware.** Dietro un reverse proxy l'IP del client
  arriva in `X-Forwarded-For`: senza questo, ogni richiesta sembrerebbe provenire dal load balancer
  e il rate limiting per IP diventerebbe di fatto globale.
- **Rate limiting partizionato per IP**, non globale: 10 richieste ogni 15 minuti sugli endpoint di
  autenticazione (anti brute-force), 20 al minuto sull'endpoint pubblico di raccolta errori.
- **Localizzazione della richiesta** in base ad `Accept-Language` (`it` predefinito, `en` supportato):
  i messaggi di errore dell'API seguono la lingua dell'utente.
- **Inizializzazione del database all'avvio**: `MigrateAsync()` applica le migration mancanti del
  provider attivo (e crea il database se non esiste); poi il seed, identico per i due provider, che
  popola **solo uno store vuoto** — mai un wipe, mai un reseed.

## Frontend — Vue 3

```
src/
├── pages/          # una pagina per rotta (home/, auth/, users/, groups/, roles/, system/…)
├── components/     # layout (AppShell, AppNav, AppTopBar), users/, shared/
├── stores/         # Pinia, uno per dominio (composition API)
├── services/       # le chiamate HTTP: solo qui si usa axios
├── composables/    # usePermission, useApiErrors, useTheme, useBreadcrumb…
├── config/         # app.config.ts (modalità di accesso), sections.config.ts
├── plugins/        # vuetify, axios (interceptor), i18n, msal
├── locales/        # it.ts (predefinito) ed en.ts
└── router/         # rotte con meta.permission
```

La catena è sempre **service → store → pagina**: i componenti non chiamano mai `axios`
direttamente e non contengono logica di business; i testi passano tutti da `t('chiave')`.

L'istanza axios in `plugins/axios.ts` aggiunge il Bearer token a ogni richiesta, propaga la lingua
in `Accept-Language` e su `401` esegue il logout.

### Modalità di accesso: pubblica o privata

Una scelta fatta alla generazione (`access_mode`), leggibile a runtime in `VITE_APP_ACCESS_MODE` e
centralizzata in `config/app.config.ts`:

| Modalità | Comportamento |
|---|---|
| `public` | L'utente anonimo atterra sulla home pubblica e da lì può accedere. Le rotte con `meta.requiresAuth` restano comunque protette |
| `private` | Nessuna pagina è visibile agli anonimi: qualsiasi rotta diversa da `/login` redirige al login finché l'utente non è autenticato |

## Permessi

Il modello di autorizzazione è lo stesso da un capo all'altro dello stack.

Un permesso è una stringa `risorsa.azione` — `users.read`, `groups.write`, `roles.delete`.
I permessi sono raccolti in **ruoli**; i ruoli si assegnano a un utente **direttamente** o
**tramite i gruppi** a cui appartiene. Al login il backend risolve la lista completa (ruoli diretti
+ ruoli ereditati dai gruppi → permessi, deduplicati) e la scrive nel JWT come claim ripetuti.

Il seed iniziale crea **18 permessi**, tutti sull'area di sistema e identità: `read` / `write` /
`delete` su utenti, gruppi e ruoli, più `permissions.read` e `permissions.manage`, `audit.*`,
`errors.*`, `config.*` e `monitoring.read`. I permessi del dominio si aggiungono man mano che si
aggiungono le feature.

Insieme ai permessi il seed crea quattro ruoli — `SuperAdmin`, `Admin`, `Viewer` e un `Custom`
vuoto da personalizzare — e i gruppi `Administrators` e `Viewers`.

Lo stesso permesso viene verificato in tre punti:

```csharp
// Backend — l'endpoint richiede il claim
group.MapDelete("/{id:int}", …)
    .RequireAuthorization(p => p.RequireClaim("permissions", "groups.delete"));
```

```typescript
// Frontend — la rotta non è raggiungibile senza il permesso
meta: { requiresAuth: true, permission: 'groups.read' }
```

```vue
<!-- Frontend — il pulsante non viene nemmeno mostrato -->
<v-btn v-if="can('groups.delete')" color="error" @click="remove" />
```

Nascondere il pulsante è cortesia verso l'utente; a **negare** l'operazione è sempre e solo il backend.

## Da qui

- [Generare e aggiornare](generazione.md) — le variabili del template, `copier copy` e `copier update`
- [Le skill Claude](skill.md) — gli scaffolding inclusi per aggiungere codice nel modo previsto
- [Infrastruttura](../infrastructure/panoramica.md) — perché due provider SQL e come sono tenuti insieme
- [Autenticazione](../autenticazione/autenticazione.md) — JWT, Azure AD, Windows, permessi
- [Aggiungere una feature](../guide/nuova-feature.md) — il percorso completo, end to end
- [Deploy su Render](../deploy/render.md) — come va in produzione
