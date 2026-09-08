# Testare il backend

Il backend ha **tre progetti di test**, uno per layer, e ciascuno verifica una cosa diversa con
strumenti diversi. Questa pagina dice che cosa si testa dove, come sono fatti i test già presenti
nel template e come se ne scrive uno nuovo per una feature.

```bash
dotnet test apps/backend/<Progetto>.sln      # tutti e tre, è anche `pnpm test:backend`
```

| Progetto | Che cosa verifica | Con che cosa | Quando fallisce |
|---|---|---|---|
| `<Progetto>.Domain.Tests` | Invarianti di aggregati e value object | `new` e basta: nessun mock, nessun database | Una regola di business è sbagliata o aggirabile |
| `<Progetto>.Application.Tests` | Gli handler: orchestrazione, eccezioni, cosa viene salvato | NSubstitute sulle astrazioni (`IUserRepository`, `IUnitOfWork`, …) | Un handler salva due volte, non lancia il 404, non normalizza l'input |
| `<Progetto>.Architecture.Tests` | La direzione delle dipendenze e le convenzioni del modello | Reflection sugli assembly compilati | Un `using` sbagliato, un setter pubblico, una `List<T>` esposta |

Tutti e tre usano **xUnit**; i nomi dei test sono frasi in italiano con gli underscore
(`Rifiuta_un_username_gia_in_uso`), così l'output di `dotnet test` si legge come una specifica.

> **Non c'è un progetto di test di integrazione con il database.** È una scelta: il dominio si
> testa senza infrastruttura, gli handler con i sostituti delle astrazioni, e l'infrastruttura EF è
> coperta dalle migration che si applicano all'avvio. `Program` è comunque `public partial`, quindi
> `WebApplicationFactory<Program>` è pronta se un progetto ne avrà bisogno.

## Domain.Tests: il dominio si testa con `new`

Un test di dominio costruisce un oggetto tramite il suo factory, chiama un metodo e controlla lo
stato o l'eccezione. Nient'altro. Se per scrivere un test serve un mock, la regola sotto esame è
nel posto sbagliato.

```csharp
public class UserTests
{
    private static User CreateUser(string passwordHash = "hash-bcrypt") =>
        User.Create(Username.From("mario.rossi"), email: "Mario.Rossi@Azienda.IT",
            displayName: "Mario Rossi", passwordHash: passwordHash, language: Language.Italian);

    [Fact]
    public void Create_normalizza_la_email_in_minuscolo()
    {
        Assert.Equal("mario.rossi@azienda.it", CreateUser().Email);
    }

    [Fact]
    public void ChangePassword_rifiuta_un_utente_senza_password_locale()
    {
        // Utenti MSAL/Windows: le credenziali stanno nell'identity provider.
        var msalUser = CreateUser(passwordHash: "");

        var ex = Assert.Throws<InvariantViolationException>(() => msalUser.ChangePassword("nuovo-hash"));
        Assert.Contains("Azure AD", ex.Message);
    }

    [Fact]
    public void Le_collezioni_non_sono_modificabili_dall_esterno()
    {
        var user = CreateUser();
        var comeCollection = (ICollection<Role>)user.Roles;

        Assert.True(comeCollection.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => comeCollection.Add(Role.Create("Intruso", "")));
    }
}
```

**Che cosa vale la pena testare** in un aggregato:

- il factory: normalizzazioni (trim, lowercase), valori di default, stato iniziale;
- ogni metodo che cambia stato: il caso ammesso e quello rifiutato, con **l'eccezione giusta**
  (`InvariantViolationException` per uno stato incompatibile, `ConflictException` per un
  duplicato, e così via — vedi [Il dominio](../architettura/il-dominio.md#eccezioni-di-dominio));
- le collezioni: che `Assign*` sostituisca invece di accumulare, e che dall'esterno non si possa
  scrivere;
- i value object: `From()` che valida e normalizza, uguaglianza strutturale, il caso `null`
  (`UsernameTests`, `LanguageTests`);
- le macchine a stati: ogni transizione ammessa e almeno una vietata per stato.

Il test **non** verifica: la persistenza, i timestamp (`CreatedAt`/`UpdatedAt` li scrive
l'interceptor), l'audit.

## Application.Tests: gli handler con i sostituti

Un handler dipende solo da astrazioni dichiarate in `Application/Abstractions`. Il test le
sostituisce con **NSubstitute** e verifica tre cose: che cosa l'handler restituisce, quale
eccezione lancia, e **che cosa ha chiesto** alle dipendenze.

```csharp
public class CreateUserHandlerTests
{
    private readonly IUserRepository _users = Substitute.For<IUserRepository>();
    private readonly IRoleRepository _roles = Substitute.For<IRoleRepository>();
    private readonly IGroupRepository _groups = Substitute.For<IGroupRepository>();
    private readonly IPasswordHasher _hasher = Substitute.For<IPasswordHasher>();
    private readonly IUnitOfWork _unitOfWork = Substitute.For<IUnitOfWork>();

    private readonly CreateUserHandler _handler;

    public CreateUserHandlerTests()
    {
        // Default "neutri" nel costruttore: ogni test sovrascrive solo ciò che gli serve
        _hasher.Hash(Arg.Any<string>()).Returns(call => $"hashed:{call.Arg<string>()}");
        _roles.GetByIdsAsync(Arg.Any<IEnumerable<int>>(), Arg.Any<CancellationToken>()).Returns([]);
        _groups.GetByIdsAsync(Arg.Any<IEnumerable<int>>(), Arg.Any<CancellationToken>()).Returns([]);

        _handler = new CreateUserHandler(_users, _roles, _groups, _hasher, _unitOfWork);
    }

    private static CreateUserCommand Command(string username = "Mario.Rossi") =>
        new(username, "mario@azienda.it", "Mario Rossi", "Password1", "it", null, null);

    [Fact]
    public async Task Rifiuta_un_username_gia_in_uso()
    {
        _users.ExistsAsync(Arg.Any<Username>(), Arg.Any<int?>(), Arg.Any<CancellationToken>()).Returns(true);

        await Assert.ThrowsAsync<ConflictException>(() => _handler.Handle(Command(), CancellationToken.None));

        // Nulla dev'essere salvato quando l'username è duplicato.
        await _unitOfWork.DidNotReceive().SaveChangesAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Salva_una_sola_volta()
    {
        // L'audit lo scrive l'interceptor: la transazione è una sola.
        await _handler.Handle(Command(), CancellationToken.None);

        await _unitOfWork.Received(1).SaveChangesAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Crea_l_utente_con_username_normalizzato()
    {
        // Catturare ciò che l'handler passa al repository: è l'entità che verrà salvata
        User? added = null;
        _users.When(u => u.Add(Arg.Any<User>())).Do(call => added = call.Arg<User>());

        var response = await _handler.Handle(Command("  Mario.ROSSI  "), CancellationToken.None);

        Assert.Equal("mario.rossi", added!.Username.Value);
        Assert.Equal("mario.rossi", response.Username);
    }
}
```

I tre schemi che ricorrono in ogni test di handler:

| Schema | Codice | Serve a |
|---|---|---|
| Preparare una risposta | `_users.GetByIdAsync(1, Arg.Any<CancellationToken>()).Returns(user)` | far trovare (o non trovare) un'entità |
| Catturare un argomento | `_users.When(u => u.Add(Arg.Any<User>())).Do(call => added = call.Arg<User>())` | ispezionare l'entità costruita dall'handler |
| Verificare una chiamata | `await _unitOfWork.Received(1).SaveChangesAsync(...)` · `DidNotReceive()` | controllare che si salvi una volta sola, o mai in caso di errore |

**Il canone di un handler di comando**, in quattro test:

1. il caso felice: risposta corretta e `SaveChangesAsync` chiamato **una** volta;
2. `NotFoundException` quando il repository restituisce `null`;
3. `ConflictException` (o l'invariante) quando la regola lo richiede, e **nessun salvataggio**;
4. la traduzione input → dominio: username normalizzato, password mai in chiaro, ruoli assegnati.

Un handler che non si riesce a testare così — perché vuole `AppDbContext`, `IHttpContextAccessor`
o `IConfiguration` — è un handler scritto male, e i test di architettura lo intercettano prima.

### Le query

Le query usano `IReadDbContext` e `IQueryExecutor`, entrambi sostituibili: `IReadDbContext` con
un oggetto che espone `IQueryable` in memoria (`new[] { … }.AsQueryable()`), `IQueryExecutor` con
un'implementazione che chiama `ToList()` e `Count()` sincroni. `GetDatabaseStatsHandlerTests` è
l'esempio nel template. È il motivo per cui l'handler non chiama `ToListAsync` direttamente: sul
`IQueryable` in memoria fallirebbe.

## Architecture.Tests: le regole che fanno fallire la build

Sono i test che non riguardano una feature ma tutte: leggono gli **assembly compilati** e
verificano che nessuno abbia rotto le convenzioni. Falliscono per un `using`, non per un bug.

| Test | Che cosa impedisce |
|---|---|
| `Il_dominio_non_dipende_da_nessun_altro_layer` · `…da_alcun_framework` | Un riferimento a EF Core, ASP.NET, MediatR o FluentValidation dentro `Domain` |
| `L_application_layer_non_dipende_da_infrastructure_ne_dall_api` · `…da_ASP_NET` | L'inversione delle dipendenze rovesciata; `HttpContext` in un handler |
| `L_application_layer_non_dipende_da_un_provider_di_database_specifico` | `Microsoft.EntityFrameworkCore.SqlServer` o `Npgsql` in `Application` (l'assembly base di EF è ammesso) |
| `Infrastructure_non_dipende_dall_api` | Il composition root usato come libreria |
| `Le_entita_non_espongono_setter_pubblici` | Un setter pubblico su un'entità: le uniche eccezioni sono `CreatedAt`, `UpdatedAt` e `ConcurrencyToken`, che scrive l'infrastruttura |
| `Le_entita_non_espongono_collezioni_mutabili` | `List<T>`, `ICollection<T>`, `IList<T>`, `HashSet<T>` esposte da un'entità: devono essere `IReadOnlyList<T>` |
| `Le_entita_hanno_un_costruttore_senza_parametri_per_EF` | Un'entità che EF non può materializzare |

Non si modificano quando si aggiunge una feature: si modificano quando si cambia **una regola del
progetto**, ed è raro. Se un test di architettura fallisce, la risposta giusta è quasi sempre
spostare il codice, non allargare l'eccezione.

## Scrivere i test di una feature nuova

Per un'entità `Category` con le sue slice, i test da aggiungere sono:

```
tests/
├── <Progetto>.Domain.Tests/Catalog/CategoryTests.cs            # factory, Update, invarianti
└── <Progetto>.Application.Tests/Categories/
    ├── CreateCategoryHandlerTests.cs                             # felice, duplicato, salva una volta
    ├── UpdateCategoryHandlerTests.cs                             # felice, 404
    └── DeleteCategoryHandlerTests.cs                             # felice, 404, 409 se referenziata
```

Le cartelle rispecchiano quelle del codice (`Domain/Catalog` → `Domain.Tests/Catalog`). Non serve
registrare nulla: xUnit scopre le classi da solo.

Un handler di dominio con un domain service si testa allo stesso modo — il domain service è
statico e puro, quindi il test dell'handler verifica che venga chiamato con i dati caricati, e il
domain service ha i **suoi** test nel progetto Domain, senza mock.

## Che cosa non testare

- **Il mapping EF** (configuration, migration): lo verifica l'avvio dell'applicazione, e un test
  con un database in memoria non replicherebbe le differenze fra i due provider.
- **Gli interceptor** in isolamento: audit e timestamp sono già coperti dal fatto che ogni
  salvataggio li attraversa; se serve un test, va fatto con un database vero.
- **I validator FluentValidation** riga per riga: un test per regola non banale (formato, range)
  basta; `NotEmpty()` non ha bisogno di un test.
- **Gli endpoint**: contengono solo routing. Se contengono altro, quello è il problema.

## Da qui

- [Clean Architecture](../architettura/clean-architecture.md) — perché i layer sono testabili in isolamento
- [Il dominio](../architettura/il-dominio.md) — gli invarianti che i test di dominio fissano
- [Comandi e query](../architettura/comandi-e-query.md) — le astrazioni che i test di handler sostituiscono
- [Convenzioni e flussi del frontend](../frontend/convenzioni.md#test) — i test dall'altra parte
