# Panoramica del progetto

## Che cos'è

DelVoltone è un **gestionale di catalogo**: anagrafiche di prodotti con la loro classificazione
(tipologie, tipi prodotto, formati, lavorazioni) e la loro collocazione geografica (località, valli),
più tutto quello che serve a governarlo: utenti, gruppi, ruoli e permessi, tracciamento delle
modifiche, log degli errori, configurazione e monitoraggio del database.

Non è un'applicazione qualsiasi appoggiata a un database: due scelte la caratterizzano, e sono
il motivo per cui esiste buona parte di questa documentazione.

| Scelta | In pratica |
|---|---|
| **Doppio provider di database** | La stessa applicazione gira su SQL Server o su PostgreSQL, via Entity Framework Core. Si sceglie da configurazione, senza toccare il codice. Vedi [Database](../database_sql-only/panoramica.md). |
| **Doppia strategia di autenticazione** | Accesso con email e password oppure con account Microsoft (Azure AD). In entrambi i casi il backend emette un JWT interno. Vedi [Autenticazione](../autenticazione/autenticazione.md). |

## Il monorepo

Un workspace **Nx** con **pnpm**, due applicazioni:

```
del-voltone/
├── apps/
│   ├── backend/DelVoltone.Api/    # ASP.NET Core 10 — Minimal API, vertical slice
│   └── frontend/                  # Vue 3 + Vite + TypeScript
└── package.json                   # gli script di comodo del workspace
```

```bash
pnpm serve:backend      # API su http://localhost:5000
pnpm serve:frontend     # SPA su http://localhost:5173
pnpm build              # build di entrambe
pnpm test:frontend      # Vitest
```

Questa documentazione spiega *com'è fatto e perché*. Le convenzioni operative di scrittura del
codice — naming, struttura di una slice, regole dei repository — vivono **accanto al codice**, nel
repository dell'applicazione.

## Backend — vertical slice

Il backend non è diviso per livelli tecnici (controller / service / repository), ma **per
funzionalità**: ogni operazione vive in una cartella che contiene tutto ciò che le serve.

```
Features/
├── Valleys/                       # una feature
│   ├── CreateValley/              # una slice: comando + handler + validator + response
│   │   ├── CreateValleyCommand.cs
│   │   ├── CreateValleyHandler.cs
│   │   ├── CreateValleyValidator.cs
│   │   └── CreateValleyResponse.cs
│   ├── GetValleys/  GetValleyById/  UpdateValley/  DeleteValley/
│   └── ValleyEndpoints.cs         # solo routing, nessuna logica
└── _Shared/                       # ciò che è davvero comune a tutte le feature
    ├── Entities/                  # le POCO EF Core (int Id identity)
    ├── Persistence/               # AppDbContext + derivate per provider, migration
    ├── DatabaseStats/             # dimensioni DB e readiness, per provider
    ├── Seed/                      # DataSeeder (solo su DB vuoto)
    ├── Behaviors/                 # pipeline MediatR
    ├── Middleware/                # gestione errori
    └── Extensions/                # registrazione servizi ed endpoint
```

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

### Le API

Diciotto gruppi di endpoint, tutti sotto `/api`:

| Area | Rotte |
|---|---|
| Accesso | `/api/auth` |
| Identità | `/api/users` · `/api/groups` · `/api/roles` · `/api/permissions` |
| Catalogo | `/api/products` · `/api/product-types` · `/api/typologies` · `/api/formats` · `/api/workings` |
| Geografia | `/api/locations` · `/api/valleys` |
| Trasversali | `/api/lookups` · `/api/public` |
| Sistema | `/api/audit-logs` · `/api/error-logs` · `/api/system-config` · `/api/monitoring` |

In esecuzione l'API espone la propria specifica OpenAPI, navigabile con Scalar (`/scalar`) o con
Swagger UI (`/swagger`).

### Cosa c'è in `Program.cs`

Oltre alla registrazione dei servizi, alcune scelte che vale la pena conoscere perché si notano
solo quando mancano:

- **`UseForwardedHeaders` come primissimo middleware.** Dietro il proxy di Render l'IP del client
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
├── pages/          # una pagina per rotta (data/, users/, groups/, roles/, system/, audit-logs/…)
├── components/     # layout (AppShell, AppNav, AppTopBar), maps/, shared/
├── stores/         # Pinia, uno per dominio (composition API)
├── services/       # le chiamate HTTP: solo qui si usa axios
├── composables/    # usePermission, useApiErrors, useTheme, useBreadcrumb…
├── plugins/        # vuetify, axios (interceptor), i18n, msal
├── locales/        # it.ts (predefinito) ed en.ts
└── router/         # rotte con meta.permission
```

La catena è sempre **service → store → pagina**: i componenti non chiamano mai `axios`
direttamente e non contengono logica di business; i testi passano tutti da `t('chiave')`.

L'istanza axios in `plugins/axios.ts` aggiunge il Bearer token a ogni richiesta, propaga la lingua
in `Accept-Language` e su `401` esegue il logout.

Oltre alle pagine di gestione ci sono una **ricerca** trasversale e alcune **mappe** (mondo, Europa,
Italia, Emilia-Romagna, Piacenza) usate per la visualizzazione geografica del catalogo.

## Permessi

Il modello di autorizzazione è lo stesso da un capo all'altro dello stack.

Un permesso è una stringa `risorsa.azione` — `valleys.read`, `users.write`, `products.delete`.
I permessi sono raccolti in **ruoli**; i ruoli si assegnano a un utente **direttamente** o
**tramite i gruppi** a cui appartiene. Al login il backend risolve la lista completa (ruoli diretti
+ ruoli ereditati dai gruppi → permessi, deduplicati) e la scrive nel JWT come claim ripetuti.

Il seed iniziale crea **39 permessi**: le tre azioni `read` / `write` / `delete` sulle risorse del
catalogo e dell'identità, più `audit.*`, `errors.*`, `config.*`, `monitoring.read`,
`permissions.manage` e i tre permessi trasversali `data.*`.

Lo stesso permesso viene verificato in tre punti:

```csharp
// Backend — l'endpoint richiede il claim
group.MapDelete("/{id}", …)
    .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.delete"));
```

```typescript
// Frontend — la rotta non è raggiungibile senza il permesso
meta: { requiresAuth: true, permission: 'valleys.read' }
```

```vue
<!-- Frontend — il pulsante non viene nemmeno mostrato -->
<v-btn v-if="can('valleys.delete')" color="error" @click="remove" />
```

Nascondere il pulsante è cortesia verso l'utente; a **negare** l'operazione è sempre e solo il backend.

## Da qui

- [Database](../database_sql-only/panoramica.md) — perché due provider SQL e come sono tenuti insieme
- [Autenticazione](../autenticazione/autenticazione.md) — JWT, Azure AD, permessi
- [Aggiungere una feature](../guide/nuova-feature.md) — il percorso completo, su una slice reale
- [Deploy su Render](../deploy/render.md) — come va in produzione
