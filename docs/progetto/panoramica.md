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
│   ├── backend/                    # .NET 10 — quattro progetti, Clean Architecture
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
pnpm lint:frontend      # ESLint
pnpm typecheck:frontend # vue-tsc
```

Questa documentazione spiega *com'è fatto e perché*. Le convenzioni operative di scrittura del
codice — naming, struttura di una slice, regole del frontend — vivono **accanto al codice**, nei
file `CLAUDE.md` di `apps/backend/` e `apps/frontend/`.

## Backend — Clean Architecture

Il backend è diviso in **quattro progetti**, uno per layer, con le dipendenze che puntano tutte
verso l'interno:

```
apps/backend/
├── <Progetto>.Domain/          # entità, aggregati, value object, domain service, eventi
├── <Progetto>.Application/     # casi d'uso: command/query + handler + validator + response
├── <Progetto>.Infrastructure/  # EF Core, repository, JWT, interceptor, servizi esterni
├── <Progetto>.Api/             # Minimal API: routing, permessi, OpenAPI. Composition root
└── tests/
    ├── <Progetto>.Domain.Tests/         # il dominio, senza database né mock
    ├── <Progetto>.Application.Tests/    # gli handler, con fake delle astrazioni
    └── <Progetto>.Architecture.Tests/   # le regole dei layer, verificate dalla build
```

```
Api  →  Infrastructure  →  Application  →  Domain
```

Il dominio non ha **nessuna** dipendenza esterna: non conosce EF Core, ASP.NET né MediatR.
L'Application layer dichiara le astrazioni di cui ha bisogno (`IRentalContractRepository`,
`ICurrentUser`, `IDateTimeProvider`) e Infrastructure le implementa — mai il contrario.

Dentro `Application`, i casi d'uso restano organizzati **per funzionalità**: ogni operazione ha la
sua cartella con tutto ciò che le serve.

```
<Progetto>.Application/
├── Abstractions/            # le interfacce che Infrastructure implementa
│   ├── Persistence/         # I*Repository, IReadDbContext, IUnitOfWork, IQueryExecutor
│   ├── Identity/            # ICurrentUser, ITokenService, IPasswordHasher…
│   └── Services/            # IDateTimeProvider, IDomainEventDispatcher…
├── Groups/                  # una feature
│   ├── CreateGroup/         # una slice: comando + handler + validator + response
│   │   ├── CreateGroupCommand.cs
│   │   ├── CreateGroupHandler.cs
│   │   ├── CreateGroupValidator.cs
│   │   └── CreateGroupResponse.cs
│   ├── GetGroups/  GetGroupById/  UpdateGroup/  DeleteGroup/
│   └── Common/              # response e proiezioni condivise fra slice
├── Behaviors/               # pipeline MediatR (logging, validazione)
└── Common/                  # paginazione, messaggi
```

Gli endpoint vivono in `<Progetto>.Api/Endpoints/` e contengono **solo routing**.

Il percorso di una richiesta:

```
HTTP  →  Endpoint (routing)  →  IMediator.Send(comando)
                                     │
                                     ├── LoggingBehavior      (durata, esito)
                                     ├── ValidationBehavior   (FluentValidation → 400)
                                     └── Handler              (orchestrazione)
                                              │
                                              ├── repository / IReadDbContext  (astrazioni)
                                              ├── aggregato di dominio         (la decisione)
                                              └── IUnitOfWork.SaveChangesAsync()
                                                       │
                                                       └── commit → eventi di dominio
```

Regole che tengono in piedi l'impianto:

- **Gli handler orchestrano, il dominio decide.** L'handler carica ciò che serve, chiede
  all'aggregato o al domain service di decidere, salva.
- **Gli handler non vedono mai `AppDbContext`.** I comandi usano `I{Aggregato}Repository` +
  `IUnitOfWork`; le query usano `IReadDbContext` + `IQueryExecutor`.
- **Il dominio protegge i propri invarianti**: setter privati, collezioni in sola lettura, factory
  method come unica porta di costruzione.
- Ogni scrittura registra un **audit log** con attore, entità, azione, IP e snapshot prima/dopo.
  Lo fa un interceptor sul `DbContext`: un handler non lo scrive mai a mano.
- Le eccezioni non si gestiscono negli handler: `ExceptionHandlingMiddleware` le traduce in
  risposte **ProblemDetails** (RFC 7807).

| Eccezione | HTTP |
|---|---|
| `ValidationException` (FluentValidation) | 400 |
| `UnauthorizedException` | 401 |
| `ForbiddenException` | 403 |
| `NotFoundException` | 404 |
| `SystemEntityException` | 403 |
| `ConflictException` | 409 |
| `InvariantViolationException` | 409 |
| `ConcurrencyConflictException` | 409 |
| qualsiasi altra | 500 |

Queste regole non sono affidate alla memoria: `<Progetto>.Architecture.Tests` ispeziona gli assembly
compilati e **fa fallire la build** se un layer dipende da chi non dovrebbe, o se un'entità espone
setter pubblici. Il dettaglio completo è nella sezione
[Architettura](../architettura/clean-architecture.md).

### Le API incluse

Dieci gruppi di endpoint, tutti sotto `/api`:

| Area | Rotte |
|---|---|
| Accesso | `/api/auth` |
| Identità | `/api/users` · `/api/groups` · `/api/roles` · `/api/permissions` |
| Trasversali | `/api/public` |
| Sistema | `/api/audit-logs` · `/api/error-logs` · `/api/system-config` · `/api/monitoring` |

Sono le rotte dell'impianto: quelle del dominio si aggiungono accanto, registrandole in
`<Progetto>.Api/Extensions/EndpointExtensions.cs`.

In esecuzione l'API espone la propria specifica OpenAPI (`/openapi/v1.json`), navigabile con
Swagger UI su `/swagger`. È lo stesso schema da cui il frontend genera i propri tipi con
`pnpm gen:api`: perché un tipo compaia, l'endpoint deve dichiarare `.Produces<T>()`.

### Cosa c'è in `Program.cs`

Oltre alla registrazione dei servizi, alcune scelte che vale la pena conoscere perché si notano
solo quando mancano:

- **`UseForwardedHeaders` come primissimo middleware.** Dietro un reverse proxy l'IP del client
  arriva in `X-Forwarded-For`: senza questo, ogni richiesta sembrerebbe provenire dal load balancer
  e il rate limiting per IP diventerebbe di fatto globale.
- **Rate limiting partizionato per IP**, non globale: 10 richieste ogni 15 minuti sugli endpoint di
  autenticazione in produzione (100 in `Development`), 20 al minuto sull'endpoint pubblico di
  raccolta errori.
- **Localizzazione della richiesta** in base ad `Accept-Language` (`it` predefinito, `en` supportato):
  i messaggi di errore dell'API seguono la lingua dell'utente.
- **Inizializzazione del database all'avvio**: `MigrateAsync()` applica le migration mancanti del
  provider attivo (e crea il database se non esiste); poi il seed, identico per i due provider, che
  popola **solo uno store vuoto** — mai un wipe, mai un reseed.

## Frontend — Vue 3

```
src/
├── pages/          # una pagina per rotta (home/, auth/, users/, groups/, roles/, system/…)
├── components/     # layout/ (AppShell, AppNav, AppTopBar, AppBreadcrumb), shared/, <dominio>/
├── stores/         # Pinia, uno per dominio (composition API) + auth, toast, navigation
├── services/       # le chiamate HTTP: solo qui si usa axios
├── composables/    # useAsyncAction, useServerTable, useApiErrors, usePermission, useBackNavigation…
├── config/         # app.config.ts (unico lettore di import.meta.env), sections.config.ts (menu)
├── plugins/        # vuetify, axios (interceptor), i18n, msal
├── locales/        # it.ts (predefinito) ed en.ts
├── types/          # api.generated.ts (da `pnpm gen:api`) e gli alias in api.types.ts
└── router/         # rotte figlie di AppShell, con meta.permission, title e section
```

La catena è sempre **service → store → pagina**: i componenti non chiamano mai `axios`
direttamente e non contengono logica di business; i testi passano tutti da `t('chiave')`; i tipi
dell'API sono generati dallo schema OpenAPI, non scritti a mano.

L'istanza axios in `plugins/axios.ts` aggiunge il Bearer token a ogni richiesta, propaga la lingua
in `Accept-Language`, su `401` tenta il refresh del token e ripete la richiesta (logout solo se il
refresh fallisce), su `5xx` invia un log degli errori al backend.

La sezione [Frontend](../frontend/struttura.md) percorre la struttura cartella per cartella e le
[convenzioni](../frontend/convenzioni.md) con cui si scrive una feature.

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
- [Configurazione](configurazione.md) — tutte le chiavi del backend e le variabili del frontend, dove si mettono
- [Le skill Claude](skill.md) — gli scaffolding inclusi per aggiungere codice nel modo previsto
- [Clean Architecture](../architettura/clean-architecture.md) — i layer, la regola delle dipendenze, dove mettere la logica
- [Frontend](../frontend/struttura.md) — la struttura del progetto Vue e le convenzioni con cui si scrive una feature
- [Infrastruttura](../infrastructure/panoramica.md) — perché due provider SQL e come sono tenuti insieme
- [Autenticazione](../autenticazione/autenticazione.md) — JWT, Azure AD, Windows, permessi
- [Aggiungere una feature](../guide/nuova-feature.md) — il percorso completo, end to end
- [Testare il backend](../guide/test-backend.md) — dominio, handler e architettura: che cosa si testa dove
- [Deploy su Render](../deploy/render.md) — come va in produzione
