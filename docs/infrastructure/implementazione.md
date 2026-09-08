# Infrastruttura — implementazione

Il codice di ogni pezzo dell'architettura, nell'ordine in cui lo si incontra leggendo il backend.
I frammenti riproducono i file reali in `apps/backend/`, che restano la fonte di verità: qui sono
accompagnati dal **perché**, che nel codice non sempre c'è.

## 1. Lo switch di provider

`<Progetto>.Infrastructure/DependencyInjection.cs` è il punto unico in cui il provider viene scelto.
È l'unico file dell'applicazione che nomina `UseSqlServer` e `UseNpgsql` (a parte le factory
design-time, che servono a `dotnet ef`).

```csharp
public static class DatabaseExtensions
{
    public const string SqlServerProvider = "SqlServer";
    public const string PostgresProvider  = "PostgreSQL";

    public static IServiceCollection AddDatabase(this IServiceCollection services, IConfiguration configuration)
    {
        var provider = configuration["Database:Provider"] ?? SqlServerProvider;

        switch (provider)
        {
            case SqlServerProvider:
                // EnableRetryOnFailure: retry automatici sugli errori transitori (utile su DB gestiti/cloud).
                services.AddDbContext<AppDbContext, SqlServerAppDbContext>(options =>
                    options.UseSqlServer(GetConnectionString(configuration, SqlServerProvider),
                        sql => sql.EnableRetryOnFailure()));
                services.AddScoped<IDatabaseStatsProvider, SqlServerDatabaseStatsProvider>();
                break;

            case PostgresProvider:
                services.AddDbContext<AppDbContext, PostgresAppDbContext>(options =>
                    options.UseNpgsql(GetConnectionString(configuration, PostgresProvider),
                        npgsql => npgsql.EnableRetryOnFailure()));
                services.AddScoped<IDatabaseStatsProvider, PostgresDatabaseStatsProvider>();
                break;

            default:
                throw new InvalidOperationException(
                    $"Database:Provider '{provider}' non valido. Valori ammessi: {SqlServerProvider}, {PostgresProvider}.");
        }

        // Pulizia oraria dei refresh token scaduti: uguale per entrambi i provider.
        services.AddHostedService<ExpiredTokenCleanupService>();

        return services;
    }
}
```

Due dettagli che vale la pena notare:

- **`AddDbContext<AppDbContext, SqlServerAppDbContext>`** registra la derivata *dietro il tipo base*.
  È la riga che rende il resto del codice provider-agnostico: gli handler chiedono `AppDbContext` e
  ricevono l'implementazione giusta.
- Il `default:` **fa fallire l'avvio**. Un valore sbagliato ereditato da un vecchio deploy non viene
  ignorato in silenzio: l'applicazione si ferma dicendo quali valori sono ammessi.

La connection string viene letta con un messaggio d'errore che dice *dove* impostarla:

```csharp
private static string GetConnectionString(IConfiguration configuration, string name)
{
    var connectionString = configuration.GetConnectionString(name);
    if (string.IsNullOrWhiteSpace(connectionString))
        throw new InvalidOperationException(
            $"{name} connection string mancante. Impostala in appsettings.local.json " +
            $"o nella variabile d'ambiente ConnectionStrings__{name}.");
    return connectionString;
}
```

### La configurazione, in ordine di precedenza

In `Program.cs` l'ordine delle sorgenti è deliberato:

```csharp
// appsettings.local.json (gitignored) per i segreti locali.
// Le variabili d'ambiente vengono ri-aggiunte DOPO: local.json vince su appsettings.json,
// ma una variabile d'ambiente vince su tutto.
builder.Configuration.AddJsonFile("appsettings.local.json", optional: true, reloadOnChange: true);
builder.Configuration.AddEnvironmentVariables();
```

## 2. `AppDbContext`: astratto, e invisibile agli handler

`Persistence/AppDbContext.cs` è `abstract`. Le due derivate sono **una riga ciascuna**:

```csharp
public class SqlServerAppDbContext(DbContextOptions<SqlServerAppDbContext> options) : AppDbContext(options);
public class PostgresAppDbContext(DbContextOptions<PostgresAppDbContext> options)  : AppDbContext(options);
```

Non contengono configurazione: esistono **solo** per dare un'identità ai due set di migration.

Il commento in testa alla classe dichiara il proprio confine:

> Gli handler NON vedono questa classe: usano `IReadDbContext` per le query e i repository per i
> comandi. Qui dentro resta solo la meccanica di persistenza.

La configurazione del modello non è più in un `OnModelCreating` monolitico: ogni entità ha la
propria `IEntityTypeConfiguration` in `Persistence/Configurations/`, raccolta automaticamente.

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    // Raccoglie tutte le IEntityTypeConfiguration di questo assembly: aggiungere
    // un'entità non richiede di toccare questo file.
    modelBuilder.ApplyConfigurationsFromAssembly(Assembly.GetExecutingAssembly());
}
```

`AppDbContext` implementa anche `IReadDbContext`, ed è l'unico punto in cui i due mondi si toccano:

```csharp
public abstract class AppDbContext(DbContextOptions options) : DbContext(options), IReadDbContext
{
    // AsNoTracking su tutte: le query di lettura non devono popolare il change tracker,
    // che sarebbe puro costo — nessuna entità restituita da qui viene mai modificata.
    IQueryable<User> IReadDbContext.Users => Set<User>().AsNoTracking();
    IQueryable<RentalContract> IReadDbContext.RentalContracts => Set<RentalContract>().AsNoTracking();
    // …
}
```

Le implementazioni sono **esplicite** (`IReadDbContext.Users`): sono raggiungibili solo attraverso
l'interfaccia, non da chi ha in mano un `AppDbContext`.

### I timestamp, l'audit e la concorrenza: tre interceptor

Non sono più responsabilità del `DbContext` né degli handler. Sono interceptor registrati in
`DependencyInjection`, così valgono per **qualunque** salvataggio — anche quelli del seed o di un
hosted service, che non passano da un handler.

| Interceptor | Che cosa fa |
|---|---|
| `TimestampInterceptor` | `CreatedAt` / `UpdatedAt` su ogni entità `ITimestamped` |
| `AuditLogInterceptor` | Una riga `AuditLogs` per ogni radice di aggregato creata, modificata o cancellata, con snapshot prima/dopo |
| `ConcurrencyTokenInterceptor` | Rigenera il `Guid` di concorrenza delle entità `IVersioned` |

```csharp
services.AddScoped<TimestampInterceptor>();
services.AddScoped<AuditLogInterceptor>();
services.AddScoped<ConcurrencyTokenInterceptor>();
```

Il ragionamento è lo stesso per tutti e tre, ed è scritto in `ConcurrencyTokenInterceptor`:

> Farlo qui invece che negli aggregati significa che nessuno può dimenticarsene: un nuovo metodo su
> un aggregato, un import massivo, una correzione fatta da un hosted service, sono tutti coperti
> senza scrivere una riga in più.

> ⚠️ **Un handler non scrive mai un audit log a mano.** Se stai per aggiungere una riga `AuditLog`
> in un handler, l'interceptor lo sta già facendo. Il funzionamento completo — i tre momenti, gli
> snapshot, che cosa non viene tracciato — è in [Audit log](audit-log.md).

### Le M2M: skip navigation unidirezionale

Il pattern si ripete quattro volte (`User.Groups`, `User.Roles`, `Group.Roles`, `Role.Permissions`):

```csharp
e.HasMany(u => u.Groups).WithMany()
    .UsingEntity(
        "UserGroups",
        r => r.HasOne(typeof(Group)).WithMany().HasForeignKey("GroupId").OnDelete(DeleteBehavior.Cascade),
        l => l.HasOne(typeof(User)).WithMany().HasForeignKey("UserId").OnDelete(DeleteBehavior.Cascade),
        j => j.HasKey("UserId", "GroupId"));   // PK composta → niente coppie duplicate
```

`WithMany()` **senza argomenti** è la parte importante: la navigazione è unidirezionale, esiste
`User.Groups` ma non `Group.Users`. Meno superficie da mantenere, e nessun rischio di cicli di
serializzazione. La join table non ha una classe: le righe le gestisce EF quando si modifica la lista.

Le liste non si riassegnano da fuori: l'aggregato espone metodi che controllano le proprie
relazioni (`user.AssignRoles(...)`, `user.AssignGroups(...)`), e la collezione è in sola lettura.

⚠️ **La trappola EF, e come è stata chiusa.** Cambiare solo una collezione M2M lascia l'entità in
stato `Unchanged`: senza accorgimenti, riassegnare i ruoli di un utente non aggiornerebbe il suo
`UpdatedAt`. Prima bisognava ricordarsi di toccarlo a mano in ogni handler che riassegnava una
lista. Ora se ne occupa `TimestampInterceptor`, che guarda anche le collezioni:

```csharp
else if (entry.State == EntityState.Modified || HasModifiedCollections(entry))
    entry.Entity.UpdatedAt = now;

// Riassegnare una M2M non marca l'entità Modified, ma per l'utente è a tutti
// gli effetti una modifica.
private static bool HasModifiedCollections(EntityEntry entry) =>
    entry.State == EntityState.Unchanged && entry.Collections.Any(c => c.IsModified);
```

### Le colonne vanno dimensionate

```csharp
e.Property(u => u.Username).HasMaxLength(256).IsRequired();
e.Property(u => u.Email).HasMaxLength(256);
e.Property(u => u.PasswordHash).HasMaxLength(256);   // hash BCrypt = 60 char, teniamo margine

e.HasIndex(u => u.Username).IsUnique();   // è la chiave di login
e.HasIndex(u => u.Email);                 // solo per le ricerche: NON unique, è opzionale
```

Senza `HasMaxLength`, EF genera `nvarchar(max)` / `text`: pessimo per indici e storage. `Username`
**deve** avere una lunghezza perché sotto è indicizzato unique — un indice unique non è ammesso su
`nvarchar(max)`.

Un caso limite da ricordare: `RefreshToken.Token` è `HasMaxLength(450)`, perché 450 è il massimo
indicizzabile su una colonna `nvarchar` in SQL Server (900 byte / 2).

Restano senza limite solo le colonne che non ne hanno uno sensato: `ErrorLog.Message`,
`ErrorLog.StackTrace`, `AuditLog.Before`/`After`.

### Gli enum come stringa

```csharp
e.Property(x => x.Level).HasConversion<string>().HasMaxLength(50);
e.Property(x => x.Source).HasConversion<string>().HasMaxLength(50);
```

Il valore nel DB resta leggibile (`"Error"`, `"Frontend"`) e non si rompe se un domani cambia
l'ordine dei membri dell'enum.

### `SystemConfig`: oggetti annidati senza tabella extra

```csharp
mb.Entity<SystemConfigEntity>(e =>
{
    e.ToTable("SystemConfigs");
    e.ComplexProperty(x => x.ErrorLogs);
    e.ComplexProperty(x => x.AuditLogs);
});
```

I due `LogRetentionConfig` sono **valori, non entità**: `ComplexProperty` li appiattisce in colonne
della stessa tabella (`ErrorLogs_Enabled`, `AuditLogs_Enabled`, …). Nessuna tabella extra, nessuna
chiave da gestire.

## 3. La pipeline MediatR

Un'unica extension registra MediatR, i behavior e tutti i validator dell'assembly:

```csharp
public static IServiceCollection AddMediatRWithBehaviors(this IServiceCollection services)
{
    services.AddMediatR(cfg => cfg.RegisterServicesFromAssemblyContaining<Program>());

    // Pipeline: prima LoggingBehavior, poi ValidationBehavior
    services.AddTransient(typeof(IPipelineBehavior<,>), typeof(LoggingBehavior<,>));
    services.AddTransient(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));

    // Registra tutti i validator FluentValidation nell'assembly
    services.AddValidatorsFromAssemblyContaining<Program>();

    return services;
}
```

Le due conseguenze pratiche, valide per ogni slice che si aggiungerà:

- **Un validator non va registrato né invocato.** Basta che esista una classe
  `AbstractValidator<TCommand>` nell'assembly: `AddValidatorsFromAssemblyContaining` la trova, e il
  `ValidationBehavior` la esegue prima dell'handler. Se fallisce, l'handler non viene mai raggiunto.
- **Un handler non va registrato.** `RegisterServicesFromAssemblyContaining` scopre da sé ogni
  `IRequestHandler`.

L'ordine conta: il logging avvolge la validazione, così anche una richiesta respinta a `400` compare
nei log con la sua durata.

### La gestione degli errori

`ExceptionHandlingMiddleware` è il solo punto in cui un'eccezione diventa una risposta HTTP. Gli
handler **lanciano** e non catturano:

```csharp
var group = await groups.GetByIdAsync(request.Id, ct)
    ?? throw new NotFoundException($"Gruppo con id {request.Id} non trovato.");
```

Le eccezioni di dominio vivono in `<Progetto>.Domain/Exceptions/` — `NotFoundException`,
`ConflictException`, `InvariantViolationException`, `ForbiddenException`, `UnauthorizedException` —
e il middleware le mappa su 404, 409, 422, 403, 401. Tutto il resto è un 500, con il dettaglio nel
log e non nella risposta.

Che stiano nel **dominio** e non in un progetto di utilità è coerente con il resto: un contratto
confermato che rifiuta una modifica sta esprimendo una regola di business, non un errore tecnico.

Il formato è sempre **ProblemDetails** (RFC 7807), quindi il frontend può tradurre ogni errore con
un unico composable (`useApiErrors`) invece che caso per caso.

## 4. Gli handler: astrazioni, mai `AppDbContext`

Gli handler vivono in `<Progetto>.Application` e non conoscono EF Core. Che cosa iniettano dipende
dal tipo di operazione:

| Operazione | Dipendenze |
|---|---|
| **Comando** (Create / Update / Delete) | `I{Aggregato}Repository` + `IUnitOfWork` |
| **Query** (lettura) | `IReadDbContext` + `IQueryExecutor` |

Il perché di questa asimmetria è in [Comandi e query](../architettura/comandi-e-query.md).

### Lettura: `IQueryable` componibile, proiettato sul response

```csharp
public class GetGroupsHandler(IReadDbContext db, IQueryExecutor executor)
    : IRequestHandler<GetGroupsQuery, List<GroupResponse>>
{
    public Task<List<GroupResponse>> Handle(GetGroupsQuery request, CancellationToken ct) =>
        executor.ToListAsync(
            db.Groups.Select(g => new GroupResponse(g.Id, g.Name, g.Description)), ct);
}
```

`Select` verso il record di response fa sì che EF generi una `SELECT` con le sole colonne che
servono. Il tracking è già disattivato a monte, in `IReadDbContext`.

`IQueryExecutor` esiste perché `ToListAsync` e `CountAsync` sono extension method legate al provider
EF: invocarle su un `IQueryable` prodotto da un fake in memoria fallirebbe a runtime. Passando
dall'astrazione, l'handler resta eseguibile nei test unitari.

### Scrittura: carica l'aggregato, chiedi al dominio, salva

> L'esempio viene dalla sezione Noleggi di `app-demo`, il progetto dimostrativo generato dal
> template: nel template la forma è la stessa (vedi `CreateUserHandler`), ma senza domain service.

```csharp
public class ConfirmRentalContractHandler(
    IRentalContractRepository contracts,
    ICustomerRepository customers,
    IDateTimeProvider clock,
    IUnitOfWork unitOfWork) : IRequestHandler<ConfirmRentalContractCommand, ConfirmRentalContractResponse>
{
    public async Task<ConfirmRentalContractResponse> Handle(
        ConfirmRentalContractCommand request, CancellationToken ct)
    {
        var contract = await contracts.GetByIdAsync(request.Id, ct)
            ?? throw new NotFoundException($"Contratto con id {request.Id} non trovato.");

        var customer = await customers.GetByIdAsync(contract.CustomerId, ct)
            ?? throw new NotFoundException($"Cliente con id {contract.CustomerId} non trovato.");

        // L'handler CARICA i dati, il domain service DECIDE.
        var active = await contracts.GetActiveByCustomerAsync(customer.Id, ct);
        CustomerCreditService.EnsureCanCommit(customer, contract.TotalAmount, active);

        // L'aggregato impone i propri invarianti e solleva l'evento.
        contract.Confirm(clock.UtcNow);

        await unitOfWork.SaveChangesAsync(ct);   // audit e timestamp: li fanno gli interceptor

        return new ConfirmRentalContractResponse(/* … */);
    }
}
```

**Un solo `SaveChangesAsync`**, e nessuna menzione dell'audit: lo scrive l'interceptor. Nota anche
`clock.UtcNow` al posto di `DateTime.UtcNow` — è ciò che rende l'handler testabile con una data
fissata.

### `IUnitOfWork`: il commit e poi gli eventi

`SaveChangesAsync` non è solo un passaggio al `DbContext`: è anche il punto in cui gli eventi di
dominio vengono pubblicati, nell'ordine giusto.

```csharp
public async Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
{
    var affected = await db.SaveChangesAsync(cancellationToken);

    // Solo ora gli id identity esistono e gli eventi puntano a entità reali.
    var domainEvents = CollectAndClearDomainEvents();

    if (domainEvents.Count > 0)
        await dispatcher.DispatchAsync(domainEvents, cancellationToken);

    return affected;
}
```

Gli eventi si raccolgono **dopo** il salvataggio (prima, gli id delle entità nuove varrebbero `0`) e
si pubblicano **dopo** il commit (un evento dice che un fatto *è avvenuto*). Il dettaglio è in
[Comandi e query](../architettura/comandi-e-query.md#gli-eventi-di-dominio-e-la-transazione).

### Delete con dipendenze: due difese sovrapposte

La regola di cancellabilità appartiene all'aggregato, non all'handler:

```csharp
// AppDemo.Domain/Rentals/RentalContract.cs
public void EnsureDeletable()
{
    // Un contratto confermato o chiuso è un documento commerciale: si annulla, non si
    // cancella. Farlo sparire toglierebbe la traccia di un impegno realmente assunto.
    if (Status != RentalStatus.Draft)
        throw new ConflictException(
            $"Solo i contratti in bozza si possono eliminare: {Reference} è in stato {Status}. " +
            "Usa l'annullamento per interrompere un contratto già confermato.");
}
```

```csharp
// L'handler la chiama soltanto.
var contract = await contracts.GetByIdAsync(request.Id, ct)
    ?? throw new NotFoundException($"Contratto con id {request.Id} non trovato.");

contract.EnsureDeletable();

contracts.Remove(contract);
await unitOfWork.SaveChangesAsync(ct);
```

Sulle entità referenziate da altre, il controllo applicativo anticipa il vincolo del database: il
dominio dà il messaggio comprensibile (`409 Conflict`), la FK `Restrict` è la stessa regola applicata
anche a chi scrivesse sul database da fuori. **Due difese sovrapposte, deliberatamente.**

### Operazioni bulk senza caricare le entità

```csharp
await db.Set<RefreshToken>()
    .Where(t => t.UserId == user.Id && !t.IsRevoked)
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.IsRevoked, true), ct);
```

`ExecuteUpdateAsync` / `ExecuteDeleteAsync` emettono una sola `UPDATE`/`DELETE` senza materializzare
le righe. Vivono **dentro un repository**, perché toccano EF direttamente.

⚠️ **Bypassano il change tracker**, quindi non passano dagli interceptor: niente timestamp, niente
audit log, nessun evento di dominio. Vanno usate dove quel comportamento è accettabile — la revoca
massiva dei token lo è, la cancellazione di entità di dominio quasi mai.

## 5. Le due migration, una per provider

Ogni modifica al modello richiede **due** migration. I comandi sono nel commento di
`DesignTimeFactories.cs`:

Le migration vivono in `<Progetto>.Infrastructure`, ma il comando ha bisogno di `<Progetto>.Api`
come startup project — è lì la configurazione:

```bash
cd apps/backend/<Progetto>.Api

dotnet dotnet-ef migrations add <Nome> \
  --project ../<Progetto>.Infrastructure/<Progetto>.Infrastructure.csproj \
  --startup-project <Progetto>.Api.csproj \
  --context SqlServerAppDbContext --output-dir Persistence/Migrations/SqlServer

dotnet dotnet-ef migrations add <Nome> \
  --project ../<Progetto>.Infrastructure/<Progetto>.Infrastructure.csproj \
  --startup-project <Progetto>.Api.csproj \
  --context PostgresAppDbContext  --output-dir Persistence/Migrations/Postgres
```

> Nel template le due cartelle sono **vuote**: la prima coppia di migration (`InitialCreate`) si
> genera alla nascita del progetto. Vedi [Generare e aggiornare](../progetto/generazione.md).

Perché servano le factory: `dotnet ef` deve costruire il `DbContext` **senza avviare l'app**.

```csharp
public class SqlServerDesignTimeFactory : IDesignTimeDbContextFactory<SqlServerAppDbContext>
{
    public SqlServerAppDbContext CreateDbContext(string[] args)
    {
        var connectionString =
            Environment.GetEnvironmentVariable("ConnectionStrings__SqlServer")
            ?? "Server=(localdb)\\MSSQLLocalDB;Database=<Progetto>;Trusted_Connection=True;TrustServerCertificate=True";

        var options = new DbContextOptionsBuilder<SqlServerAppDbContext>()
            .UseSqlServer(connectionString)
            .Options;

        return new SqlServerAppDbContext(options);
    }
}
```

La connection string **non viene usata per connettersi**: `migrations add` non tocca il database,
serve solo perché `UseSqlServer`/`UseNpgsql` ne pretendono una. Conta solo per `database update`.

### Lo stesso modello, tipi nativi diversi

Le due migration generate dallo stesso `OnModelCreating` differiscono solo nei tipi:

```csharp
// Migrations/SqlServer
Id         = table.Column<int>(type: "int", nullable: false)
                  .Annotation("SqlServer:Identity", "1, 1"),
ActorEmail = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
Before     = table.Column<string>(type: "nvarchar(max)", nullable: true),
Timestamp  = table.Column<DateTime>(type: "datetime2", nullable: false),
```

```csharp
// Migrations/Postgres
Id         = table.Column<int>(type: "integer", nullable: false)
                  .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
ActorEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
Before     = table.Column<string>(type: "text", nullable: true),
Timestamp  = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
```

> **Regola**: mai modificare una migration già committata. Una correzione è una **nuova** migration.

## 6. L'avvio: migrate e seed

In fondo a `Program.cs`, uguale per entrambi i provider:

```csharp
// Applica le migration mancanti del provider attivo (mai EnsureCreated, mai drop).
// MigrateAsync crea anche il database se non esiste.
using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
}

// Seed dei dati iniziali: popola SOLO uno store vuoto — mai wipe, mai reseed.
await app.SeedAsync();
```

Il gate del seeder è la prima riga utile di `DataSeeder`:

```csharp
// Se esistono già dati non fare nulla
if (await db.Set<Role>().AnyAsync(CancellationToken.None)) return;
```

### Il seed gira in transazione, dentro la strategia di retry

```csharp
// Con EnableRetryOnFailure attivo, una transazione aperta a mano va eseguita DENTRO
// la strategia di esecuzione, altrimenti EF lancia
// "does not support user-initiated transactions".
var strategy = db.Database.CreateExecutionStrategy();
await strategy.ExecuteAsync(() => SeedAllAsync(app, config, db));
```

Tre precauzioni che si spiegano a vicenda:

- **Tutto in una transazione.** Senza, un'interruzione a metà lascerebbe dati parziali: il gate al
  riavvio riterrebbe il database vuoto e riscriverebbe tutto da capo, schiantandosi sull'indice
  unico dei permessi.
- **`ChangeTracker.Clear()` all'inizio.** `ExecuteAsync` può rieseguire il delegate da capo: senza il
  reset, le entità del tentativo fallito sarebbero ancora tracciate come `Added` e verrebbero
  reinserite.
- **Nessun rollback esplicito.** Se qualcosa lancia, il dispose della transazione non committata
  annulla tutto quanto scritto fin lì.

Poiché gli id li assegna il database, il seed **non può** usare id costanti: i legami si esprimono
via navigation property, lasciando che EF risolva le FK al `SaveChanges`.

L'amministratore iniziale è configurabile: `Seed:AdminUsername` (default `admin`),
`Seed:AdminEmail` (vuoto = si riusa lo username, se ha la forma di un'email),
`Seed:AdminDisplayName` (default `Administrator`) e `Seed:AdminPassword`. Con il login MSAL lo
username dev'essere l'email aziendale con cui si entra. Se la password non è configurata ne viene
generata una casuale — che, non essendo stampata in chiaro, di fatto obbliga a impostarla.

> Non esiste un comando di reset. Per ripartire da zero il database si droppa a mano.

## 7. Il servizio di pulizia dei token

Senza un meccanismo di scadenza automatica lato database, la tabella `RefreshTokens` crescerebbe
all'infinito. La soluzione è un `BackgroundService`:

```csharp
public class ExpiredTokenCleanupService(
    IServiceScopeFactory scopeFactory,
    ILogger<ExpiredTokenCleanupService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Una prima passata subito all'avvio: se il processo è stato fermo a lungo, i token
        // scaduti nel frattempo non devono aspettare un'ora per essere rimossi.
        await CleanupAsync(stoppingToken);

        using var timer = new PeriodicTimer(Interval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
            await CleanupAsync(stoppingToken);
    }

    private async Task CleanupAsync(CancellationToken ct)
    {
        try
        {
            // Il DbContext è scoped: un BackgroundService è singleton, quindi serve uno scope proprio.
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            var deleted = await db.Set<RefreshToken>()
                .Where(t => t.ExpiresAt < DateTime.UtcNow)
                .ExecuteDeleteAsync(ct);

            if (deleted > 0)
                logger.LogInformation("Pulizia refresh token: {Count} token scaduti rimossi.", deleted);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutdown dell'app: non è un errore.
        }
        catch (Exception ex)
        {
            // Un errore (es. DB momentaneamente irraggiungibile) non deve terminare il servizio.
            logger.LogError(ex, "Pulizia dei refresh token scaduti fallita: riprovo tra {Interval}.", Interval);
        }
    }
}
```

Tre dettagli deliberati: lo **scope proprio** (un singleton non può iniettare un `DbContext` scoped),
il `catch` che **non fa morire il servizio** su un errore transitorio, e la distinzione fra
cancellazione da shutdown ed errore vero.

## 8. L'unico codice provider-specifico: `DatabaseStats`

Le dimensioni del database non si ottengono con LINQ: servono i cataloghi di sistema. È l'unica
astrazione per provider dell'applicazione.

```csharp
public interface IDatabaseStatsProvider
{
    Task<DatabaseSize> GetSizeAsync(CancellationToken ct);

    /// <summary>Readiness probe: true se il database risponde.</summary>
    Task<bool> PingAsync(CancellationToken ct);
}

public record DatabaseSize(double DataBytes, double StorageBytes, double IndexBytes, double LimitBytes);
```

Su PostgreSQL l'implementazione interroga i cataloghi `pg_*`:

```csharp
var storageBytes = await ScalarAsync(
    "SELECT pg_database_size(current_database())::float8 AS \"Value\"", ct);

public Task<bool> PingAsync(CancellationToken ct) => db.Database.CanConnectAsync(ct);

private Task<double> ScalarAsync(string sql, CancellationToken ct) =>
    db.Database.SqlQueryRaw<double>(sql).SingleAsync(ct);
```

Su SQL Server la stessa interfaccia è servita dalle DMV (`sys.dm_db_partition_stats`,
`sys.database_files`). L'handler di monitoraggio inietta l'interfaccia e non sa quale delle due sta
girando; le dimensioni tornano in **byte**, e la conversione in MB e la percentuale d'uso le fa
l'handler, uguali per entrambi.

## 9. Checklist per una nuova entità

1. **Aggregato** in `<Progetto>.Domain/<Dominio>/`: estende `Entity` o `AggregateRoot`, setter
   privati, collezioni in sola lettura, factory method come unica porta di costruzione. Aggiungi
   `ITimestamped` se ha i timestamp e `IVersioned` se serve concorrenza ottimistica.
2. **`IEntityTypeConfiguration`** in `Infrastructure/Persistence/Configurations/`: `ToTable`,
   `HasMaxLength` su ogni stringa, indici, FK/M2M. Viene raccolta in automatico, non c'è nessun
   file centrale da toccare.
3. **Repository** (se l'entità si scrive): interfaccia in `Application/Abstractions/Persistence/`,
   implementazione in `Infrastructure/Persistence/Repositories/`, registrazione in
   `DependencyInjection.cs`.
4. **Due** migration (SqlServer + Postgres) con i comandi della sezione 5.
5. Verifica su **entrambi** i provider — in particolare le query con `Contains` su stringa, che
   cambiano comportamento fra i due.

I test di architettura verificano da soli i punti 1 e 3: setter pubblici o collezioni mutabili
fanno fallire la build.

Il percorso end-to-end, backend + frontend, è in
[Aggiungere una feature](../guide/nuova-feature.md).

## Approfondimenti

- **[Clean Architecture](../architettura/clean-architecture.md)** — i quattro layer e la regola delle dipendenze
- **[Comandi e query](../architettura/comandi-e-query.md)** — repository, unit of work, `IReadDbContext`
- **[Architettura](architettura.md)** — la struttura in cui questo codice si inserisce
- **[Decisioni](decisioni.md)** — perché `int`, perché i repository solo sulle scritture
