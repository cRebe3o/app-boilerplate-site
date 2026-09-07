# Clean Architecture

Il backend è organizzato in **quattro progetti**, ognuno un layer, con le dipendenze che puntano
tutte verso l'interno:

```
AppDemo.Api  →  AppDemo.Infrastructure  →  AppDemo.Application  →  AppDemo.Domain
   guscio            dettagli tecnici          casi d'uso              regole
```

La freccia si legge "dipende da". Il verso non è una preferenza estetica: è la proprietà da cui
discende tutto il resto, e l'unica che va difesa con attenzione.

## La regola delle dipendenze

**Il codice più interno non sa niente di quello più esterno.** Il dominio non sa che esiste un
database; l'Application layer non sa che esiste HTTP; nessuno dei due sa se sotto ci sia SQL Server
o PostgreSQL.

Il motivo pratico è che le cose cambiano a velocità diverse. Le regole di business — "un contratto
confermato non si modifica", "un cliente bloccato non noleggia" — sopravvivono a un cambio di
database, a un passaggio da REST a gRPC, a una riscrittura del frontend. Il codice che le contiene
non deve essere trascinato da nessuna di quelle sostituzioni.

Il rovescio è che il layer esterno *deve* poter far accadere qualcosa in quello interno: un handler
ha bisogno di leggere dal database, che è un dettaglio infrastrutturale. La soluzione è
l'**inversione delle dipendenze**: chi ha bisogno del servizio ne dichiara l'interfaccia, chi sa
fornirlo la implementa.

```
AppDemo.Application/Abstractions/Persistence/IRentalContractRepository.cs   ← dichiara
AppDemo.Infrastructure/Persistence/Repositories/RentalContractRepository.cs ← implementa
```

L'interfaccia vive con chi la **usa**, non con chi la soddisfa. È il motivo per cui `Abstractions/`
sta in `AppDemo.Application` e non in `AppDemo.Infrastructure`: così la freccia continua a puntare
verso l'interno, e Application resta compilabile senza Infrastructure.

## I quattro layer

### `AppDemo.Domain` — le regole

Il centro. Contiene entità, aggregati, value object, domain service, eventi e specification.

Il `.csproj` è la dichiarazione d'intenti più netta del progetto:

```xml
<!-- NESSUNA PackageReference, per scelta.
     Il dominio è il centro della cipolla: non conosce EF Core, ASP.NET, MediatR
     né alcun altro framework. Se qui serve un pacchetto, quasi sempre significa
     che il codice che lo richiede appartiene a un altro layer. -->
```

Zero dipendenze. Nemmeno EF Core, nemmeno MediatR. È una regola scomoda — costringe a pensare dove
mettere le cose — ed è esattamente il suo valore: il dominio si testa istanziando oggetti, senza
database, senza mock, senza contesto HTTP.

### `AppDemo.Application` — i casi d'uso

Un caso d'uso per cartella: comando o query, handler, validator, response. È il layer che
**orchestra**: carica ciò che serve, chiede al dominio di decidere, salva.

Dipende da `Domain`, da MediatR, da FluentValidation e — unica concessione — dall'assembly base di
EF Core:

```xml
<!-- EF Core (solo l'assembly base, NON i provider): serve per IQueryable e per i metodi
     async di materializzazione usati dalle QUERY di lettura tramite IReadDbContext.
     È la concessione consapevole dell'opzione A: i COMANDI restano su repository puri. -->
```

Il perché di questa asimmetria fra comandi e query è in [Comandi e query](comandi-e-query.md).

### `AppDemo.Infrastructure` — i dettagli

Tutto ciò che è sostituibile: EF Core e i due provider, i repository, il JWT, l'hashing delle
password, gli interceptor, il dispatcher degli eventi, la lettura dell'utente corrente dai claim.

Ogni classe qui dentro implementa un'interfaccia dichiarata in `Application`. È il layer che si
riscriverebbe passando a un altro ORM, e nessuno degli altri se ne accorgerebbe.

### `AppDemo.Api` — il guscio HTTP

Minimal API: rotte, permessi richiesti, documentazione OpenAPI. **Nessuna logica.** Un endpoint
riceve, delega a MediatR, restituisce.

È anche il **composition root**: l'unico punto che conosce sia le astrazioni sia le implementazioni,
e che le mette insieme nella DI.

```xml
<!-- L'API è il composition root: referenzia Infrastructure per registrarne le
     implementazioni, e Application per i tipi di command/query degli endpoint.
     NON referenzia direttamente EF Core: la persistenza è un dettaglio che vive
     dietro Infrastructure. -->
```

## Il percorso di una richiesta

```
HTTP
 │
 ├─ middleware (forwarded headers, CORS, errori, rate limit, i18n, auth)
 │
 ▼
Endpoint  ── AppDemo.Api ─────────────  solo routing + permesso richiesto
 │
 │  IMediator.Send(comando)
 ▼
LoggingBehavior      ── durata ed esito
ValidationBehavior   ── FluentValidation → 400, l'handler non viene raggiunto
 │
 ▼
Handler   ── AppDemo.Application ─────  orchestrazione
 │
 ├─ repository / IReadDbContext ─────── astrazioni, implementate in Infrastructure
 │
 ▼
Aggregato ── AppDemo.Domain ──────────  la decisione di business
 │
 ▼
IUnitOfWork.SaveChangesAsync()
 │
 ├─ interceptor: timestamp, audit log, token di concorrenza
 ├─ COMMIT
 └─ pubblicazione degli eventi di dominio ── dopo il commit, mai prima
```

Le tre regole che discendono da questo schema:

- **Gli endpoint non contengono logica.** Instradano e dichiarano il permesso.
- **I validator non si invocano.** Il `ValidationBehavior` li trova da sé.
- **Le eccezioni non si catturano negli handler.** Si lancia `NotFoundException`,
  `ConflictException`, `InvariantViolationException`; il middleware le traduce in
  ProblemDetails (RFC 7807).

## Le regole sono verificate dalla build

`AppDemo.Architecture.Tests` ispeziona i riferimenti **reali degli assembly compilati** — non i
`.csproj` — così intercetta anche una dipendenza entrata per via transitiva.

| Test | Che cosa impedisce |
|---|---|
| `Il_dominio_non_dipende_da_nessun_altro_layer` | Un `using AppDemo.Application` nel dominio |
| `Il_dominio_non_dipende_da_alcun_framework` | EF Core, ASP.NET o MediatR dentro `Domain` |
| `L_application_layer_non_dipende_da_infrastructure_ne_dall_api` | L'inversione delle dipendenze al contrario |
| `L_application_layer_non_dipende_da_ASP_NET` | `HttpContext` letto dentro un handler |
| `L_application_layer_non_dipende_da_un_provider_di_database_specifico` | Un `using Npgsql` in una query |
| `Infrastructure_non_dipende_dall_api` | Un riferimento all'indietro dal guscio |
| `Le_entita_non_espongono_setter_pubblici` | Uno stato modificabile scavalcando gli invarianti |
| `Le_entita_non_espongono_collezioni_mutabili` | Un `Add` diretto su una collezione dell'aggregato |

Il commento in testa a `LayerDependencyTests` spiega perché esistono:

> Sono i test più importanti del progetto e insieme i più noiosi: la separazione dei layer non si
> rompe con una decisione, si rompe con un `using` aggiunto di fretta un martedì pomeriggio.
> Un riferimento sbagliato fa fallire la build, non una code review.

## Che cosa si guadagna, concretamente

**Testabilità senza infrastruttura.** Il dominio si testa con `new`: `AppDemo.Domain.Tests` non ha
database né mock. Gli handler si testano con fake delle astrazioni, senza `HttpContext`.

**Sostituibilità dei dettagli.** I due provider SQL convivono perché nessun layer interno sa quale
sia attivo. Lo stesso varrebbe per un cambio di ORM.

**Le regole hanno un posto solo.** "Un pezzo non si noleggia due volte nello stesso giorno" sta in
`RentalAvailabilityService`, e vale per la conferma, per l'aggiunta di una riga e per l'import
massivo che qualcuno scriverà l'anno prossimo. Nessuna di quelle strade può aggirarla per
dimenticanza.

## Che cosa costa

Va detto, perché è la parte che si scopre lavorandoci:

- **Più file.** Una lettura banale richiede comando, handler, response ed endpoint. Una scrittura
  aggiunge il metodo sul repository e la sua implementazione.
- **Più salti per capire un flusso.** Un `IRentalContractRepository` va seguito fino
  all'implementazione per sapere che SQL produce.
- **La disciplina non è gratis.** La tentazione di iniettare `AppDbContext` in un handler "solo
  stavolta" arriva presto. È il motivo per cui esistono i test di architettura.

Il baratto conviene quando il dominio ha regole vere. Per un CRUD anagrafico senza invarianti è
sovrastruttura — e infatti le anagrafiche del template restano sottili, con la logica quasi tutta
negli handler.

## Da qui

- **[Dove mettere la logica](dove-mettere-la-logica.md)** — handler, domain service, application service: la domanda che decide
- **[Il dominio](il-dominio.md)** — aggregati, value object, eventi, specification, macchine a stati
- **[Comandi e query](comandi-e-query.md)** — repository per le scritture, `IReadDbContext` per le letture
- **[Aggiungere una feature](../guide/nuova-feature.md)** — il percorso completo, end to end
