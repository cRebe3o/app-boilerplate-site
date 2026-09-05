# Database — implementazione

Il codice di ogni pezzo dell'architettura, nell'ordine in cui lo si incontra leggendo il backend.
I frammenti riproducono i file reali in `apps/backend/DelVoltone.Api/Features/_Shared/`, che restano
la fonte di verità: qui sono accompagnati dal **perché**, che nel codice non sempre c'è.

> La versione precedente — con repository Mongo/EF, conversioni `ObjectId` e `ITransactionRunner` —
> è documentata come storico in
> [Implementazione (SQL + Mongo)](../database_sql-mongo/implementazione.md). **Quel codice non esiste
> più nel repository.**

## 1. Lo switch di provider

`Features/_Shared/Extensions/DatabaseExtensions.cs` è il punto unico in cui il provider viene scelto.
È l'unico file dell'applicazione che nomina `UseSqlServer` e `UseNpgsql`.

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
- Il `default:` **fa fallire l'avvio**. Un `Database:Provider=MongoDB` ereditato da un vecchio deploy
  non viene ignorato in silenzio: l'applicazione si ferma dicendo quali valori sono ammessi.

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

## 2. `AppDbContext`: astratto, con tutto il modello

`Persistence/AppDbContext.cs` è `abstract` e contiene l'intero `OnModelCreating`. Le due derivate
sono **una riga ciascuna**:

```csharp
public class SqlServerAppDbContext(DbContextOptions<SqlServerAppDbContext> options) : AppDbContext(options);
public class PostgresAppDbContext(DbContextOptions<PostgresAppDbContext> options)  : AppDbContext(options);
```

Non contengono configurazione: esistono **solo** per dare un'identità ai due set di migration.

### I timestamp automatici

```csharp
private void ApplyTimestamps()
{
    var now = DateTime.UtcNow;
    foreach (var entry in ChangeTracker.Entries<ITimestamped>())
    {
        if (entry.State == EntityState.Added)
        {
            entry.Entity.CreatedAt = now;
            entry.Entity.UpdatedAt = now;
        }
        else if (entry.State == EntityState.Modified)
        {
            entry.Entity.UpdatedAt = now;
        }
    }
}

public override Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
{
    ApplyTimestamps();
    return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
}
```

L'override è sulla versione con `acceptAllChangesOnSuccess`, che è quella su cui convergono tutti gli
overload: intercettarla copre ogni chiamata, sync e async.

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

### Le FK del catalogo: `Restrict`, non `Cascade`

```csharp
e.HasOne(p => p.ProductType).WithMany().HasForeignKey(p => p.ProductTypeId)
    .OnDelete(DeleteBehavior.Restrict);     // obbligatoria: ogni prodotto ha un tipo

e.HasOne(p => p.Location).WithMany().HasForeignKey(p => p.LocationId)
    .OnDelete(DeleteBehavior.Restrict);     // int? → colonna nullable
```

`Cascade` qui sarebbe pericoloso: cancellare un formato cancellerebbe i prodotti che lo usano.
`Restrict` fa rifiutare la cancellazione dal database — e gli handler la anticipano con un conteggio
(vedi sotto).

### Le colonne vanno dimensionate

```csharp
e.Property(u => u.Email).HasMaxLength(256);
e.Property(u => u.PasswordHash).HasMaxLength(256);   // hash BCrypt = 60 char, teniamo margine
e.HasIndex(u => u.Email).IsUnique();
```

Senza `HasMaxLength`, EF genera `nvarchar(max)` / `text`: pessimo per indici e storage. `Email`
**deve** avere una lunghezza perché sotto è indicizzata unique — un indice unique non è ammesso su
`nvarchar(max)`.

Un caso limite da ricordare: `RefreshToken.Token` è `HasMaxLength(450)`, perché 450 è il massimo
indicizzabile su una colonna `nvarchar` in SQL Server (900 byte / 2).

Restano senza limite solo le colonne che non ne hanno uno sensato: `Product.Desc`, `Product.Photo`
(immagine in base64), `ErrorLog.Message`, `ErrorLog.StackTrace`, `AuditLog.Before`/`After`.

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

## 3. Gli handler: `AppDbContext` diretto, niente repository

Gli handler iniettano `AppDbContext` e usano `db.Set<T>()`. Non c'è nessuno strato intermedio.

### Lettura: proiezione diretta sul response

```csharp
var items = await db.Set<Format>()
    .AsNoTracking()
    .OrderBy(f => f.Order)
    .Select(f => new FormatResponse(f.Id, f.DescIt, f.DescEn, f.Order))
    .ToListAsync(ct);
```

`Select` verso il record di response fa sì che EF generi una `SELECT` con le sole colonne che servono
e non popoli il change tracker. Niente entità intermedie, niente mapping manuale.

### Scrittura: l'id identity esiste solo dopo il `SaveChanges`

```csharp
public class CreateFormatHandler(
    AppDbContext db,
    IHttpContextAccessor httpContextAccessor) : IRequestHandler<CreateFormatCommand, CreateFormatResponse>
{
    public async Task<CreateFormatResponse> Handle(CreateFormatCommand request, CancellationToken ct)
    {
        var format = new Format { DescIt = request.DescIt, DescEn = request.DescEn, Order = request.Order };

        db.Add(format);
        await db.SaveChangesAsync(ct);   // assegna l'id identity

        db.Add(AuditTrail.New(httpContextAccessor, "Format", format.Id, "Created"));
        await db.SaveChangesAsync(ct);

        return new CreateFormatResponse(format.Id);
    }
}
```

I due `SaveChangesAsync` non sono una svista: **l'audit log ha bisogno dell'id**, che il database
assegna solo al primo salvataggio. È la conseguenza pratica più visibile del passaggio da id generati
dal codice (`ObjectId.GenerateNewId()`) a id generati dal database.

### Delete di una lookup: conteggio prima, per un errore leggibile

```csharp
var format = await db.Set<Format>().FirstOrDefaultAsync(x => x.Id == request.Id, ct)
    ?? throw new NotFoundException("Format", request.Id);

// Conteggio prima della DELETE per dare un 409 con messaggio chiaro: la FK Restrict
// su Products farebbe comunque fallire la cancellazione, ma con un errore generico.
var count = await db.Set<Product>().CountAsync(x => x.FormatId == request.Id, ct);
if (count > 0)
    throw new ConflictException($"Impossibile eliminare questo formato: è ancora utilizzato in {count} prodotto/i. …");

var before = format.ToAuditJson();
db.Remove(format);
await db.SaveChangesAsync(ct);

db.Add(AuditTrail.New(httpContextAccessor, "Format", format.Id, "Deleted", before: before));
await db.SaveChangesAsync(ct);
```

Due difese sovrapposte, deliberatamente: l'handler dà il messaggio comprensibile, la FK `Restrict`
è la stessa regola applicata anche a chi scrivesse sul database da fuori.

### Update con M2M: il caso di `UpdatedAt`

```csharp
// Include delle M2M: servono per lo snapshot audit e perché EF possa calcolare
// il delta delle righe di join quando riassegnamo le liste.
var user = await db.Set<User>()
    .Include(u => u.Groups)
    .Include(u => u.Roles)
    .FirstOrDefaultAsync(u => u.Id == request.Id, ct)
    ?? throw new NotFoundException("User", request.Id);

var before = user.ToAuditJson();

user.Roles  = await db.Set<Role>().Where(r => roleIds.Contains(r.Id)).ToListAsync(ct);
user.Groups = await db.Set<Group>().Where(g => groupIds.Contains(g.Id)).ToListAsync(ct);

// Le modifiche alle sole M2M non marcano l'utente come Modified: si tocca UpdatedAt
// esplicitamente così ApplyTimestamps lo aggiorna anche in quel caso.
user.UpdatedAt = DateTime.UtcNow;

await db.SaveChangesAsync(ct);
```

⚠️ È **la trappola EF da non reintrodurre**: cambiare solo le collezioni non porta l'entità in stato
`Modified`, quindi `ApplyTimestamps` non la vedrebbe. Il pattern corretto è `Include` → riassegna la
lista con le entità caricate → tocca `UpdatedAt`.

### Operazioni bulk senza caricare le entità

```csharp
await db.Set<RefreshToken>()
    .Where(t => t.UserId == user.Id && !t.IsRevoked)
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.IsRevoked, true), ct);
```

`ExecuteUpdateAsync` / `ExecuteDeleteAsync` emettono una sola `UPDATE`/`DELETE` senza materializzare
le righe. Attenzione: **bypassano il change tracker**, quindi non passano da `ApplyTimestamps` e non
aggiornano entità già in memoria.

## 4. Le due migration, una per provider

Ogni modifica al modello richiede **due** migration. I comandi sono nel commento di
`DesignTimeFactories.cs`:

```bash
dotnet dotnet-ef migrations add <Nome> --context SqlServerAppDbContext --output-dir Features/_Shared/Persistence/Migrations/SqlServer
dotnet dotnet-ef migrations add <Nome> --context PostgresAppDbContext  --output-dir Features/_Shared/Persistence/Migrations/Postgres
```

Perché servano le factory: `dotnet ef` deve costruire il `DbContext` **senza avviare l'app**.

```csharp
public class SqlServerDesignTimeFactory : IDesignTimeDbContextFactory<SqlServerAppDbContext>
{
    public SqlServerAppDbContext CreateDbContext(string[] args)
    {
        var connectionString =
            Environment.GetEnvironmentVariable("ConnectionStrings__SqlServer")
            ?? "Server=(localdb)\\MSSQLLocalDB;Database=DelVoltone;Trusted_Connection=True;TrustServerCertificate=True";

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
// Migrations/SqlServer — 20260716172833_InitialCreate.cs
Id         = table.Column<int>(type: "int", nullable: false)
                  .Annotation("SqlServer:Identity", "1, 1"),
ActorEmail = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
Before     = table.Column<string>(type: "nvarchar(max)", nullable: true),
Timestamp  = table.Column<DateTime>(type: "datetime2", nullable: false),
```

```csharp
// Migrations/Postgres — 20260716172847_InitialCreate.cs
Id         = table.Column<int>(type: "integer", nullable: false)
                  .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
ActorEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
Before     = table.Column<string>(type: "text", nullable: true),
Timestamp  = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
```

> **Regola**: mai modificare una migration già committata. Una correzione è una **nuova** migration.

## 5. L'avvio: migrate e seed

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

Poiché gli id li assegna il database, il seed **non può** usare id costanti: i legami si esprimono
via navigation property, lasciando che EF risolva le FK al `SaveChanges`.

> Non esiste un comando di reset. Per ripartire da zero il database si droppa a mano.

## 6. Il servizio di pulizia dei token

Senza un TTL index (che era la soluzione ai tempi di Mongo), la tabella `RefreshTokens` crescerebbe
all'infinito. Il sostituto è un `BackgroundService`:

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

## 7. L'unico codice provider-specifico: `DatabaseStats`

Le dimensioni del database non si ottengono con LINQ: servono i cataloghi di sistema. È l'unica
astrazione per provider rimasta.

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

## 8. Checklist per una nuova entità

1. Classe in `Entities/` — `int Id`, `ITimestamped` se ha i timestamp.
2. Blocco in `OnModelCreating`: `ToTable`, `HasMaxLength` su ogni stringa, indici, FK/M2M.
3. **Due** migration (SqlServer + Postgres) con i comandi della sezione 4.
4. Verifica su **entrambi** i provider — in particolare le query con `Contains` su stringa, che
   cambiano comportamento fra i due.

Il percorso end-to-end, backend + frontend, è in
[Aggiungere una feature](../guide/nuova-feature.md).

## Approfondimenti

- **[Architettura](architettura.md)** — la struttura in cui questo codice si inserisce
- **[Decisioni](decisioni.md)** — perché `int`, perché è caduto Mongo, che cosa è stato scartato
