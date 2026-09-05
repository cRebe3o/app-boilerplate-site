# Infrastruttura — architettura

Questa pagina spiega **come** l'applicazione riesce a girare su due provider SQL diversi con un solo
modello: dove le due strade si separano, dove si riuniscono, e quali vincoli tengono in piedi la
portabilità. Il codice corrispondente è in [Implementazione](implementazione.md).

## Vista d'insieme

```
                     appsettings.json / appsettings.local.json
                              / variabili d'ambiente
                       Database:Provider + ConnectionStrings
                                     │
                                Program.cs
                        builder.Services.AddDatabase(config)
                                     │
              ┌──────────────────────┴──────────────────────┐
      "SqlServer" (default)                          "PostgreSQL"
              │                                              │
    AddDbContext<AppDbContext,                     AddDbContext<AppDbContext,
      SqlServerAppDbContext>                         PostgresAppDbContext>
    · UseSqlServer(...)                            · UseNpgsql(...)
    · EnableRetryOnFailure                         · EnableRetryOnFailure
    · IDatabaseStatsProvider → DMV                 · IDatabaseStatsProvider → pg_*
              │                                              │
              └──────────────────────┬──────────────────────┘
                                     │
                      ExpiredTokenCleanupService  (comune)
                                     │
                        ── all'avvio, in Program.cs ──
                          Database.MigrateAsync()
                               SeedAsync()
                                     ▼
                     AppDbContext (abstract, provider-agnostico)
                                     ▲
                                     │  unica dipendenza consentita
                          Handler MediatR (Features/**)
```

Le due catene **divergono in un punto solo** — `AddDatabase` — e **riconvergono su un tipo solo**:
`AppDbContext`. Tutto ciò che sta sopra e sotto è provider-agnostico.

## Il seam: `AppDbContext` astratto

Il punto architetturale che rende possibile tutto è un `DbContext` **astratto** che contiene
**l'intera** configurazione del modello, e due derivate **vuote**:

```csharp
public abstract class AppDbContext(DbContextOptions options) : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder mb) { /* tutto il model config */ }
}

public class SqlServerAppDbContext(DbContextOptions<SqlServerAppDbContext> options) : AppDbContext(options);
public class PostgresAppDbContext(DbContextOptions<PostgresAppDbContext> options) : AppDbContext(options);
```

Le derivate non aggiungono **niente**. Esistono per una ragione sola: EF Core associa un set di
migration a un tipo di `DbContext`, quindi servono due tipi distinti per avere due cartelle di
migration. È il pattern Microsoft *"migrations with multiple providers"*.

La DI registra la derivata giusta **dietro il tipo base**:

```csharp
services.AddDbContext<AppDbContext, SqlServerAppDbContext>(...);
```

Così ogni handler può iniettare `AppDbContext` e non sapere nulla del provider attivo.

**Niente strato repository.** Gli handler usano direttamente `db.Set<Entità>()` con LINQ: il seam
non è un insieme di interfacce da mantenere, è un tipo che EF Core fornisce già. Il perché — e il
prezzo che si paga — sono in [Decisioni](decisioni.md).

## Layout delle cartelle

```
Features/_Shared/
├── Entities/                       # POCO EF: int Id identity, ITimestamped, navigation M2M
│   ├── User.cs · Group.cs · Role.cs · Permission.cs
│   ├── AuditLog.cs · ErrorLog.cs · ErrorLevel.cs · ErrorSource.cs
│   ├── RefreshToken.cs · SystemConfig.cs
│   └── ITimestamped.cs
├── Persistence/
│   ├── AppDbContext.cs             # abstract: TUTTO il model config + ApplyTimestamps
│   ├── SqlServerAppDbContext.cs    # derivata vuota → Migrations/SqlServer
│   ├── PostgresAppDbContext.cs     # derivata vuota → Migrations/Postgres
│   ├── DesignTimeFactories.cs      # una factory per derivata, per `dotnet ef`
│   ├── ExpiredTokenCleanupService.cs
│   └── Migrations/
│       ├── SqlServer/              # vuota nel template: la riempie il primo InitialCreate
│       └── Postgres/
├── DatabaseStats/                  # l'unico punto con SQL provider-specifico
│   ├── IDatabaseStatsProvider.cs
│   ├── SqlServerDatabaseStatsProvider.cs
│   └── PostgresDatabaseStatsProvider.cs
├── Behaviors/                      # pipeline MediatR: logging, validazione
├── Middleware/                     # ExceptionHandlingMiddleware
├── Exceptions/                     # NotFound, Conflict, Forbidden, Unauthorized
├── Helpers/                        # AuditTrail, Username.Normalize, snapshot JSON
├── Seed/DataSeeder.cs              # comune, solo su store vuoto
└── Extensions/                     # AddDatabase, AddMediatRWithBehaviors, Auth, endpoint
```

Le entità di dominio del progetto si aggiungono in `Entities/`, accanto a queste.

## Il modello dati

Le POCO in `Entities/` sono l'**unico modello**: niente entità separate per provider, niente mapping
layer, nessun suffisso `Document` o `Entity`.

```csharp
public class User : ITimestamped
{
    public int Id { get; set; }                     // identity: lo assegna il DB
    public string Username { get; set; } = string.Empty;   // l'identità di login, unica
    public string? Email { get; set; }              // anagrafico, opzionale
    public List<Group> Groups { get; set; } = [];   // M2M → join table UserGroups
    public List<Role> Roles { get; set; } = [];     // M2M → join table UserRoles
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
```

Regole del modello:

| Aspetto | Regola |
|---|---|
| Chiave primaria | `int Id`, identity — mai `string` o `Guid` |
| Nomi | Nessun suffisso: `User`, `Group`, `AuditLog` |
| Stringhe | Sempre dimensionate con `HasMaxLength` in `OnModelCreating`; testo illimitato solo dove serve (messaggi, stack trace, snapshot audit) |
| Enum | Mappati come **stringa** (`HasConversion<string>()`): leggibili nel DB e stabili se cambia l'ordine dei membri |
| Date | `DateTime` UTC |
| Timestamp | `CreatedAt`/`UpdatedAt` impostati automaticamente da `ApplyTimestamps` in `SaveChanges` |
| M2M | Skip navigation **unidirezionale** (`User.Groups`, non `Group.Users`); la join table la gestisce EF |

### I timestamp sono automatici

`AppDbContext.SaveChangesAsync` percorre il change tracker e imposta i timestamp sulle entità
`ITimestamped`: `CreatedAt`+`UpdatedAt` sugli insert, il solo `UpdatedAt` sugli update. **Gli handler
non li valorizzano mai a mano.**

⚠️ **Unica eccezione da ricordare**: modificare **solo** le collezioni M2M di un'entità non la marca
come `Modified`, quindi `UpdatedAt` non si aggiorna da solo. Chi cambia solo i ruoli o i gruppi di un
utente deve toccare `UpdatedAt` esplicitamente (vedi `UpdateUserHandler`).

## Lo schema relazionale

Relazionale classico — **8 entità e 4 join table**, identiche nella struttura sui due provider. Le
relazioni molti-a-molti sono join table con chiave composta e `ON DELETE CASCADE`.

| Entità | Tabella | Vincoli principali |
|---|---|---|
| `User` | `Users` | `Username` unique (è la chiave di login); `Email` indicizzata ma **non** unique, perché opzionale |
| `Group` · `Role` · `Permission` | `Groups` · `Roles` · `Permissions` | `Permissions.Key` unique; nomi di gruppi e ruoli **non** unique (controllo applicativo) |
| — | `UserGroups` · `UserRoles` · `GroupRoles` · `RolePermissions` | PK composta, FK **CASCADE** su entrambi i lati |
| `RefreshToken` | `RefreshTokens` | `Token` unique (max 450 char), indice su `ExpiresAt`, FK `UserId` **CASCADE** |
| `AuditLog` · `ErrorLog` | `AuditLogs` · `ErrorLogs` | **nessuna FK**: lo storico deve sopravvivere alle cancellazioni; indici su `Timestamp` e su `(EntityType, EntityId)` |
| `SystemConfig` | `SystemConfigs` | riga singola; i due `LogRetentionConfig` annidati sono `ComplexProperty` → colonne `ErrorLogs_*` / `AuditLogs_*` nella stessa tabella |

Le tabelle del dominio si aggiungono a queste. Per i riferimenti singoli la convenzione del
template è la FK con `Restrict`, non `Cascade`: una voce di lookup ancora usata non si deve poter
cancellare, e il tentativo torna `409 Conflict`.

### Perché audit ed error log non hanno FK

`ActorId` ed `EntityId` **non** sono chiavi esterne, ed è una scelta deliberata. Se `ActorId` fosse
una FK verso `Users`, cancellare un utente cancellerebbe (o bloccherebbe) le tracce di ciò che ha
fatto — l'opposto dello scopo di un audit log. Inoltre `EntityId` è **polimorfo**: punta a tabelle
diverse a seconda di `EntityType`, quindi una FK non sarebbe nemmeno esprimibile.

## Le differenze fra i due provider

Il modello è unico, ma i tipi generati dalle migration sono naturalmente quelli nativi di ciascun
database:

| Concetto | SQL Server | PostgreSQL |
|---|---|---|
| Chiave primaria | `int` + `IDENTITY(1,1)` | `integer` + `GENERATED BY DEFAULT AS IDENTITY` |
| Stringa dimensionata | `nvarchar(256)` | `character varying(256)` |
| Testo illimitato | `nvarchar(max)` | `text` |
| Data/ora | `datetime2` | `timestamp with time zone` |
| Statistiche DB | DMV (`sys.dm_db_partition_stats`, `sys.database_files`) | cataloghi `pg_*` (`pg_database_size`, …) |
| `Contains` su stringa | **case-insensitive** (collation di default) | **case-sensitive** |

Le prime quattro righe le gestisce EF Core da solo. La quinta è astratta dietro
`IDatabaseStatsProvider`. **La sesta è l'unica che riguarda chi scrive codice**, ed è la trappola
principale di questa architettura.

### La trappola della ricerca case-sensitive

Una `Where(x => x.Username.Contains(term))` si comporta **diversamente** sui due provider. La
contromisura adottata: l'username di login si salva **sempre in minuscolo**, normalizzato da un
unico helper, e si confronta con input passato dallo stesso helper. Per le ricerche testuali del
dominio, qualunque nuova query deve essere verificata su entrambi i provider prima di considerarsi
finita.

## Transazioni

Tutti gli handler di una richiesta condividono lo stesso `AppDbContext` scoped: un singolo
`SaveChangesAsync` è già atomico, e dove serve una transazione esplicita si usa direttamente
`db.Database.BeginTransactionAsync`. Le cancellazioni a cascata delle join table le garantisce il
**database** con le FK `CASCADE`, non codice scritto a mano negli handler.

⚠️ Un dettaglio che si paga caro se lo si ignora: **entrambi i provider hanno
`EnableRetryOnFailure`**, e con una strategia di retry attiva le transazioni aperte a mano vanno
eseguite **dentro** la strategia, altrimenti EF lancia *"does not support user-initiated
transactions"*. Il seed lo fa già, con `db.Database.CreateExecutionStrategy()`.

## Lifetime nella DI

| Servizio | Lifetime | Perché |
|---|---|---|
| `AppDbContext` (via derivata) | **Scoped** | Non è thread-safe e porta con sé il change tracker: deve nascere e morire con la richiesta |
| `IDatabaseStatsProvider` | **Scoped** | Usa la connessione del contesto della richiesta |
| `ExpiredTokenCleanupService` | **Singleton** (`HostedService`) | È un `BackgroundService`; crea uno **scope proprio** a ogni passata per ottenere un `AppDbContext` |

Il `BackgroundService` che si crea lo scope da solo è il dettaglio che vale la pena ricordare:
iniettare un `DbContext` scoped direttamente in un singleton è l'errore classico, e qui è evitato in
`CleanupAsync` con `scopeFactory.CreateScope()`.

## Come devono fallire

| Situazione | Comportamento |
|---|---|
| `Database:Provider` assente | Default `SqlServer` |
| `Database:Provider` con un valore sconosciuto | `InvalidOperationException` **all'avvio**, con i valori ammessi nel messaggio |
| Connection string del provider attivo mancante | `InvalidOperationException` all'avvio, che dice **dove** impostarla (`appsettings.local.json` o `ConnectionStrings__<Provider>`) |
| Database irraggiungibile | Errore alla prima operazione: la connessione è pigra, non si apre all'avvio. `EnableRetryOnFailure` ritenta gli errori transitori |

Il principio: un errore di configurazione deve fermare l'applicazione **all'avvio** e spiegare come
si ripara, non fallire a metà di una richiesta.

## Approfondimenti

- **[Implementazione](implementazione.md)** — il codice di ogni componente citato qui
- **[Decisioni](decisioni.md)** — perché `int`, perché niente repository, che cosa è stato scartato
