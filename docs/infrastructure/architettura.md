# Database — architettura

Questa pagina spiega **come** l'applicazione riesce a girare su due provider SQL diversi con un solo
modello: dove le due strade si separano, dove si riuniscono, e quali vincoli tengono in piedi la
portabilità. Il codice corrispondente è in [Implementazione](implementazione.md).

> La versione precedente di questa architettura — dual-provider MongoDB / SQL Server, con strato
> repository — è documentata come storico in
> [Architettura (SQL + Mongo)](../database_sql-mongo/architettura.md).

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

**Niente strato repository.** È la differenza più visibile rispetto all'architettura precedente: non
esistono più 15 interfacce `I*Repository` con due implementazioni ciascuna. Gli handler usano
direttamente `db.Set<Entità>()` con LINQ. Il seam non è più un insieme di interfacce da mantenere: è
un tipo che EF Core fornisce già.

## Layout delle cartelle

```
Features/_Shared/
├── Entities/                       # POCO EF: int Id identity, ITimestamped, navigation M2M
│   ├── User.cs · Group.cs · Role.cs · Permission.cs
│   ├── Product.cs · ProductType.cs · Typology.cs · Format.cs
│   ├── Location.cs · Valley.cs · Working.cs
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
│       ├── SqlServer/              # 20260716172833_InitialCreate + snapshot
│       └── Postgres/               # 20260716172847_InitialCreate + snapshot
├── DatabaseStats/                  # l'unico punto con SQL provider-specifico
│   ├── IDatabaseStatsProvider.cs
│   ├── SqlServerDatabaseStatsProvider.cs
│   └── PostgresDatabaseStatsProvider.cs
├── Seed/DataSeeder.cs              # comune, solo su store vuoto
└── Extensions/DatabaseExtensions.cs  # AddDatabase: lo switch
```

Rispetto alla versione con Mongo sono spariti interi rami: `Repositories/` (con le sottocartelle
`Mongo/` e `Ef/`), `Transactions/`, `Documents/`, `Conversions.cs` e `Links.cs`.

## Il modello dati

Le POCO in `Entities/` sono l'**unico modello**: niente entità separate per provider, niente mapping
layer, nessun suffisso `Document`.

```csharp
public class User : ITimestamped
{
    public int Id { get; set; }                     // identity: lo assegna il DB
    public string Email { get; set; } = string.Empty;
    public List<Group> Groups { get; set; } = [];   // M2M → join table UserGroups
    public List<Role> Roles { get; set; } = [];     // M2M → join table UserRoles
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
```

Regole del modello:

| Aspetto | Regola |
|---|---|
| Chiave primaria | `int Id`, identity — mai `string`, `Guid` o `ObjectId` |
| Nomi | Nessun suffisso: `User`, `Product`, `AuditLog` |
| Stringhe | Sempre dimensionate con `HasMaxLength` in `OnModelCreating`; testo illimitato solo dove serve (Desc, Photo base64, StackTrace, snapshot audit) |
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

Relazionale classico — **19 tabelle**, identiche nella struttura sui due provider. Le relazioni
molti-a-molti sono join table con chiave composta e `ON DELETE CASCADE`; i riferimenti singoli sono
FK con `Restrict`, così una voce di lookup ancora usata non si può cancellare (il tentativo torna
`409 Conflict`).

| Entità | Tabella | Vincoli principali |
|---|---|---|
| `User` | `Users` | `Email` unique |
| `Group` · `Role` · `Permission` | `Groups` · `Roles` · `Permissions` | `Permissions.Key` unique; nomi di gruppi e ruoli **non** unique (controllo applicativo) |
| — | `UserGroups` · `UserRoles` · `GroupRoles` · `RolePermissions` | PK composta, FK **CASCADE** su entrambi i lati |
| `RefreshToken` | `RefreshTokens` | `Token` unique (max 450 char), indice su `ExpiresAt`, FK `UserId` **CASCADE** |
| `AuditLog` · `ErrorLog` | `AuditLogs` · `ErrorLogs` | **nessuna FK**: lo storico deve sopravvivere alle cancellazioni; indici su `Timestamp` e su `(EntityType, EntityId)` |
| `Product` | `Products` | FK `ProductTypeId` (Restrict, obbligatoria) + FK nullable verso Location, Valley, Format, Working (Restrict); indice su `Title` |
| `ProductType` | `ProductTypes` | FK `TypologyId` → `Typologies` (Restrict) |
| `Format` · `Location` · `Typology` · `Valley` · `Working` | tabelle omonime | lookup piatte |
| `SystemConfig` | `SystemConfigs` | i due `LogRetentionConfig` annidati sono `ComplexProperty` → colonne `ErrorLogs_*` / `AuditLogs_*` nella stessa tabella |

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

Una `Where(x => x.Email.Contains(term))` si comporta **diversamente** sui due provider. La
contromisura adottata: le email si salvano **sempre in minuscolo** e si confrontano con input già
normalizzato in minuscolo. Per le ricerche testuali del catalogo, qualunque nuova query deve essere
verificata su entrambi i provider prima di considerarsi finita.

## Il ciclo di vita, all'avvio

Il codice è lo stesso per entrambi i provider, in fondo a `Program.cs`:

| Passo | Che cosa succede |
|---|---|
| **Schema** | `Database.MigrateAsync()` applica le migration mancanti del provider attivo e **crea il database se non esiste**. Mai `EnsureCreated`, mai drop |
| **Indici** | Dichiarati nel model → creati dalle migration |
| **Seed** | `SeedAsync()`: popola **solo uno store vuoto**. Gate: se esiste anche un solo ruolo, esce subito |

Il seed inserisce rispettando l'ordine delle FK — tipologie, formati, località, valli, lavorazioni,
tipi prodotto, prodotti, poi permessi/ruoli/gruppi/utenti. Gli id li assegna il database, quindi i
legami del seed sono espressi via **navigation property**, non via id costanti.

> **Regola operativa**: non esiste wipe né reseed automatico. Per ripartire da zero il database si
> droppa a mano.

## Transazioni

`ITransactionRunner` **non esiste più**, ed è una semplificazione diretta della rimozione di Mongo.
Serviva perché su MongoDB la transazione è un oggetto — la sessione — da passare a ogni operazione,
mentre su EF Core vive sulla connessione del `DbContext`.

Oggi tutti gli handler di una richiesta condividono lo stesso `AppDbContext` scoped: un singolo
`SaveChangesAsync` è già atomico, e dove serve una transazione esplicita si usa direttamente
`db.Database.BeginTransactionAsync`. Le cancellazioni a cascata che prima erano scritte a mano negli
handler (`RemoveRoleFromAllUsersAsync`…) ora le garantisce il **database** con le FK `CASCADE`.

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
| `Database:Provider` con un valore sconosciuto (compreso `MongoDB`) | `InvalidOperationException` **all'avvio**, con i valori ammessi nel messaggio |
| Connection string del provider attivo mancante | `InvalidOperationException` all'avvio, che dice **dove** impostarla (`appsettings.local.json` o `ConnectionStrings__<Provider>`) |
| Database irraggiungibile | Errore alla prima operazione: la connessione è pigra, non si apre all'avvio. `EnableRetryOnFailure` ritenta gli errori transitori |

Il principio: un errore di configurazione deve fermare l'applicazione **all'avvio** e spiegare come
si ripara, non fallire a metà di una richiesta.

## Approfondimenti

- **[Implementazione](implementazione.md)** — il codice di ogni componente citato qui
- **[Decisioni](decisioni.md)** — perché `int`, perché è caduto Mongo, che cosa è stato scartato
