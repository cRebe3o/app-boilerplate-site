# Il dominio

`AppDemo.Domain` è il centro della cipolla: **zero dipendenze**, nemmeno EF Core. Questa pagina
percorre i mattoni con cui è costruito — aggregati, value object, macchine a stati, eventi,
specification — e il criterio con cui si sceglie quale usare.

> **Da dove vengono gli esempi.** Il template non porta un dominio applicativo: porta l'impianto.
> Gli esempi di questa pagina vengono dalla sezione **Noleggi** di `app-demo`
> (`AppDemo.Domain/Rentals` e `AppDemo.Domain/Customers`), che esiste apposta come *reference
> implementation*: tre aggregati, quattro value object, tre domain service, due macchine a stati e
> la comunicazione per eventi. È il modello da imitare, non codice da portarsi dietro.

## I mattoni di base

```
AppDemo.Domain/Common/
├── Entity.cs                   identità per Id
├── AggregateRoot.cs            radice + raccolta eventi
├── IDomainEvent.cs             fatto avvenuto
├── IDeferredIdentityEvent.cs   evento di un'entità con id non ancora assegnato
├── Specification.cs            criterio di selezione componibile
├── ITimestamped.cs             CreatedAt / UpdatedAt scritti dall'interceptor
└── IVersioned.cs               token di concorrenza ottimistica
```

`Entity` dà l'identità; `AggregateRoot` aggiunge la raccolta degli eventi:

```csharp
public abstract class AggregateRoot : Entity
{
    private readonly List<IDomainEvent> _domainEvents = [];

    public IReadOnlyCollection<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();

    protected void Raise(IDomainEvent domainEvent) => _domainEvents.Add(domainEvent);

    public void ClearDomainEvents() => _domainEvents.Clear();
}
```

`Raise` è `protected`: **un evento lo solleva solo l'aggregato che lo produce.**

## L'aggregato e il suo confine

La domanda più difficile del DDD tattico non è "che cos'è un aggregato", ma **dove finisce**.

`RentalContract` è la radice di un aggregato che comprende le proprie `RentalLine`. Il commento in
testa alla classe spiega il criterio:

> Dentro ci sono le righe, perché non hanno vita propria e i loro invarianti sono anche i suoi (il
> totale deve corrispondere alle righe, le righe non si toccano dopo la conferma). Fuori restano
> Customer ed Equipment, referenziati per id: sono radici autonome, con un ciclo di vita
> indipendente, e inglobarle significherebbe caricare mezzo database per aggiungere una riga.
>
> La regola pratica: un aggregato è l'unità che si carica e si salva INSIEME, perché i suoi pezzi
> devono essere coerenti fra loro nello stesso istante. Il totale e le righe sì; il contratto e
> l'anagrafica cliente no.

Nel codice il confine si vede da due dettagli:

```csharp
public int CustomerId { get; private set; }             // altro aggregato → solo l'id
public IReadOnlyList<RentalLine> Lines => _lines.AsReadOnly();   // dentro → ma in sola lettura
```

Niente navigation property verso `Customer`: **si referenzia per id ciò che sta oltre il confine.**
E le righe si espongono in sola lettura, perché si aggiungono solo con `AddLine`, che verifica lo
stato e mantiene coerente il totale.

### Le tre protezioni di ogni aggregato

```csharp
public class RentalContract : AggregateRoot, ITimestamped, IVersioned
{
    private readonly List<RentalLine> _lines = [];

    public string Reference { get; private set; } = string.Empty;   // 1. setter privati

    public IReadOnlyList<RentalLine> Lines => _lines.AsReadOnly();  // 2. collezioni in sola lettura

    private RentalContract() { }                                    // 3. costruttore per EF

    public static RentalContract Open(string reference, int customerId, RentalPeriod period, string? notes = null)
    {
        // … unica porta di costruzione, con le validazioni
    }
}
```

1. **Setter privati**: nessuno può portare l'entità in uno stato che gli invarianti non ammettono.
2. **Collezioni in sola lettura**: niente `Add` dall'esterno, che scavalcherebbe i controlli.
3. **Costruttore privato senza parametri per EF**, più un **factory method** che è l'unica porta
   pubblica di costruzione.

Le prime due sono verificate da `DomainModelTests`: violarle **fa fallire la build**. Le uniche
eccezioni ammesse sono `CreatedAt`/`UpdatedAt` e `ConcurrencyToken`, che il dominio non possiede e
che gli interceptor devono poter scrivere.

## Value object

Un valore con regole proprie diventa un tipo. `Money`, `RentalPeriod`, `AssetCode`, `TaxCode`,
`Username`, `Language`: ognuno rende **irrappresentabile** uno stato sbagliato.

`Money` tiene insieme importo e valuta:

> Un `decimal` nudo permette di sommare euro e dollari senza che nulla protesti, e di scrivere
> importi negativi dove non hanno senso. Qui la valuta viaggia con il numero e le operazioni fra
> valute diverse sono un errore esplicito: **il bug diventa impossibile da scrivere, invece che
> difficile da trovare.**

`RentalPeriod` è ancora più esplicito sul perché non bastano due `DateTime`:

> Con due campi sciolti su un'entità, "fine prima di inizio" è uno stato rappresentabile: qualcuno
> lo scriverà, e il bug si manifesterà lontano, in un totale sbagliato o in una disponibilità
> calcolata male. Tenendoli in un tipo con un solo costruttore validante, quello stato non esiste:
> `Days` è sempre positivo perché non c'è modo di costruire un periodo invertito.

La forma è sempre la stessa:

```csharp
public sealed record RentalPeriod        // record: uguaglianza strutturale
{
    public const int MaxDays = 365;

    public DateTime Start { get; }
    public DateTime End { get; }

    private RentalPeriod(DateTime start, DateTime end) { /* … */ }   // costruttore privato

    public static RentalPeriod From(DateTime start, DateTime end)    // unica porta, valida
    { /* … */ }

    /// <summary>True se le date formano un periodo valido. Per i validator, che non devono lanciare.</summary>
    public static bool IsValid(DateTime start, DateTime end) { /* … */ }

    public int Days => (End - Start).Days + 1;

    public bool Overlaps(RentalPeriod other) => Start <= other.End && other.Start <= End;
}
```

Quattro punti da ripetere in ogni value object:

- **`record`, non `class`**: l'uguaglianza è strutturale, ed è la definizione stessa di value object
  — due `Money` con stesso importo e valuta *sono* lo stesso valore.
- **Costruttore privato + `From()` che valida**: se hai il tipo, hai la garanzia.
- **`IsValid()` accanto a `From()`**: il validator interroga la stessa regola senza lanciare.
- **I comportamenti del valore stanno sul valore**: `Overlaps` è una proprietà degli intervalli, non
  del noleggio. Metterla qui è ciò che permette a `RentalAvailabilityService` di restare corto.

## Macchine a stati

Gli stati con transizioni non sono `enum`: sono record con la tabella delle transizioni ammesse
dentro il tipo. Così **la tabella è un dato, non una serie di `if` sparsi negli handler.**

```csharp
public sealed record RentalStatus
{
    public static readonly RentalStatus Draft = new("Draft");
    public static readonly RentalStatus Confirmed = new("Confirmed");
    public static readonly RentalStatus Closed = new("Closed");
    public static readonly RentalStatus Cancelled = new("Cancelled");

    private static readonly Dictionary<string, string[]> AllowedTransitions = new()
    {
        [Draft.Code] = [Confirmed.Code, Cancelled.Code],
        [Confirmed.Code] = [Closed.Code, Cancelled.Code],
        [Closed.Code] = [],       // terminale
        [Cancelled.Code] = [],    // terminale
    };

    public void EnsureCanTransitionTo(RentalStatus target) { /* lancia con i valori ammessi */ }

    public bool IsEditable => this == Draft;
    public bool IsCommitted => this == Confirmed;
    public bool IsFinal => this == Closed || this == Cancelled;
}
```

Le proprietà `IsEditable` / `IsCommitted` / `IsFinal` sono importanti quanto la tabella: danno un
**nome di dominio** alla condizione, e sono quelle che gli altri pezzi interrogano. Il controllo
disponibilità chiede `status.IsCommitted`, non `status == Confirmed`, e il giorno in cui si
aggiungesse uno stato "Sospeso" ci sarebbe un punto solo da rivedere.

Anche la distinzione fra stati simili è una scelta di dominio:

> La differenza fra Closed e Cancelled non è formale: un contratto CHIUSO si è svolto e va
> fatturato, uno ANNULLATO non è mai partito. Tenerli distinti evita di dover indovinare, guardando
> lo storico, se quel noleggio sia stato eseguito o no.

## Eventi di dominio

Un evento è un **fatto già avvenuto** — nome sempre al passato, `RentalContractConfirmed`, mai
`ConfirmRentalContract`. Serve quando un'operazione deve produrre effetti su **un altro aggregato**.

`RentalContract.Confirm()` deve anche portare le attrezzature in stato "Rented", ma non può farlo:

> Equipment è un altro aggregato, e modificarne uno dall'interno di un altro creerebbe esattamente
> l'accoppiamento che il confine di aggregato serve a impedire.

Quindi il contratto **dichiara il fatto** e lascia che chi ha il compito di reagire lo faccia:

```csharp
public void Confirm(DateTime now)
{
    Status.EnsureCanTransitionTo(RentalStatus.Confirmed);

    if (_lines.Count == 0)
        throw new InvariantViolationException("Non si può confermare un contratto senza attrezzature.");

    Status = RentalStatus.Confirmed;
    ConfirmedAt = now;

    Raise(new RentalContractConfirmed(
        Id, Reference, CustomerId, [.. _lines.Select(l => l.EquipmentId)], TotalAmount.Amount));
}
```

L'handler dell'evento vive in `AppDemo.Application/Rentals/EventHandlers/` ed è un normale
`INotificationHandler`:

```csharp
public sealed class RentalContractConfirmedHandler(
    IEquipmentRepository equipment,
    IUnitOfWork unitOfWork,
    ILogger<RentalContractConfirmedHandler> logger)
    : INotificationHandler<DomainEventNotification<RentalContractConfirmed>>
{
    public async Task Handle(
        DomainEventNotification<RentalContractConfirmed> notification, CancellationToken cancellationToken)
    {
        var pezzi = await equipment.GetByIdsAsync(notification.DomainEvent.EquipmentIds, cancellationToken);

        foreach (var pezzo in pezzi)
            pezzo.ChangeStatus(EquipmentStatus.Rented);

        await unitOfWork.SaveChangesAsync(cancellationToken);
    }
}
```

Il dominio non conosce MediatR: l'involucro `DomainEventNotification<T>` vive in `Application`, ed è
il punto di contatto fra un fatto di business e il messaggio di una libreria.

### La coerenza è eventuale, ed è una scelta

Fra la conferma del contratto e l'aggiornamento dei pezzi c'è un istante in cui il contratto è
confermato e le attrezzature risultano ancora disponibili. Il commento nell'handler spiega perché in
questo dominio va bene:

> Nessuno può prenotare nel frattempo, perché il controllo di disponibilità guarda i CONTRATTI, non
> lo stato del pezzo. Dove servisse coerenza immediata, i due dovrebbero stare nello stesso
> aggregato, con tutto il costo che comporta.

### Quando l'evento nasce senza id

Un factory come `Equipment.Register` solleva l'evento **mentre costruisce l'entità**, quando l'id
identity non esiste ancora e vale `0`. `IDeferredIdentityEvent` risolve il problema: dopo il commit,
`UnitOfWork` chiama `WithIdentity(id)` e ottiene una copia corretta dell'evento — sono `record`
immutabili, quindi "correggere" significa produrne uno nuovo.

```csharp
public sealed record RentalContractOpened(int ContractId, string Reference, int CustomerId)
    : IDeferredIdentityEvent
{
    public DateTime OccurredAt { get; } = DateTime.UtcNow;

    public IDomainEvent WithIdentity(int id) => this with { ContractId = id };
}
```

Serve solo alla **creazione**: gli eventi di aggiornamento nascono su entità già salvate.

Il resto della meccanica — perché gli eventi si raccolgono dopo il `SaveChanges` e si pubblicano
dopo il commit — è in [Comandi e query](comandi-e-query.md#gli-eventi-di-dominio-e-la-transazione).

## Specification

Un criterio di selezione con un nome, riusabile e componibile, espresso come `Expression` perché EF
possa tradurlo in SQL.

Il problema che risolve:

> "Un contratto è attivo se è confermato e non ancora chiuso" è una definizione di dominio. Scritta
> come `Where(c => c.Status == "Confirmed")` dentro un handler, finisce copiata in cinque query
> diverse; il giorno in cui si aggiunge uno stato "Sospeso" bisogna ricordarsi di tutte e cinque, e
> quella che sfugge diventa un bug silenzioso — non un errore, solo numeri leggermente sbagliati.

```csharp
public static class RentalContractSpecs
{
    public static Specification<RentalContract> Active =>
        new ExpressionSpecification<RentalContract>(c => c.Status == RentalStatus.Confirmed);

    public static Specification<RentalContract> ForCustomer(int customerId) =>
        new ExpressionSpecification<RentalContract>(c => c.CustomerId == customerId);

    /// <summary>Contratti attivi la cui data di fine è già passata.</summary>
    public static Specification<RentalContract> Overdue(DateTime today)
    {
        var reference = today.Date;
        return Active.And(new ExpressionSpecification<RentalContract>(c => c.Period.End < reference));
    }
}
```

Si usano come un normale predicato, e EF le traduce in SQL:

```csharp
if (request.OnlyOverdue == true)
    query = query.Where(RentalContractSpecs.Overdue(clock.UtcNow));
```

**Perché `Expression` e non `Func<T, bool>`.** Un `Func` è codice compilato: EF non può leggerlo,
quindi lo eseguirebbe in memoria dopo aver caricato l'intera tabella. Un'`Expression` è l'albero
sintattico del predicato, che EF sa tradurre in una `WHERE`. Su una tabella grande, la differenza è
fra una query e un disastro.

**Quando NON usarla.** Per un filtro una tantum di una schermata resta un normale `Where`
nell'handler: incapsulare tutto in specification produce solo indirezione senza guadagno. La
specification è per una regola di dominio **con un nome**, riusata o riusabile.

## Eccezioni di dominio

Il dominio lancia; il middleware traduce. Nessun handler cattura.

| Eccezione | HTTP | Quando |
|---|---|---|
| `InvariantViolationException` | 409 | Una regola dell'aggregato è violata: contratto vuoto, transizione illecita |
| `ConflictException` | 409 | Lo stato del sistema non permette l'operazione: attrezzatura occupata, fido insufficiente |
| `NotFoundException` | 404 | L'entità richiesta non esiste |
| `ValidationException` (FluentValidation) | 400 | La forma dell'input è sbagliata |
| `UnauthorizedException` / `ForbiddenException` | 401 / 403 | Accesso |

I messaggi sono scritti per essere **letti da chi usa l'applicazione**, con i numeri in chiaro:

```csharp
throw new ConflictException(
    $"Fido insufficiente per il cliente {customer.Name}: " +
    $"l'importo di {amount} supera il credito residuo di {available} " +
    $"(massimale {customer.CreditLimit}, esposizione attuale {CurrentExposure(contracts)}).");
```

Un "operazione non consentita" secco costringerebbe l'operatore a indovinare quale delle regole ha
incontrato.

## Testare il dominio

`AppDemo.Domain.Tests` non ha database, mock né contesto HTTP: gli oggetti si costruiscono e si
interrogano. È la verifica pratica che il dominio sia davvero puro — se un test ha bisogno di
infrastruttura, la regola sotto esame è nel posto sbagliato. Come sono fatti questi test, e quelli
degli handler e dell'architettura, è in [Testare il backend](../guide/test-backend.md).

## Da qui

- **[Dove mettere la logica](dove-mettere-la-logica.md)** — aggregato, domain service o handler
- **[Comandi e query](comandi-e-query.md)** — repository, unit of work, dispatch degli eventi
- **[Clean Architecture](clean-architecture.md)** — i layer e la regola delle dipendenze
