# Dove mettere la logica

È la domanda che ci si pone ogni volta che si scrive una regola nuova, e quella su cui la Clean
Architecture si rompe più spesso. Una regola messa nel posto sbagliato **non produce un errore**:
funziona, finché qualcuno non arriva da un'altra strada — un import, una nuova API, un'operazione
massiva — e la salta senza accorgersene.

## La domanda che decide: quali dati servono per rispondere?

Non "che cosa fa questa regola", ma **di che cosa ha bisogno per rispondere**. Quasi tutti i casi si
risolvono con questa tabella:

| La regola ha bisogno di… | Dove vive | Esempio reale |
|---|---|---|
| solo i dati dell'entità | metodo sull'**aggregato** | "un contratto confermato non accetta righe" |
| solo un valore e le sue regole | **value object** | "una P.IVA ha una cifra di controllo valida" |
| **più aggregati** insieme | **domain service** | "questa attrezzatura è libera in queste date?" |
| il **database** | **handler** (carica, poi delega) | "esiste già un contratto con questo numero?" |
| la **forma** dell'input | **validator** | "il codice rispetta il formato `AAA-0000`" |
| un **servizio esterno** | **astrazione** in `Application` + adapter in `Infrastructure` | "firma questo JWT", "chi è l'utente della richiesta" |

Il resto di questa pagina è il ragionamento dietro ogni riga, con il codice del progetto.

## L'aggregato: la regola che riguarda solo sé stesso

> **Da dove vengono gli esempi.** Il template non porta un dominio applicativo. Gli esempi con
> `RentalContract`, `Customer` ed `Equipment` vengono dalla sezione Noleggi di `app-demo`, il
> progetto dimostrativo generato dal template: la forma è quella da imitare, il codice non è nel
> template.

Se per applicare la regola bastano i dati che l'entità già possiede, la regola è sua. Metterla
altrove significa che qualcuno potrà costruire un oggetto in uno stato che non dovrebbe esistere.

`RentalContract.AddLine` è tutto logica di dominio, e non tocca nulla fuori da sé:

```csharp
public RentalLine AddLine(Equipment equipment, decimal discountPercent = 0m)
{
    EnsureEditable("Non si possono aggiungere righe a un contratto non più in bozza.");

    if (_lines.Count >= MaxLines)
        throw new InvariantViolationException($"Un contratto non può superare {MaxLines} righe.");

    if (_lines.Any(l => l.EquipmentCode == equipment.Code.Value))
        throw new ConflictException($"L'attrezzatura {equipment.Code} è già presente nel contratto.");

    // Lo stato del pezzo lo verifica l'aggregato Equipment: la regola è sua.
    equipment.EnsureBookable();

    var line = RentalLine.For(equipment, Period.Days, discountPercent);
    _lines.Add(line);

    return line;
}
```

Da notare l'ultima riga di commento: *"lo stato del pezzo lo verifica l'aggregato Equipment: la
regola è sua"*. Il contratto non chiede `if (equipment.Status == ...)`: chiede al pezzo di
verificarsi. Ogni aggregato risponde delle proprie regole.

L'invariante più istruttivo è il totale:

```csharp
public Money TotalAmount => _lines.Count == 0
    ? Money.Zero
    : _lines.Aggregate(Money.Zero, (total, line) => total.Add(line.LineTotal));
```

Non è un campo che qualcuno possa impostare, ed è la ragione per cui **non può esistere** un
contratto il cui totale non corrisponda al suo contenuto. Se fosse un campo salvato, `Reschedule()`
lascerebbe un importo riferito alla durata precedente e nessuno se ne accorgerebbe fino alla
fattura.

## Il domain service: la regola che attraversa più aggregati

Quando servono dati che stanno in *altri* aggregati, la regola non appartiene a nessuno dei due.

Il caso da tenere a mente è la disponibilità. Sembrerebbe naturale scrivere
`equipment.IsAvailable(period)`, ma il commento in `RentalAvailabilityService` spiega perché non si
può:

> Per sapere se il muletto TRP-0142 è libero dal 10 al 15, non basta guardare il muletto: bisogna
> guardare TUTTI i contratti che lo impegnano e verificare che nessuno si sovrapponga a quelle
> date. Un metodo `Equipment.IsAvailable(period)` sarebbe costretto a interrogare il database — e
> un'entità che interroga il database non è più un oggetto di dominio, è un servizio travestito,
> impossibile da testare senza infrastruttura.

Lo stesso vale per il fido in `CustomerCreditService`: `customer.CanAfford(importo)` costringerebbe
`Customer` a tenersi la lista dei contratti (facendo crescere l'aggregato senza limite) oppure a
interrogare il database dal dominio.

**La caratteristica decisiva dei domain service del progetto: non hanno dipendenze.** Ricevono i
dati già caricati, non un repository.

```csharp
public static class RentalAvailabilityService
{
    public static void EnsureAvailable(
        Equipment equipment,
        RentalPeriod period,
        IEnumerable<RentalContract> existingContracts,   // ← già caricati dal chiamante
        int? excludingContractId = null)
```

Così restano nel progetto `Domain`, che non conosce la persistenza, e si testano con tre oggetti in
memoria. **Il compito di andare a prendere i dati è dell'handler, che ha il repository.**

### Perché non basta metterlo nell'handler

È l'obiezione più ragionevole: il controllo serve alla conferma, tanto vale scriverlo in
`ConfirmRentalContractHandler`. Il commento nel codice risponde:

> La regola "un pezzo non si noleggia due volte nello stesso giorno" non appartiene a
> quell'operazione: vale anche quando si aggiunge una riga, quando si spostano le date, e varrà per
> l'import massivo che qualcuno scriverà l'anno prossimo. Scritta qui è una sola, e nessuna di
> quelle strade può aggirarla per dimenticanza.

La regola pratica: **se la regola vale per più di un'operazione, non appartiene a nessuna di esse.**

## L'handler: orchestrazione, non decisioni

L'handler è l'unico che può parlare col database. Il suo lavoro è in tre tempi: **carica ciò che
serve → chiedi al dominio di decidere → salva**. Le decisioni non le prende lui.

`ConfirmRentalContractHandler` è l'esempio più completo, perché compone verifiche che vivono in
posti diversi:

```csharp
public class ConfirmRentalContractHandler(
    IRentalContractRepository contracts,
    ICustomerRepository customers,
    IEquipmentRepository equipment,
    IDateTimeProvider clock,
    IUnitOfWork unitOfWork) : IRequestHandler<ConfirmRentalContractCommand, ConfirmRentalContractResponse>
{
    public async Task<ConfirmRentalContractResponse> Handle(
        ConfirmRentalContractCommand request, CancellationToken cancellationToken)
    {
        var contract = await contracts.GetByIdAsync(request.Id, cancellationToken)
            ?? throw new NotFoundException($"Contratto con id {request.Id} non trovato.");

        var customer = await customers.GetByIdAsync(contract.CustomerId, cancellationToken)
            ?? throw new NotFoundException($"Cliente con id {contract.CustomerId} non trovato.");

        var equipmentIds = contract.Lines.Select(l => l.EquipmentId).ToList();

        // 1. Disponibilità: l'handler CARICA, il domain service DECIDE.
        if (equipmentIds.Count > 0)
        {
            var overlapping = await contracts.GetOverlappingAsync(
                equipmentIds, contract.Period, contract.Id, cancellationToken);

            var items = await equipment.GetByIdsAsync(equipmentIds, cancellationToken);

            foreach (var item in items)
                RentalAvailabilityService.EnsureAvailable(
                    item, contract.Period, overlapping, contract.Id);
        }

        // 2. Fido: stessa divisione dei compiti.
        var active = await contracts.GetActiveByCustomerAsync(customer.Id, cancellationToken);
        CustomerCreditService.EnsureCanCommit(customer, contract.TotalAmount, active);

        // 3. Invarianti del contratto + evento verso le attrezzature.
        contract.Confirm(clock.UtcNow);

        await unitOfWork.SaveChangesAsync(cancellationToken);

        return new ConfirmRentalContractResponse(/* … */);
    }
}
```

Si legge la divisione dei compiti riga per riga: l'handler fa `await …GetOverlappingAsync(...)`
(andare a prendere i dati) e poi `RentalAvailabilityService.EnsureAvailable(...)` (decidere). Se un
giorno la regola di disponibilità cambia, questo file non si tocca.

Nota anche il punto 1: la disponibilità viene **ricontrollata alla conferma**, anche se era già
stata verificata all'inserimento delle righe. Fra la bozza e la conferma può essere passato un
giorno, e un altro operatore può aver confermato un contratto sugli stessi pezzi.

### Che cosa può stare legittimamente in un handler

- **L'unicità**, perché richiede il database: `if (await contracts.ExistsByReferenceAsync(...))`.
- **La traduzione input → oggetti di dominio**: `RentalPeriod.From(cmd.Start, cmd.End)`.
- **La sequenza delle operazioni** e la composizione della response.
- **Le regole banali che riguardano una sola operazione** e nessun invariante — un CRUD anagrafico
  senza logica non ha bisogno di un domain service per esistere.

## Application service: perché nel progetto non ce ne sono (quasi)

In molti progetti Clean Architecture compare un livello `ApplicationService` fra handler e dominio.
**Qui quel ruolo lo svolge l'handler stesso**: MediatR dà già una classe per caso d'uso, con la
propria DI e il proprio confine transazionale. Aggiungere un service che l'handler si limiterebbe a
chiamare sarebbe indirezione senza guadagno.

Quello che in altre codebase si chiamerebbe "application service" qui vive in `Abstractions/`, come
**interfaccia dichiarata da Application e implementata da Infrastructure**. La distinzione conta:

| | **Domain service** | **Servizio applicativo** (astrazione + adapter) |
|---|---|---|
| **Dove** | `AppDemo.Domain` | interfaccia in `Application/Abstractions`, classe in `Infrastructure` |
| **Che cosa contiene** | una regola di business che attraversa aggregati | una capacità tecnica |
| **Dipendenze** | nessuna: riceve dati già caricati | quelle che servono (EF, ASP.NET, librerie) |
| **Cambia se…** | cambiano le regole commerciali | cambia la tecnologia |
| **Si testa** | istanziando oggetti | sostituendolo con un fake |
| **Esempi** | `RentalAvailabilityService`, `CustomerCreditService`, `RentalPricingService` | `ICurrentUser`, `IDateTimeProvider`, `ITokenService`, `IPasswordHasher`, `IPermissionResolver` |

La prova del nove: **un domain service parlerebbe di noleggi anche se il progetto fosse un
programma da riga di comando senza database.** `RentalPricingService` calcola sconti su durata e
fedeltà: è una regola commerciale, e resterebbe identica. `ITokenService` firma JWT: sparirebbe.

### Un esempio di adapter: `ICurrentUser`

Serve sapere chi sta agendo, per l'audit. Ma leggere i claim significa `HttpContext`, cioè ASP.NET,
che in Application è vietato. La soluzione è l'inversione:

```csharp
// AppDemo.Application/Abstractions/Identity/ICurrentUser.cs — l'handler dipende da questo
public interface ICurrentUser
{
    int Id { get; }
    string Email { get; }
    string? IpAddress { get; }
    bool IsAuthenticated { get; }
}
```

```csharp
// AppDemo.Infrastructure/Identity/CurrentUser.cs — l'adapter
public sealed class CurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public int Id => int.TryParse(User?.FindFirstValue(ClaimTypes.NameIdentifier), out var id) ? id : 0;
    public string Email => User?.FindFirstValue(ClaimTypes.Email) ?? "system";
    // …
}
```

Il commento nel file spiega il guadagno concreto:

> È l'adapter che tiene ASP.NET fuori dall'Application layer: prima ogni handler di scrittura
> riceveva `IHttpContextAccessor` e ne estraeva i claim a mano, il che li rendeva impossibili da
> testare senza costruire un `HttpContext` finto.

Stesso ragionamento per `IDateTimeProvider`: un handler che chiama `DateTime.UtcNow` non è testabile
in modo deterministico. Iniettando l'orologio, un test può fissare "adesso".

## Il validator: la forma, non le regole

`FluentValidation` gira nel `ValidationBehavior` **prima** dell'handler. Il criterio è netto:

- **Nel validator**: ciò che si giudica guardando solo l'input — obbligatorietà, lunghezze,
  formati, range. Produce `400`.
- **Nel dominio**: ciò che riguarda lo stato del sistema — invarianti, transizioni, unicità.
  Produce `409` o `422`.

I due si sovrappongono di proposito su alcune cose, e va bene: il validator dà un messaggio
gentile su tutti i campi in una volta, il dominio garantisce che la regola non sia aggirabile da
un'altra strada. Per questo i value object espongono `IsValid()` accanto a `From()` — così il
validator può interrogare la stessa regola senza lanciare eccezioni.

## Come si riconosce una regola nel posto sbagliato

| Sintomo | Che cosa significa | Rimedio |
|---|---|---|
| L'entità ha bisogno di un repository | La regola guarda altri aggregati | Domain service |
| L'handler contiene `if` su regole di business | Il dominio è anemico: gli invarianti sono aggirabili | Sposta il metodo sull'aggregato |
| Lo stesso `Where(...)` in cinque query | È una definizione di dominio senza nome | Specification |
| L'handler modifica due aggregati diversi | Coerenza forzata fra confini | Evento di dominio |
| Il domain service inietta qualcosa | Non è più di dominio | Fai passare i dati dal chiamante |
| `DateTime.UtcNow` in un handler | Non è testabile | `IDateTimeProvider` |

## In pratica: cinque secondi prima di scrivere

1. **Basta l'entità?** → metodo sull'aggregato.
2. **È solo un valore con regole?** → value object.
3. **Servono altri aggregati?** → domain service, con i dati passati dall'handler.
4. **Serve il database?** → l'handler carica, poi delega ai punti sopra.
5. **Serve una tecnologia?** → interfaccia in `Application/Abstractions`, adapter in `Infrastructure`.

Nel dubbio fra aggregato e domain service, **prova a scrivere il metodo sull'aggregato**: se ti
accorgi che gli servirebbe un parametro con "tutti gli altri X", è un domain service.

## Da qui

- **[Il dominio](il-dominio.md)** — aggregati, value object, eventi, specification
- **[Comandi e query](comandi-e-query.md)** — perché le scritture usano i repository e le letture no
- **[Clean Architecture](clean-architecture.md)** — i layer e la regola delle dipendenze
