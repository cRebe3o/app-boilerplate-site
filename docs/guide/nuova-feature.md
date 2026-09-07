# Aggiungere una feature

Il percorso completo per portare una nuova entità dal database fino alla pagina, attraversando tutti
i punti in cui il progetto chiede qualcosa di specifico.

È l'operazione più frequente in un progetto generato: il template porta l'impianto, il dominio lo
aggiungi tu, e lo aggiungi sempre così.

**L'esempio è un'entità `Category`**: una lookup piatta — descrizione italiana, descrizione inglese,
ordinamento — cioè il caso più semplice e il più facile da adattare. Non esiste nel template: è il
tipo di entità che il tuo progetto aggiungerà per primo. Le feature già presenti (`Groups`, `Roles`,
`Users`) seguono esattamente questa forma e si possono aprire per confronto.

> **Scorciatoia.** Le [skill Claude](../progetto/skill.md) incluse nel progetto scaffoldano tutti i
> passaggi che seguono — `db-entity` per l'entità e le migration, `vertical-slice-backend` per le
> slice, `vue-feature` per il frontend, o `/new-feature Category` per l'intero giro. Questa pagina
> descrive *che cosa* producono e perché, che è ciò che serve per rivederne l'output.

## La regola che governa tutto

> **Una modifica al modello richiede due migration, una per provider.** L'applicazione gira su
> SQL Server **o** PostgreSQL: se la migration di uno dei due manca, su quel provider lo schema
> resta indietro e l'applicazione fallisce alla prima query sulla tabella nuova.

L'altra faccia della stessa regola: **ogni query LINQ deve essere traducibile da entrambi i
provider**. Il caso concreto da ricordare è `Contains` su stringa, case-insensitive su SQL Server e
case-sensitive su PostgreSQL.

## La mappa

| # | File | Che cos'è |
|---|---|---|
| 1 | `<Progetto>.Domain/Catalog/Category.cs` | L'entità di dominio |
| 2 | `<Progetto>.Infrastructure/Persistence/Configurations/CategoryConfiguration.cs` | La mappatura: tabella, colonne, indici |
| 3 | `Persistence/Migrations/SqlServer/` + `.../Postgres/` | **Due** migration |
| 4 | `<Progetto>.Application/Abstractions/Persistence/ICategoryRepository.cs` + implementazione | L'accesso in scrittura |
| 5 | `<Progetto>.Application/Categories/GetCategories/` | La query |
| 6 | `<Progetto>.Application/Categories/CreateCategory/` | Il comando, con validazione |
| 7 | `<Progetto>.Application/Categories/UpdateCategory/`, `DeleteCategory/` | Modifica e cancellazione |
| 8 | `<Progetto>.Api/Endpoints/CategoryEndpoints.cs` + `Extensions/EndpointExtensions.cs` | Le rotte |
| 9 | `Infrastructure/Persistence/Seed/DataSeeder.cs` | I permessi |
| 10-12 | `types/api.types.ts` → `services/` → `stores/` → `pages/` → `router/`, `locales/` | Il frontend |

L'ordine non è casuale: si va **dal centro verso l'esterno**, come le dipendenze. Prima il dominio,
che non dipende da niente; per ultimo il guscio HTTP, che dipende da tutto.

---

# Backend

## 1. L'entità di dominio

`Category` è una lookup piatta: non ha invarianti complessi, quindi resta semplice. Ma **la forma è
quella di ogni aggregato**, perché è ciò che rende impossibile costruirla in uno stato sbagliato.

```csharp
// <Progetto>.Domain/Catalog/Category.cs
public class Category : AggregateRoot, ITimestamped
{
    public const int MaxDescriptionLength = 256;

    public string DescIt { get; private set; } = string.Empty;
    public string DescEn { get; private set; } = string.Empty;
    public int Order { get; private set; }

    // Li scrive TimestampInterceptor: il tempo non è un dato di dominio.
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    /// <summary>Costruttore per EF Core. Non usarlo nel codice applicativo.</summary>
    private Category() { }

    /// <summary>Unica porta di costruzione: se hai l'oggetto, i valori sono validi.</summary>
    public static Category Create(string descIt, string descEn, int order) =>
        new()
        {
            DescIt = EnsureDescription(descIt, nameof(descIt)),
            DescEn = EnsureDescription(descEn, nameof(descEn)),
            Order = order,
        };

    public void Update(string descIt, string descEn, int order)
    {
        DescIt = EnsureDescription(descIt, nameof(descIt));
        DescEn = EnsureDescription(descEn, nameof(descEn));
        Order = order;
    }

    private static string EnsureDescription(string value, string field)
    {
        var trimmed = (value ?? string.Empty).Trim();

        if (trimmed.Length == 0)
            throw new InvariantViolationException($"La descrizione ({field}) è obbligatoria.");
        if (trimmed.Length > MaxDescriptionLength)
            throw new InvariantViolationException(
                $"Descrizione troppo lunga (max {MaxDescriptionLength} caratteri).");

        return trimmed;
    }
}
```

Le regole, tutte non negoziabili:

- **Estende `AggregateRoot`** (o `Entity` se non è una radice): `Id` arriva da lì, `int` identity,
  con setter `protected`.
- **Setter privati** e **factory method** come unica porta di costruzione. I test di architettura
  fanno fallire la build se trovano un setter pubblico.
- **Costruttore privato senza parametri** per EF, che materializza senza passare dal factory.
- **`ITimestamped`** se ha `CreatedAt`/`UpdatedAt`: sono le uniche proprietà con setter pubblico
  ammesse, perché le scrive `TimestampInterceptor`.
- **Nessun attributo di persistenza**, nessun `using` di EF Core: il dominio non sa che esiste un
  database.

> **Quanta logica mettere qui?** Per una lookup, questa. Se l'entità avesse regole vere — stati con
> transizioni, valori con formati, regole che attraversano altre entità — il posto giusto per
> ciascuna è descritto in [Dove mettere la logica](../architettura/dove-mettere-la-logica.md).

## 2. La tabella

La mappatura non sta più in un `OnModelCreating` centrale: ogni entità ha la propria
configuration, raccolta automaticamente.

```csharp
// <Progetto>.Infrastructure/Persistence/Configurations/CategoryConfiguration.cs
public class CategoryConfiguration : IEntityTypeConfiguration<Category>
{
    public void Configure(EntityTypeBuilder<Category> e)
    {
        e.ToTable("Categories");

        e.Property(x => x.DescIt).HasMaxLength(Category.MaxDescriptionLength).IsRequired();
        e.Property(x => x.DescEn).HasMaxLength(Category.MaxDescriptionLength).IsRequired();

        e.HasIndex(x => x.Order);
    }
}
```

Non c'è nessun file da toccare per registrarla: `ApplyConfigurationsFromAssembly` la trova da sé.
`HasKey` non serve — EF riconosce `Id` per convenzione e lo rende identity su entrambi i provider.

**Ogni colonna stringa va dimensionata.** Senza `HasMaxLength` EF genera `nvarchar(max)` (SQL Server)
o `text` (Postgres): pessimo per indici e storage, e su SQL Server un indice unique non è nemmeno
ammesso su `nvarchar(max)`.

Le lunghezze si prendono dalle costanti del dominio (`Category.MaxDescriptionLength`), così il
vincolo del database e quello dell'aggregato non possono divergere.

Se l'entità avesse una **FK** verso un'altra, andrebbe dichiarata con `Restrict`, mai `Cascade`:

```csharp
e.HasOne<Parent>().WithMany().HasForeignKey(x => x.ParentId)
    .OnDelete(DeleteBehavior.Restrict);
```

`Cascade` qui sarebbe pericoloso: cancellare una categoria cancellerebbe tutto ciò che la usa.

> **I value object** si mappano con `OwnsOne` (per i tipi composti come `RentalPeriod` o `Money`) o
> con una conversione (per quelli che avvolgono un solo valore, come `Username` o `AssetCode`).
> Le configuration della sezione Noleggi sono l'esempio da guardare.

## 3. Le due migration

```bash
cd apps/backend/<Progetto>.Api

dotnet dotnet-ef migrations add AddCategories \
  --project ../<Progetto>.Infrastructure/<Progetto>.Infrastructure.csproj \
  --startup-project <Progetto>.Api.csproj \
  --context SqlServerAppDbContext --output-dir Persistence/Migrations/SqlServer

dotnet dotnet-ef migrations add AddCategories \
  --project ../<Progetto>.Infrastructure/<Progetto>.Infrastructure.csproj \
  --startup-project <Progetto>.Api.csproj \
  --context PostgresAppDbContext  --output-dir Persistence/Migrations/Postgres
```

Le migration vivono in `<Progetto>.Infrastructure`, ma il comando ha bisogno di `<Progetto>.Api`
come startup project: è lì la configurazione. Il `--context` seleziona quale delle due derivate
usare, e quindi in quale cartella finisce la migration. Si applicano da sole all'avvio
(`MigrateAsync`).

> **Mai modificare una migration già committata**: una correzione è una migration nuova.

## 4. Il repository

I **comandi** non vedono EF Core: passano da un repository, dichiarato in `Application` e
implementato in `Infrastructure`. Le **query** non ne hanno bisogno — usano `IReadDbContext`.

```csharp
// <Progetto>.Application/Abstractions/Persistence/ICategoryRepository.cs
public interface ICategoryRepository
{
    Task<Category?> GetByIdAsync(int id, CancellationToken ct = default);
    Task<bool> ExistsByDescriptionAsync(string descIt, int? excludingId = null, CancellationToken ct = default);

    void Add(Category category);
    void Remove(Category category);
}
```

```csharp
// <Progetto>.Infrastructure/Persistence/Repositories/CategoryRepository.cs
public sealed class CategoryRepository(AppDbContext db, AuditSnapshotTracker tracker) : ICategoryRepository
{
    public async Task<Category?> GetByIdAsync(int id, CancellationToken ct = default)
    {
        var category = await db.Set<Category>().FirstOrDefaultAsync(x => x.Id == id, ct);
        tracker.Capture(category);   // snapshot "Before" per l'audit
        return category;
    }

    public Task<bool> ExistsByDescriptionAsync(string descIt, int? excludingId = null, CancellationToken ct = default) =>
        db.Set<Category>().AnyAsync(x => x.DescIt == descIt && x.Id != excludingId, ct);

    public void Add(Category category) => db.Add(category);
    public void Remove(Category category) => db.Remove(category);
}
```

Poi la registrazione, in `Infrastructure/DependencyInjection.cs`:

```csharp
services.AddScoped<ICategoryRepository, CategoryRepository>();
```

Due punti che contano:

- **`Add`/`Remove` non salvano**: registrano l'intenzione. Il commit è di `IUnitOfWork`.
- **`tracker.Capture(...)`** in ogni metodo che carica un'entità *per modificarla*: è ciò che
  permette all'audit di avere lo snapshot *prima*. Dimenticarlo non rompe niente in modo visibile —
  l'audit avrà solo un `Before` vuoto.

## 5. La query

Una slice è fatta di quattro file al massimo — richiesta, handler, validatore, risposta — nella
stessa cartella. Per una lettura ne bastano tre.

```csharp
// <Progetto>.Application/Categories/Common/CategoryResponse.cs
public record CategoryResponse(
    int Id, string DescIt, string DescEn, int Order,
    DateTime CreatedAt, DateTime UpdatedAt);

// <Progetto>.Application/Categories/GetCategories/GetCategoriesQuery.cs
public record GetCategoriesQuery : IRequest<List<CategoryResponse>>;

// <Progetto>.Application/Categories/GetCategories/GetCategoriesHandler.cs
public class GetCategoriesHandler(IReadDbContext db, IQueryExecutor executor)
    : IRequestHandler<GetCategoriesQuery, List<CategoryResponse>>
{
    public Task<List<CategoryResponse>> Handle(GetCategoriesQuery request, CancellationToken ct) =>
        executor.ToListAsync(
            db.Categories
                .OrderBy(x => x.Order)
                .Select(x => new CategoryResponse(
                    x.Id, x.DescIt, x.DescEn, x.Order, x.CreatedAt, x.UpdatedAt)),
            ct);
}
```

Perché la nuova entità compaia su `db.Categories`, va aggiunta a `IReadDbContext` e alla sua
implementazione in `AppDbContext`:

```csharp
// Application/Abstractions/Persistence/IReadDbContext.cs
IQueryable<Category> Categories { get; }

// Infrastructure/Persistence/AppDbContext.cs
IQueryable<Category> IReadDbContext.Categories => Set<Category>().AsNoTracking();
```

Tre cose da notare:

- Le response sono **`record` immutabili**, e l'`Id` esce come **`int`**.
- La `Select` proietta **direttamente** sul response: EF genera una `SELECT` con le sole colonne
  necessarie. Niente entità intermedie, niente mapping a mano.
- L'esecuzione passa da **`IQueryExecutor`**, non da `ToListAsync` diretto: è ciò che rende
  l'handler eseguibile in un test unitario con un `IQueryable` in memoria.

L'handler non va registrato da nessuna parte: MediatR lo scopre da sé nell'assembly.

## 6. Il comando

```csharp
// <Progetto>.Application/Categories/CreateCategory/CreateCategoryCommand.cs
public record CreateCategoryCommand(string DescIt, string DescEn, int Order) : IRequest<CreateCategoryResponse>;

// .../CreateCategoryResponse.cs
public record CreateCategoryResponse(int Id);

// .../CreateCategoryValidator.cs
public class CreateCategoryValidator : AbstractValidator<CreateCategoryCommand>
{
    public CreateCategoryValidator()
    {
        RuleFor(x => x.DescIt).NotEmpty().MaximumLength(Category.MaxDescriptionLength);
        RuleFor(x => x.DescEn).NotEmpty().MaximumLength(Category.MaxDescriptionLength);
    }
}
```

Il validatore **non va invocato**: il `ValidationBehavior` della pipeline MediatR lo trova da sé e,
se fallisce, la richiesta non arriva mai all'handler — il middleware restituisce `400` con
ProblemDetails.

Il validatore controlla la **forma** dell'input; il dominio garantisce la **regola**. La
sovrapposizione è voluta: il validatore dà un messaggio gentile su tutti i campi in una volta, il
factory `Category.Create` impedisce che la regola sia aggirabile da un'altra strada.

```csharp
// .../CreateCategoryHandler.cs
public class CreateCategoryHandler(
    ICategoryRepository categories,
    IUnitOfWork unitOfWork) : IRequestHandler<CreateCategoryCommand, CreateCategoryResponse>
{
    public async Task<CreateCategoryResponse> Handle(CreateCategoryCommand request, CancellationToken ct)
    {
        // L'unicità richiede il database: è una verifica dell'handler, non del dominio.
        if (await categories.ExistsByDescriptionAsync(request.DescIt, ct: ct))
            throw new ConflictException($"Esiste già una categoria '{request.DescIt}'.");

        var category = Category.Create(request.DescIt, request.DescEn, request.Order);

        categories.Add(category);
        await unitOfWork.SaveChangesAsync(ct);

        return new CreateCategoryResponse(category.Id);
    }
}
```

Tre punti da non perdere:

- **Un solo `SaveChangesAsync`**, e nessuna menzione dell'audit: lo scrive `AuditLogInterceptor`.
- **`CreatedAt`/`UpdatedAt` non compaiono**: li imposta `TimestampInterceptor`.
- **L'handler non costruisce l'entità con un object initializer**: chiama il factory, che valida.

L'update ha la stessa forma, e la modifica passa da un metodo dell'aggregato:

```csharp
// UpdateCategoryHandler
var category = await categories.GetByIdAsync(request.Id, ct)
    ?? throw new NotFoundException($"Categoria con id {request.Id} non trovata.");

category.Update(request.Body.DescIt, request.Body.DescEn, request.Body.Order);

await unitOfWork.SaveChangesAsync(ct);
```

Non c'è nessuna assegnazione a proprietà: i setter sono privati, e l'unico modo di modificare
l'entità è il metodo che ne garantisce gli invarianti.

> **L'audit è automatico.** `AuditLogInterceptor` scrive una riga per ogni radice di aggregato
> creata, modificata o cancellata, con gli snapshot prima/dopo. Lo snapshot *prima* viene da
> `AuditSnapshotTracker`, alimentato dal repository al caricamento. Un handler non nomina mai
> `AuditLog`.

| Azione | `Before` | `After` |
|---|---|---|
| `Created` | — | lo stato dell'entità creata |
| `Updated` | snapshot catturato al caricamento | snapshot dopo il salvataggio |
| `Deleted` | snapshot prima della cancellazione | — |

## 7. La cancellazione: prima si controlla

```csharp
public class DeleteCategoryHandler(
    ICategoryRepository categories,
    IReadDbContext db,
    IQueryExecutor executor,
    IUnitOfWork unitOfWork) : IRequestHandler<DeleteCategoryCommand>
{
    public async Task Handle(DeleteCategoryCommand request, CancellationToken ct)
    {
        var category = await categories.GetByIdAsync(request.Id, ct)
            ?? throw new NotFoundException($"Categoria con id {request.Id} non trovata.");

        // Conteggio prima della DELETE per dare un 409 con messaggio chiaro: la FK Restrict
        // farebbe comunque fallire la cancellazione, ma con un errore generico.
        var count = await executor.CountAsync(db.Articles.Where(x => x.CategoryId == request.Id), ct);
        if (count > 0)
            throw new ConflictException(
                $"Impossibile eliminare questa categoria: è ancora utilizzata in {count} elemento/i. " +
                "Rimuovila da tutti gli elementi prima di eliminarla.");

        categories.Remove(category);
        await unitOfWork.SaveChangesAsync(ct);
    }
}
```

**Due difese sovrapposte, deliberatamente**: l'handler produce un `409 Conflict` con un messaggio
comprensibile, la FK `Restrict` è la stessa regola applicata anche a chi scrivesse sul database da
fuori.

Se la regola di cancellabilità dipendesse dallo **stato dell'entità** e non da altre tabelle,
apparterrebbe al dominio — come `RentalContract.EnsureDeletable()`, che rifiuta di cancellare un
contratto già confermato. L'handler si limiterebbe a chiamarla.

Non serve validare la forma dell'id: il constraint di rotta `{id:int}` fa sì che un id malformato
non arrivi nemmeno all'handler (404 dal routing).

Se l'operazione dovesse toccare più aggregati insieme, un singolo `SaveChangesAsync` è già atomico:
è esattamente ciò per cui `IUnitOfWork` è separato dai repository.

## 8. Le rotte

```csharp
// <Progetto>.Api/Endpoints/CategoryEndpoints.cs
public static class CategoryEndpoints
{
    public static IEndpointRouteBuilder MapCategoryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/categories").WithTags("Categories").RequireAuthorization();

        group.MapGet("/", async (IMediator mediator, CancellationToken ct) =>
            Results.Ok(await mediator.Send(new GetCategoriesQuery(), ct)))
            .RequireAuthorization(p => p.RequireClaim("permissions", "categories.read"))
            .WithName("GetCategories")
            .WithSummary("Lista categorie")
            .Produces(StatusCodes.Status200OK);

        group.MapGet("/{id:int}", async (int id, IMediator mediator, CancellationToken ct) =>
            Results.Ok(await mediator.Send(new GetCategoryByIdQuery(id), ct)))
            .RequireAuthorization(p => p.RequireClaim("permissions", "categories.read"))
            .WithName("GetCategoryById")
            .WithSummary("Dettaglio categoria")
            .Produces(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPost("/", async (CreateCategoryCommand cmd, IMediator mediator, CancellationToken ct) =>
        {
            var result = await mediator.Send(cmd, ct);
            return Results.Created($"/api/categories/{result.Id}", result);
        })
            .RequireAuthorization(p => p.RequireClaim("permissions", "categories.write"))
            .WithName("CreateCategory")
            .WithSummary("Crea una nuova categoria")
            .Produces(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest);

        group.MapPut("/{id:int}", async (int id, UpdateCategoryRequest body, IMediator mediator, CancellationToken ct) =>
            Results.Ok(await mediator.Send(new UpdateCategoryCommand(id, body), ct)))
            .RequireAuthorization(p => p.RequireClaim("permissions", "categories.write"))
            .WithName("UpdateCategory")
            .WithSummary("Aggiorna una categoria")
            .Produces(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapDelete("/{id:int}", async (int id, IMediator mediator, CancellationToken ct) =>
        {
            await mediator.Send(new DeleteCategoryCommand(id), ct);
            return Results.NoContent();
        })
            .RequireAuthorization(p => p.RequireClaim("permissions", "categories.delete"))
            .WithName("DeleteCategory")
            .WithSummary("Elimina una categoria")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound);

        return app;
    }
}
```

L'endpoint **instrada e basta**: nessuna logica, nessun accesso al `DbContext`. Da notare:

- **Il constraint `{id:int}`** su ogni rotta con id. Non è cosmetico: filtra gli id malformati prima
  che tocchino l'applicazione.
- **Ogni rotta dichiara il permesso** che richiede (`read` / `write` / `delete`).
- **`UpdateCategoryRequest` è il body**, e l'handler riceve un `UpdateCategoryCommand(id, body)`: l'id
  viene dalla rotta, non dal corpo della richiesta.

Poi va agganciato:

```csharp
// <Progetto>.Api/Extensions/EndpointExtensions.cs
app.MapCategoryEndpoints();
```

## 9. I permessi

Vanno aggiunti al seed (`Infrastructure/Persistence/Seed/DataSeeder.cs`) come `categories.read`, `categories.write`,
`categories.delete`, e assegnati ai ruoli che devono averli.

```csharp
("categories.read",   "Categories", "read",   "Legge la lista categorie"),
("categories.write",  "Categories", "write",  "Crea e modifica categorie"),
("categories.delete", "Categories", "delete", "Elimina categorie"),
```

Il ruolo `Viewer` prende automaticamente tutti i permessi con azione `read`, quindi il nuovo
`categories.read` ci finisce da solo; per gli altri ruoli va deciso caso per caso.

> Il seed popola **solo un database vuoto**: su un'installazione già avviata i nuovi permessi **non
> compaiono da soli**. Vanno creati dal pannello Permessi e assegnati ai ruoli — oppure, in sviluppo,
> si droppa il database a mano e si riparte (non esiste un comando di reset).

---

# Frontend

La catena è sempre la stessa, e non si salta un anello: **tipi → service → store → pagina**.

## 10. Tipi, service, store

```typescript
// types/api.types.ts
export interface Category {
  id: number
  descIt: string
  descEn: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface CreateCategoryRequest {
  descIt: string
  descEn: string
  order: number
}

export type UpdateCategoryRequest = CreateCategoryRequest
```

Gli id sono **`number`**, coerenti con gli `int` del backend.

```typescript
// services/categories.service.ts — le uniche righe del progetto in cui si usa axios
import { api } from '@/plugins/axios'
import type { Category, CreateCategoryRequest, UpdateCategoryRequest } from '@/types/api.types'

export const categoriesService = {
  getAll: () => api.get<Category[]>('/api/categories').then(r => r.data),
  getById: (id: number) => api.get<Category>(`/api/categories/${id}`).then(r => r.data),
  create: (data: CreateCategoryRequest) => api.post<Category>('/api/categories', data).then(r => r.data),
  update: (id: number, data: UpdateCategoryRequest) =>
    api.put<Category>(`/api/categories/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/api/categories/${id}`),
}
```

```typescript
// stores/categories.store.ts — composition API, mai options API
export const useCategoriesStore = defineStore('categories', () => {
  const items = ref<Category[]>([])
  const selectedItem = ref<Category | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchAll() {
    loading.value = true
    error.value = null
    try {
      items.value = await categoriesService.getAll()
    } catch {
      error.value = i18n.global.t('errors.loadCategories')   // mai una stringa a mano
    } finally {
      loading.value = false
    }
  }

  async function create(data: CreateCategoryRequest) {
    loading.value = true
    error.value = null
    try {
      const result = await categoriesService.create(data)
      await fetchAll()          // ricarica: la lista resta allineata al server
      return result
    } catch (e) {
      error.value = i18n.global.t('errors.createCategory')
      throw e                   // rilancia: la pagina deve poter mostrare l'errore
    } finally {
      loading.value = false
    }
  }

  // fetchById, update, remove: stessa forma

  return { items, selectedItem, loading, error, fetchAll, fetchById, create, update, remove }
})
```

Lo store **rilancia** l'eccezione dopo averla registrata: senza, la pagina chiuderebbe il dialog come
se l'operazione fosse riuscita.

## 11. Le pagine

Due: la lista (`CategoriesPage.vue`) e il dettaglio, usato sia per la creazione sia per la modifica
(`CategoryDetailPage.vue`).

```vue
<script setup lang="ts">
const { t } = useI18n()
const { mobile } = useDisplay()
const store = useCategoriesStore()
const { can } = usePermission()

onMounted(() => store.fetchAll())
</script>

<template>
  <h1 class="text-h5">{{ t('categories.title') }}</h1>

  <!-- il pulsante non esiste se manca il permesso -->
  <v-btn v-if="can('categories.write')" color="primary" prepend-icon="mdi-plus"
         :to="{ name: 'category-create' }">
    {{ t('categories.createButton') }}
  </v-btn>

  <!-- tabella su desktop, lista su mobile -->
  <v-data-table v-if="!mobile" :headers="headers" :items="store.items" :loading="store.loading" />
  <v-list v-else> … </v-list>
</template>
```

Le convenzioni che si vedono qui:

- **Nessun testo a mano nei template**: sempre `t('chiave')`.
- **`can('permesso')`** per mostrare o nascondere le azioni. È cortesia verso l'utente: a **negare**
  l'operazione è il backend.
- **Componenti Vuetify**, colori dal tema (`color="primary"`, `color="error"`), mai valori esadecimali.
- **`useApiErrors`** per tradurre i ProblemDetails del backend in messaggi leggibili — è così che il
  `409 Conflict` del delete handler arriva all'utente come una frase di senso compiuto.
- Un componente oltre le ~150 righe va spezzato.

## 12. Rotte e testi

```typescript
// router/index.ts
{
  path: 'categories',
  name: 'categories',
  component: () => import('@/pages/categories/CategoriesPage.vue'),   // lazy load, sempre
  meta: { requiresAuth: true, permission: 'categories.read', title: 'routes.categories' },
},
{
  path: 'categories/new',
  name: 'category-create',
  component: () => import('@/pages/categories/CategoryDetailPage.vue'),
  meta: { requiresAuth: true, permission: 'categories.write', title: 'routes.newCategory' },
},
{
  path: 'categories/:id(\\d+)',
  name: 'category-detail',
  component: () => import('@/pages/categories/CategoryDetailPage.vue'),
  meta: { requiresAuth: true, permission: 'categories.read', title: 'routes.categoryDetail' },
},
```

Due dettagli:

- **`:id(\d+)`** è il corrispettivo frontend del constraint `{id:int}` del backend: con id numerici,
  la rotta `categories/new` non rischia di essere catturata dalla rotta di dettaglio.
- **Ogni rotta dichiara `meta.permission`**: il navigation guard la usa per bloccare l'accesso diretto
  via URL. Nota che la creazione richiede `categories.write` mentre il dettaglio richiede
  `categories.read`, pur essendo lo stesso componente.

Infine i testi, in **entrambe** le lingue (`locales/it.ts` e `locales/en.ts`):

```typescript
// locales/it.ts
nav: { categories: 'Categorie' },
routes: { categories: 'Categorie', newCategory: 'Nuova categoria', categoryDetail: 'Dettaglio categoria' },
categories: {
  title: 'Categorie',
  subtitle: 'Gestione categorie',
  createButton: 'Nuova categoria',
  deleteConfirm: 'Sei sicuro di voler eliminare questa categoria?',
  descIt: 'Descrizione (IT)',
  descEn: 'Descrizione (EN)',
},
errors: {
  loadCategories: 'Errore nel caricamento delle categorie',
  createCategory: 'Errore nella creazione della categoria',
  deleteCategory: 'Errore nell\'eliminazione della categoria',
},
```

---

## Prima di dire che è finita

- [ ] L'entità estende `Entity`/`AggregateRoot`, ha **setter privati**, un **factory method** e un
      costruttore privato per EF; niente attributi di persistenza né `using` di EF Core
- [ ] La `IEntityTypeConfiguration` c'è, le colonne stringa sono **dimensionate**, le FK sono `Restrict`
- [ ] **Entrambe** le migration sono generate (SqlServer + Postgres) e committate
- [ ] I **comandi** iniettano repository + `IUnitOfWork`; le **query** `IReadDbContext` + `IQueryExecutor`.
      Nessun handler nomina `AppDbContext`
- [ ] Il repository è registrato in `DependencyInjection.cs`, e i metodi che caricano per modificare
      chiamano `tracker.Capture(...)`
- [ ] Le regole di business stanno nell'aggregato o in un domain service, non in `if` sparsi negli handler
- [ ] Le query LINQ sono traducibili da entrambi i provider — attenzione a `Contains` su stringa
- [ ] Le rotte con id usano il constraint `{id:int}`, e gli endpoint sono agganciati in `EndpointExtensions`
- [ ] Nessun handler scrive un audit log a mano: lo fa l'interceptor
- [ ] I permessi sono nel seed e assegnati ai ruoli giusti
- [ ] I testi esistono in italiano **e** in inglese
- [ ] `dotnet test` passa — i test di architettura sono la rete che intercetta le violazioni dei layer

## Da qui

- **[Dove mettere la logica](../architettura/dove-mettere-la-logica.md)** — quando una regola va nell'aggregato, in un domain service o nell'handler
- **[Il dominio](../architettura/il-dominio.md)** — aggregati, value object, eventi, specification
- **[Comandi e query](../architettura/comandi-e-query.md)** — repository, unit of work, `IReadDbContext`
