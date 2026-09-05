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
| 1 | `_Shared/Entities/Category.cs` | L'entità EF Core |
| 2 | `_Shared/Persistence/AppDbContext.cs` | La mappatura: tabella, colonne, indici |
| 3 | `Migrations/SqlServer/` + `Migrations/Postgres/` | **Due** migration |
| 4 | `Features/Categories/GetCategories/` | La query |
| 5 | `Features/Categories/CreateCategory/` | Il comando, con validazione e audit |
| 6 | `Features/Categories/UpdateCategory/`, `DeleteCategory/` | Modifica e cancellazione |
| 7 | `Features/Categories/CategoryEndpoints.cs` + `_Shared/Extensions/EndpointExtensions.cs` | Le rotte |
| 8 | `_Shared/Seed/DataSeeder.cs` | I permessi |
| 9 | `types/api.types.ts` → `services/` → `stores/` → `pages/` | Il frontend |
| 10 | `router/index.ts`, `locales/it.ts`, `locales/en.ts` | Rotte, testi |

---

# Backend

## 1. L'entità

```csharp
// Features/_Shared/Entities/Category.cs
public class Category : ITimestamped
{
    public int Id { get; set; }
    public string DescIt { get; set; } = string.Empty;
    public string DescEn { get; set; } = string.Empty;
    public int Order { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
```

Le regole, tutte e quattro non negoziabili:

- **Nessun suffisso**: `Category`, non `CategoryDocument` né `CategoryEntity`.
- **`Id` di tipo `int`**, mai `string` né `Guid`. È identity: lo assegna il database. Il perché è in
  [Decisioni](../infrastructure/decisioni.md).
- **`ITimestamped`** se l'entità ha `CreatedAt`/`UpdatedAt`: è l'interfaccia che fa scattare
  l'assegnazione automatica dei timestamp in `SaveChanges`. Gli handler non li valorizzano mai a mano.
- **Nessun attributo di persistenza.** Niente data annotation: tutta la configurazione sta in
  `OnModelCreating`, in un punto solo.

## 2. La tabella

```csharp
// Features/_Shared/Persistence/AppDbContext.cs — dentro OnModelCreating
mb.Entity<Category>(e =>
{
    e.ToTable("Categories");
    e.Property(x => x.DescIt).HasMaxLength(256);   // mai lasciare nvarchar(max)/text
    e.Property(x => x.DescEn).HasMaxLength(256);
});
```

`HasKey` non serve: EF riconosce `Id` per convenzione e lo rende identity su entrambi i provider.
Non serve nemmeno un `DbSet`: le entità si raggiungono con `db.Set<Category>()`.

**Ogni colonna stringa va dimensionata.** Senza `HasMaxLength` EF genera `nvarchar(max)` (SQL Server)
o `text` (Postgres): pessimo per indici e storage, e su SQL Server un indice unique non è nemmeno
ammesso su `nvarchar(max)`.

Se l'entità avesse una **FK** verso un'altra, andrebbe dichiarata con `Restrict`, mai `Cascade`:

```csharp
e.HasOne(x => x.Parent).WithMany().HasForeignKey(x => x.ParentId)
    .OnDelete(DeleteBehavior.Restrict);
```

`Cascade` qui sarebbe pericoloso: cancellare una categoria cancellerebbe tutto ciò che la usa.

Se avesse una relazione **molti-a-molti**, servirebbe una join table con skip navigation
unidirezionale — vedi [Architettura](../infrastructure/architettura.md).

## 3. Le due migration

```bash
cd apps/backend/<Progetto>.Api

dotnet dotnet-ef migrations add AddCategories --context SqlServerAppDbContext --output-dir Features/_Shared/Persistence/Migrations/SqlServer
dotnet dotnet-ef migrations add AddCategories --context PostgresAppDbContext  --output-dir Features/_Shared/Persistence/Migrations/Postgres
```

Il `--context` seleziona quale delle due derivate usare, e quindi in quale cartella finisce la
migration. Si applicano da sole all'avvio (`MigrateAsync`).

> **Mai modificare una migration già committata**: una correzione è una migration nuova.

## 4. La query

Una slice è fatta di quattro file al massimo — richiesta, handler, validatore, risposta — nella
stessa cartella. Per una lettura ne bastano tre.

```csharp
// Features/Categories/GetCategories/CategoryResponse.cs
public record CategoryResponse(
    int Id, string DescIt, string DescEn, int Order,
    DateTime CreatedAt, DateTime UpdatedAt);

// Features/Categories/GetCategories/GetCategoriesQuery.cs
public record GetCategoriesQuery : IRequest<List<CategoryResponse>>;

// Features/Categories/GetCategories/GetCategoriesHandler.cs
public class GetCategoriesHandler(AppDbContext db) : IRequestHandler<GetCategoriesQuery, List<CategoryResponse>>
{
    public Task<List<CategoryResponse>> Handle(GetCategoriesQuery request, CancellationToken cancellationToken) =>
        db.Set<Category>()
            .OrderBy(x => x.Order)
            .Select(x => new CategoryResponse(x.Id, x.DescIt, x.DescEn, x.Order, x.CreatedAt, x.UpdatedAt))
            .ToListAsync(cancellationToken);
}
```

Tre cose da notare:

- Le response sono **`record` immutabili**, e l'`Id` esce come **`int`**.
- La `Select` proietta **direttamente** sul response: EF genera una `SELECT` con le sole colonne
  necessarie e non popola il change tracker. Niente entità intermedie, niente mapping a mano.
- L'handler dipende **solo** da `AppDbContext` e non sa quale database ci sia sotto.

> In lettura, `Select` verso un record rende `AsNoTracking()` superfluo: una proiezione non traccia
> nulla di per sé. `AsNoTracking()` serve quando si materializzano **entità**.

L'handler non va registrato da nessuna parte: MediatR lo scopre da sé nell'assembly.

## 5. Il comando: validazione e audit

```csharp
// Features/Categories/CreateCategory/CreateCategoryCommand.cs
public record CreateCategoryCommand(string DescIt, string DescEn, int Order) : IRequest<CreateCategoryResponse>;

// Features/Categories/CreateCategory/CreateCategoryResponse.cs
public record CreateCategoryResponse(int Id);

// Features/Categories/CreateCategory/CreateCategoryValidator.cs
public class CreateCategoryValidator : AbstractValidator<CreateCategoryCommand>
{
    public CreateCategoryValidator()
    {
        RuleFor(x => x.DescIt).NotEmpty().MaximumLength(200);
        RuleFor(x => x.DescEn).NotEmpty().MaximumLength(200);
    }
}
```

Il validatore **non va invocato**: il `ValidationBehavior` della pipeline MediatR lo trova da sé e,
se fallisce, la richiesta non arriva mai all'handler — il middleware restituisce `400` con
ProblemDetails.

```csharp
// Features/Categories/CreateCategory/CreateCategoryHandler.cs
public class CreateCategoryHandler(
    AppDbContext db,
    IHttpContextAccessor httpContextAccessor) : IRequestHandler<CreateCategoryCommand, CreateCategoryResponse>
{
    public async Task<CreateCategoryResponse> Handle(CreateCategoryCommand request, CancellationToken cancellationToken)
    {
        var category = new Category
        {
            DescIt = request.DescIt,
            DescEn = request.DescEn,
            Order = request.Order,
        };

        db.Add(category);
        await db.SaveChangesAsync(cancellationToken);   // assegna l'id identity

        db.Add(AuditTrail.New(httpContextAccessor, "Category", category.Id, "Created"));
        await db.SaveChangesAsync(cancellationToken);

        return new CreateCategoryResponse(category.Id);
    }
}
```

Tre punti da non perdere:

- **`CreatedAt`/`UpdatedAt` non compaiono**: li imposta `ApplyTimestamps` dentro `SaveChangesAsync`.
- **I due `SaveChangesAsync` non sono una svista.** L'audit log ha bisogno dell'id, che il database
  assegna solo al primo salvataggio. È la conseguenza diretta degli id identity.
- **L'attore si legge dai claim del JWT**, mai dal corpo della richiesta: lo fa `AuditTrail.New`, che
  compila da sé `ActorId` (claim `sub`, 0 se assente), `ActorEmail`, `Timestamp` e `IpAddress`.

**Ogni scrittura registra un audit log.** Gli snapshot seguono uno schema uniforme in tutto il codice:

| Azione | `Before` | `After` |
|---|---|---|
| `Created` | — | — (lo stato creato è quello corrente dell'entità) |
| `Updated` | snapshot prima della modifica | snapshot dopo il `SaveChanges` |
| `Deleted` | snapshot prima della cancellazione | — |

```csharp
// UpdateCategoryHandler — la forma dello snapshot
var category = await db.Set<Category>().FirstOrDefaultAsync(x => x.Id == request.Id, cancellationToken)
    ?? throw new NotFoundException("Category", request.Id);

var before = category.ToAuditJson();      // PRIMA di toccare l'oggetto
category.DescIt = request.Body.DescIt;
category.DescEn = request.Body.DescEn;
category.Order = request.Body.Order;

await db.SaveChangesAsync(cancellationToken);   // UpdatedAt lo imposta ApplyTimestamps

db.Add(AuditTrail.New(httpContextAccessor, "Category", category.Id, "Updated",
    before: before, after: category.ToAuditJson()));
await db.SaveChangesAsync(cancellationToken);
```

Lo snapshot `Before` va catturato **prima** di modificare l'oggetto — è un errore facile e silenzioso,
perché l'entità è tracciata e mutarla cambierebbe anche lo snapshot.

> Gli snapshot sono **JSON camelCase in una colonna testo**, prodotti da `ToAuditJson()`. È un metodo
> esplicito per entità, non una serializzazione generica: per gli utenti, `passwordHash` non può
> finirci **per costruzione**.

⚠️ **Il caso M2M.** Se l'update tocca **solo** le collezioni molti-a-molti, l'entità non viene marcata
`Modified` e `UpdatedAt` non si aggiorna da solo: va toccato esplicitamente (vedi `UpdateUserHandler`).
Per una lookup piatta come `Category` il problema non si pone.

## 6. La cancellazione: prima si controlla

```csharp
// Features/Categories/DeleteCategory/DeleteCategoryHandler.cs
public class DeleteCategoryHandler(
    AppDbContext db,
    IHttpContextAccessor httpContextAccessor) : IRequestHandler<DeleteCategoryCommand>
{
    public async Task Handle(DeleteCategoryCommand request, CancellationToken cancellationToken)
    {
        var category = await db.Set<Category>().FirstOrDefaultAsync(x => x.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException("Category", request.Id);

        // Conteggio prima della DELETE per dare un 409 con messaggio chiaro: la FK Restrict
        // farebbe comunque fallire la cancellazione, ma con un errore generico.
        var count = await db.Set<Article>().CountAsync(x => x.CategoryId == request.Id, cancellationToken);
        if (count > 0)
            throw new ConflictException(
                $"Impossibile eliminare questa categoria: è ancora utilizzata in {count} elemento/i. " +
                "Rimuovila da tutti gli elementi prima di eliminarla.");

        var before = category.ToAuditJson();
        db.Remove(category);
        await db.SaveChangesAsync(cancellationToken);

        db.Add(AuditTrail.New(httpContextAccessor, "Category", category.Id, "Deleted", before: before));
        await db.SaveChangesAsync(cancellationToken);
    }
}
```

Il pattern si ritrova identico in tutte le lookup: **due difese sovrapposte, deliberatamente**.
L'handler produce un `409 Conflict` con un messaggio comprensibile; la FK `Restrict` è la stessa
regola applicata anche a chi scrivesse sul database da fuori. (Il conteggio serve solo se qualche
altra entità referenzia questa.)

Non serve validare la forma dell'id: il constraint di rotta `{id:int}` fa sì che un id malformato non
arrivi nemmeno all'handler (404 dal routing).

Se l'operazione dovesse toccare più entità insieme, un singolo `SaveChangesAsync` è già atomico; per
blocchi più ampi si usa `db.Database.BeginTransactionAsync` — ricordando che con
`EnableRetryOnFailure` attivo va eseguito dentro la strategia di esecuzione.

## 7. Le rotte

```csharp
// Features/Categories/CategoryEndpoints.cs
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
// Features/_Shared/Extensions/EndpointExtensions.cs
app.MapCategoryEndpoints();
```

## 8. I permessi

Vanno aggiunti al seed (`_Shared/Seed/DataSeeder.cs`) come `categories.read`, `categories.write`,
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

## 9. Tipi, service, store

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

## 10. Le pagine

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

## 11. Rotte e testi

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

- [ ] L'entità ha `int Id`, implementa `ITimestamped` se ha i timestamp, non ha attributi di persistenza
- [ ] La mappatura in `OnModelCreating` c'è, le colonne stringa sono **dimensionate**, le FK sono `Restrict`
- [ ] **Entrambe** le migration sono generate (SqlServer + Postgres) e committate
- [ ] Le query LINQ sono traducibili da entrambi i provider — attenzione a `Contains` su stringa
- [ ] Le rotte con id usano il constraint `{id:int}`, e gli endpoint sono agganciati in `EndpointExtensions`
- [ ] Ogni scrittura produce un audit log, con lo snapshot `Before` catturato **prima** della modifica
- [ ] I permessi sono nel seed e assegnati ai ruoli giusti
- [ ] I testi esistono in italiano **e** in inglese
