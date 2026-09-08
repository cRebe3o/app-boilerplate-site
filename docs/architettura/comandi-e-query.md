# Comandi e query

Le scritture e le letture non hanno gli stessi problemi, e nel progetto **non passano dalla stessa
strada**:

| | **Comandi** (Create / Update / Delete) | **Query** (lettura) |
|---|---|---|
| Cosa iniettare | `I{Aggregato}Repository` + `IUnitOfWork` | `IReadDbContext` + `IQueryExecutor` |
| Che cosa manipolano | aggregati di dominio, con i loro invarianti | proiezioni verso DTO |
| Tracking EF | sì: le modifiche vengono osservate | no: `AsNoTracking` |
| Vedono EF Core? | mai | `IQueryable`, sì |

È una separazione **CQRS "leggera"**: due strade nello stesso database e nello stesso modello, non
due archivi separati.

## Perché due strade diverse

L'asimmetria è deliberata, ed è documentata in `IReadDbContext`:

> Le query di lettura sono proiezioni verso DTO e non contengono logica di dominio da proteggere.
> Farle passare da un repository significherebbe o materializzare gli aggregati interi e proiettare
> in memoria (caricando colonne inutili come `PasswordHash`), oppure duplicare in Infrastructure una
> firma per ogni combinazione di filtro e sort. I COMANDI, dove gli invarianti contano davvero,
> usano i repository e non vedono EF.

In due frasi: **i repository proteggono gli invarianti, e una lettura non ha invarianti da
proteggere.** Una griglia con ricerca, cinque filtri e ordinamento su otto colonne, dietro un
repository, diventa o una firma con dodici parametri o un metodo per combinazione.

Il prezzo è che `AppDemo.Application` referenzia l'assembly base di EF Core. È scritto nel `.csproj`
come scelta consapevole, e i test di architettura verificano il limite: l'assembly base sì, **i
provider no**.

## I comandi

> **Da dove vengono gli esempi.** Il template non porta un dominio applicativo. Gli esempi con
> `RentalContract`, `Customer` ed `Equipment` vengono dalla sezione Noleggi di `app-demo`, il
> progetto dimostrativo generato dal template: la forma è quella da imitare, il codice non è nel
> template.

### La forma

```csharp
public class CreateRentalContractHandler(
    IRentalContractRepository contracts,
    ICustomerRepository customers,
    IDateTimeProvider clock,
    IUnitOfWork unitOfWork) : IRequestHandler<CreateRentalContractCommand, CreateRentalContractResponse>
{
    public async Task<CreateRentalContractResponse> Handle(
        CreateRentalContractCommand request, CancellationToken cancellationToken)
    {
        var customer = await customers.GetByIdAsync(request.CustomerId, cancellationToken)
            ?? throw new NotFoundException($"Cliente con id {request.CustomerId} non trovato.");

        // Regola dell'aggregato Customer: qui si chiama soltanto.
        customer.EnsureCanRent();

        var period = RentalPeriod.From(request.From, request.To);

        // Il "presente" arriva da IDateTimeProvider, mai da DateTime.UtcNow: è ciò che
        // rende l'handler testabile con una data fissata.
        period.EnsureNotInThePast(clock.UtcNow);

        var reference = await GenerateReferenceAsync(period.Start.Year, cancellationToken);

        var contract = RentalContract.Open(reference, customer.Id, period, request.Notes);

        contracts.Add(contract);
        await unitOfWork.SaveChangesAsync(cancellationToken);

        return new CreateRentalContractResponse(contract.Id, contract.Reference);
    }
}
```

Quattro cose da notare:

- **Nessun `AppDbContext`.** L'handler non sa che esiste EF Core.
- **`customer.EnsureCanRent()`**: la regola è del dominio, l'handler la *chiama*.
- **`clock.UtcNow`** al posto di `DateTime.UtcNow`: un test può fissare "adesso".
- **`Add` e `SaveChangesAsync` sono separati**: il repository accumula, l'unit of work committa.

### I repository

Un'interfaccia per aggregato, in `Application/Abstractions/Persistence/`; l'implementazione in
`Infrastructure/Persistence/Repositories/`.

Espongono **operazioni di dominio**, non CRUD generico:

```csharp
public interface IRentalContractRepository
{
    Task<RentalContract?> GetByIdAsync(int id, CancellationToken ct = default);
    Task<RentalContract?> GetByReferenceAsync(string reference, CancellationToken ct = default);

    /// <summary>Contratti che impegnano una certa attrezzatura e si sovrappongono al periodo.</summary>
    Task<IReadOnlyList<RentalContract>> GetOverlappingAsync(
        IEnumerable<int> equipmentIds, RentalPeriod period,
        int? excludingContractId = null, CancellationToken ct = default);

    /// <summary>Contratti attivi di un cliente, con le righe. Input di CustomerCreditService.</summary>
    Task<IReadOnlyList<RentalContract>> GetActiveByCustomerAsync(int customerId, CancellationToken ct = default);

    Task<bool> ExistsByReferenceAsync(string reference, CancellationToken ct = default);

    void Add(RentalContract contract);
    void Remove(RentalContract contract);
}
```

`GetOverlappingAsync` e `GetActiveByCustomerAsync` esistono perché **i domain service hanno bisogno
di guardare altri contratti, e sono i repository — non il dominio — ad andarli a prendere**.

Il filtro avviene in SQL, e il commento dell'implementazione spiega perché non è un dettaglio:

> Caricare tutti i contratti e scartarli in memoria funzionerebbe finché la tabella è piccola, e
> smetterebbe di funzionare esattamente quando il sistema inizia a essere usato davvero.

Un repository carica sempre **l'aggregato completo** (`GetByIdAsync` include le righe): è l'unità
che si carica e si salva insieme.

`Add` e `Remove` non sono `async` e non salvano: registrano l'intenzione. Le **modifiche** a un
aggregato già caricato non richiedono nessuna chiamata — è tracciato, basta `SaveChangesAsync`.

### `IUnitOfWork` — il confine transazionale

```csharp
public interface IUnitOfWork
{
    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
```

Separarlo dai repository è ciò che permette a un handler di **modificare più aggregati e salvarli
insieme**, senza che ogni repository committi per conto proprio.

## Gli eventi di dominio e la transazione

`UnitOfWork` è anche il punto in cui gli eventi vengono pubblicati, e la sequenza non è arbitraria:

```csharp
public sealed class UnitOfWork(AppDbContext db, IDomainEventDispatcher dispatcher) : IUnitOfWork
{
    public async Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
    {
        var affected = await db.SaveChangesAsync(cancellationToken);

        // Solo ora gli id identity esistono e gli eventi puntano a entità reali.
        var domainEvents = CollectAndClearDomainEvents();

        if (domainEvents.Count > 0)
            await dispatcher.DispatchAsync(domainEvents, cancellationToken);

        return affected;
    }
}
```

**Perché raccoglierli dopo il salvataggio.** Un aggregato appena creato solleva il suo evento nel
factory, quando l'id identity vale ancora `0`. Raccogliere prima del commit significherebbe
pubblicare eventi che puntano a un'entità inesistente. Dopo il `SaveChanges` gli id ci sono e le
entità sono ancora tracciate: è l'unica finestra in cui entrambe le cose sono vere.

**Perché pubblicarli dopo il commit.** Un evento dice che un fatto *è avvenuto*. Pubblicarlo prima
significherebbe annunciare qualcosa che potrebbe non succedere mai — se il salvataggio fallisse, gli
handler avrebbero già reagito a un fatto inesistente, magari mandando una mail.

**Gli errori negli handler non annullano l'operazione.** La modifica è già persistente: se un
handler fallisce, l'errore va registrato ma non propagato, altrimenti il chiamante vedrebbe un
errore per un'operazione riuscita. Il limite va conosciuto, ed è dichiarato nel codice:

> Se l'aggiornamento di stato delle attrezzature fallisce, il contratto resta confermato con i pezzi
> ancora "disponibili". In un sistema di produzione la risposta è una **outbox** — gli eventi si
> salvano nella stessa transazione e un worker li ripubblica finché non riescono. Qui il log è
> sufficiente, ma il limite va conosciuto.

## Le query

### La forma

```csharp
public class GetRentalContractsHandler(
    IReadDbContext db,
    IQueryExecutor executor,
    IDateTimeProvider clock)
    : IRequestHandler<GetRentalContractsQuery, PagedResponse<RentalContractSummaryResponse>>
{
    public async Task<PagedResponse<RentalContractSummaryResponse>> Handle(
        GetRentalContractsQuery request, CancellationToken cancellationToken)
    {
        var query = db.RentalContracts;

        if (!string.IsNullOrWhiteSpace(request.Search))
            query = query.Where(c => c.Reference.Contains(request.Search.Trim().ToUpper()));

        if (request.CustomerId.HasValue)
            query = query.Where(RentalContractSpecs.ForCustomer(request.CustomerId.Value));

        // La specification incapsula "confermato E con fine già passata".
        if (request.OnlyOverdue == true)
            query = query.Where(RentalContractSpecs.Overdue(clock.UtcNow));

        var (page, pageSize) = Pagination.Normalize(request.Page, request.PageSize);

        var totalCount = await executor.CountAsync(query, cancellationToken);

        // Join verso l'anagrafica per il nome cliente: nelle query di lettura è legittima,
        // il confine di aggregato riguarda le SCRITTURE.
        var projected =
            from c in ApplySort(query, request.SortBy, request.SortDesc)
                .Skip((page - 1) * pageSize).Take(pageSize)
            join cust in db.Customers on c.CustomerId equals cust.Id
            select new RentalContractSummaryResponse(c.Id, c.Reference, cust.Name, /* … */);

        var items = await executor.ToListAsync(projected, cancellationToken);

        return new PagedResponse<RentalContractSummaryResponse>(items, totalCount, page, pageSize);
    }
}
```

### `IReadDbContext` — `IQueryable`, non `DbSet`

```csharp
public interface IReadDbContext
{
    IQueryable<User> Users { get; }
    IQueryable<RentalContract> RentalContracts { get; }
    IQueryable<Customer> Customers { get; }
    // …
}
```

Espone `IQueryable`, non `DbSet`: si compongono filtri, ordinamenti e proiezioni che EF traduce in
un'unica query SQL, **senza poter scrivere nulla** — nessun `Add`, nessun `SaveChanges`. Le query
sono già `AsNoTracking`.

### `IQueryExecutor` — perché non si chiama `ToListAsync` direttamente

`ToListAsync` e `CountAsync` sono extension method di EF Core legati al provider: invocarli su un
`IQueryable` prodotto da un fake in memoria **fallisce a runtime**. Passando dall'astrazione, gli
handler di query restano eseguibili nei test unitari con un'implementazione sincrona, e in
produzione usano il provider vero.

### Il confine di aggregato non vale nelle letture

Nella query sopra c'è una `join` esplicita verso `Customers`, perché `RentalContract` non ha una
navigation verso `Customer` — sono aggregati distinti. Nelle letture è legittima: **le query
proiettano verso DTO e non ricostruiscono il modello di dominio**, quindi non c'è nessun invariante
che possa essere aggirato.

## Dove finiscono audit, timestamp e concorrenza

Non negli handler, e nemmeno nell'unit of work: sono **interceptor sul `DbContext`**, così valgono
anche per i salvataggi che non passano da un handler (seed, hosted service).

| Interceptor | Che cosa fa |
|---|---|
| `TimestampInterceptor` | `CreatedAt` / `UpdatedAt` su ogni entità `ITimestamped` |
| `AuditLogInterceptor` | Registra la scrittura con attore, entità, azione, IP e snapshot prima/dopo |
| `ConcurrencyTokenInterceptor` | Rigenera il token di concorrenza a ogni scrittura |

È il motivo per cui `DomainModelTests` ammette setter pubblici **solo** per `CreatedAt`/`UpdatedAt`
e `ConcurrencyToken`: sono dati che il dominio non possiede e che l'infrastruttura deve poter
scrivere.

> Un handler non scrive mai un audit log a mano.

## Riepilogo: che cosa iniettare

| Sto scrivendo… | Inietto |
|---|---|
| Un comando che modifica un aggregato | `I{Aggregato}Repository`, `IUnitOfWork` |
| Un comando che tocca due aggregati | i due repository, `IUnitOfWork` (una sola transazione) |
| Una query di lista o dettaglio | `IReadDbContext`, `IQueryExecutor` |
| Qualcosa che ha bisogno dell'ora | `IDateTimeProvider` |
| Qualcosa che ha bisogno di sapere chi agisce | `ICurrentUser` |
| Un handler di evento di dominio | i repository che servono + `IUnitOfWork` |

Se ti serve `AppDbContext` in un handler, c'è qualcosa fuori posto: i test di architettura lo
segnalano prima della code review.

## Da qui

- **[Dove mettere la logica](dove-mettere-la-logica.md)** — handler, domain service, adapter
- **[Il dominio](il-dominio.md)** — aggregati, value object, eventi, specification
- **[Aggiungere una feature](../guide/nuova-feature.md)** — il percorso completo, end to end
