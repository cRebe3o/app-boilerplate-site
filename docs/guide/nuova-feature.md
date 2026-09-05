# Aggiungere una feature

Il percorso completo per portare una nuova entità dal database fino alla pagina, attraversando tutti
i punti in cui il progetto chiede qualcosa di specifico.

**L'esempio non è inventato: è la feature "Valli" (`Valleys`), che esiste nel repository.** Ogni
frammento di codice qui sotto è il file reale, non una versione semplificata: si può aprire il
progetto e confrontare riga per riga. È una lookup piatta — descrizione italiana, descrizione
inglese, ordinamento — cioè il caso più frequente e il più facile da imitare.

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
| 1 | `_Shared/Entities/Valley.cs` | L'entità EF Core |
| 2 | `_Shared/Persistence/AppDbContext.cs` | La mappatura: tabella, colonne, indici |
| 3 | `Migrations/SqlServer/` + `Migrations/Postgres/` | **Due** migration |
| 4 | `Features/Valleys/GetValleys/` | La query |
| 5 | `Features/Valleys/CreateValley/` | Il comando, con validazione e audit |
| 6 | `Features/Valleys/UpdateValley/`, `DeleteValley/` | Modifica e cancellazione |
| 7 | `Features/Valleys/ValleyEndpoints.cs` + `_Shared/Extensions/EndpointExtensions.cs` | Le rotte |
| 8 | `_Shared/Seed/DataSeeder.cs` | I permessi |
| 9 | `types/api.types.ts` → `services/` → `stores/` → `pages/` | Il frontend |
| 10 | `router/index.ts`, `locales/it.ts`, `locales/en.ts` | Rotte, testi |

Rispetto al passato non c'è più nessun file di repository: gli handler usano direttamente
`AppDbContext`.

---

# Backend

## 1. L'entità

```csharp
// Features/_Shared/Entities/Valley.cs
public class Valley : ITimestamped
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

- **Nessun suffisso**: `Valley`, non `ValleyDocument` né `ValleyEntity`.
- **`Id` di tipo `int`**, mai `string` né `Guid`. È identity: lo assegna il database. Il perché è in
  [Decisioni](../database_sql-only/decisioni.md).
- **`ITimestamped`** se l'entità ha `CreatedAt`/`UpdatedAt`: è l'interfaccia che fa scattare
  l'assegnazione automatica dei timestamp in `SaveChanges`. Gli handler non li valorizzano mai a mano.
- **Nessun attributo di persistenza.** Niente data annotation: tutta la configurazione sta in
  `OnModelCreating`, in un punto solo.

## 2. La tabella

```csharp
// Features/_Shared/Persistence/AppDbContext.cs — dentro OnModelCreating
mb.Entity<Valley>(e =>
{
    e.ToTable("Valleys");
    e.Property(x => x.DescIt).HasMaxLength(256);   // mai lasciare nvarchar(max)/text
    e.Property(x => x.DescEn).HasMaxLength(256);
});
```

`HasKey` non serve: EF riconosce `Id` per convenzione e lo rende identity su entrambi i provider.

**Ogni colonna stringa va dimensionata.** Senza `HasMaxLength` EF genera `nvarchar(max)` (SQL Server)
o `text` (Postgres): pessimo per indici e storage, e su SQL Server un indice unique non è nemmeno
ammesso su `nvarchar(max)`.

Se l'entità avesse una **FK** verso un'altra (come `ProductTypes` → `Typologies`), andrebbe
dichiarata con `Restrict`, mai `Cascade`:

```csharp
e.HasOne(x => x.Typology).WithMany().HasForeignKey(x => x.TypologyId)
    .OnDelete(DeleteBehavior.Restrict);
```

Se avesse una relazione **molti-a-molti**, servirebbe una join table con skip navigation
unidirezionale — vedi [Architettura](../database_sql-only/architettura.md).

## 3. Le due migration

```bash
cd apps/backend/DelVoltone.Api

dotnet dotnet-ef migrations add AddValleys --context SqlServerAppDbContext --output-dir Features/_Shared/Persistence/Migrations/SqlServer
dotnet dotnet-ef migrations add AddValleys --context PostgresAppDbContext  --output-dir Features/_Shared/Persistence/Migrations/Postgres
```

Il `--context` seleziona quale delle due derivate usare, e quindi in quale cartella finisce la
migration. Si applicano da sole all'avvio (`MigrateAsync`).

> **Mai modificare una migration già committata**: una correzione è una migration nuova.

## 4. La query

Una slice è fatta di quattro file al massimo — richiesta, handler, validatore, risposta — nella
stessa cartella. Per una lettura ne bastano tre.

```csharp
// Features/Valleys/GetValleys/ValleyResponse.cs
public record ValleyResponse(
    int Id, string DescIt, string DescEn, int Order,
    DateTime CreatedAt, DateTime UpdatedAt);

// Features/Valleys/GetValleys/GetValleysQuery.cs
public record GetValleysQuery : IRequest<List<ValleyResponse>>;

// Features/Valleys/GetValleys/GetValleysHandler.cs
public class GetValleysHandler(AppDbContext db) : IRequestHandler<GetValleysQuery, List<ValleyResponse>>
{
    // Nessun OrderBy: l'ordinamento è a carico del chiamante (la scansione segue comunque
    // la PK identity, cioè l'ordine di creazione).
    public Task<List<ValleyResponse>> Handle(GetValleysQuery request, CancellationToken cancellationToken) =>
        db.Set<Valley>()
            .Select(x => new ValleyResponse(x.Id, x.DescIt, x.DescEn, x.Order, x.CreatedAt, x.UpdatedAt))
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

## 5. Il comando: validazione e audit

```csharp
// Features/Valleys/CreateValley/CreateValleyCommand.cs
public record CreateValleyCommand(string DescIt, string DescEn, int Order) : IRequest<CreateValleyResponse>;

// Features/Valleys/CreateValley/CreateValleyResponse.cs
public record CreateValleyResponse(int Id);

// Features/Valleys/CreateValley/CreateValleyValidator.cs
public class CreateValleyValidator : AbstractValidator<CreateValleyCommand>
{
    public CreateValleyValidator()
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
// Features/Valleys/CreateValley/CreateValleyHandler.cs
public class CreateValleyHandler(
    AppDbContext db,
    IHttpContextAccessor httpContextAccessor) : IRequestHandler<CreateValleyCommand, CreateValleyResponse>
{
    public async Task<CreateValleyResponse> Handle(CreateValleyCommand request, CancellationToken cancellationToken)
    {
        var valley = new Valley
        {
            DescIt = request.DescIt,
            DescEn = request.DescEn,
            Order = request.Order,
        };

        db.Add(valley);
        await db.SaveChangesAsync(cancellationToken);   // assegna l'id identity

        db.Add(AuditTrail.New(httpContextAccessor, "Valley", valley.Id, "Created"));
        await db.SaveChangesAsync(cancellationToken);

        return new CreateValleyResponse(valley.Id);
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
// UpdateValleyHandler — la forma dello snapshot
var valley = await db.Set<Valley>().FirstOrDefaultAsync(x => x.Id == request.Id, cancellationToken)
    ?? throw new NotFoundException("Valley", request.Id);

var before = valley.ToAuditJson();      // PRIMA di toccare l'oggetto
valley.DescIt = request.Body.DescIt;
valley.DescEn = request.Body.DescEn;
valley.Order = request.Body.Order;

await db.SaveChangesAsync(cancellationToken);   // UpdatedAt lo imposta ApplyTimestamps

db.Add(AuditTrail.New(httpContextAccessor, "Valley", valley.Id, "Updated",
    before: before, after: valley.ToAuditJson()));
await db.SaveChangesAsync(cancellationToken);
```

Lo snapshot `Before` va catturato **prima** di modificare l'oggetto — è un errore facile e silenzioso,
perché l'entità è tracciata e mutarla cambierebbe anche lo snapshot.

> Gli snapshot sono **JSON camelCase in una colonna testo**, prodotti da `ToAuditJson()`. È un metodo
> esplicito per entità, non una serializzazione generica: per gli utenti, `passwordHash` non può
> finirci **per costruzione**.

⚠️ **Il caso M2M.** Se l'update tocca **solo** le collezioni molti-a-molti, l'entità non viene marcata
`Modified` e `UpdatedAt` non si aggiorna da solo: va toccato esplicitamente (vedi `UpdateUserHandler`).
Per una lookup piatta come `Valley` il problema non si pone.

## 6. La cancellazione: prima si controlla

```csharp
// Features/Valleys/DeleteValley/DeleteValleyHandler.cs
public class DeleteValleyHandler(
    AppDbContext db,
    IHttpContextAccessor httpContextAccessor) : IRequestHandler<DeleteValleyCommand>
{
    public async Task Handle(DeleteValleyCommand request, CancellationToken cancellationToken)
    {
        var valley = await db.Set<Valley>().FirstOrDefaultAsync(x => x.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException("Valley", request.Id);

        // Conteggio prima della DELETE per dare un 409 con messaggio chiaro: la FK Restrict
        // su Products farebbe comunque fallire la cancellazione, ma con un errore generico.
        var count = await db.Set<Product>().CountAsync(x => x.ValleyId == request.Id, cancellationToken);
        if (count > 0)
            throw new ConflictException(
                $"Impossibile eliminare questa valle: è ancora utilizzata in {count} prodotto/i. " +
                "Rimuovila da tutti i prodotti prima di eliminarla.");

        var before = valley.ToAuditJson();
        db.Remove(valley);
        await db.SaveChangesAsync(cancellationToken);

        db.Add(AuditTrail.New(httpContextAccessor, "Valley", valley.Id, "Deleted", before: before));
        await db.SaveChangesAsync(cancellationToken);
    }
}
```

Il pattern si ritrova identico in tutte le lookup: **due difese sovrapposte, deliberatamente**.
L'handler produce un `409 Conflict` con un messaggio comprensibile; la FK `Restrict` è la stessa
regola applicata anche a chi scrivesse sul database da fuori.

Non serve più validare la forma dell'id: il constraint di rotta `{id:int}` fa sì che un id malformato
non arrivi nemmeno all'handler (404 dal routing).

Se l'operazione dovesse toccare più entità insieme, un singolo `SaveChangesAsync` è già atomico; per
blocchi più ampi si usa `db.Database.BeginTransactionAsync`. Le cancellazioni a cascata delle join
table le garantisce il database con le FK.

## 7. Le rotte

```csharp
// Features/Valleys/ValleyEndpoints.cs
public static class ValleyEndpoints
{
    public static IEndpointRouteBuilder MapValleyEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/valleys").WithTags("Valleys").RequireAuthorization();

        group.MapGet("/", async (IMediator mediator, CancellationToken ct) =>
            Results.Ok(await mediator.Send(new GetValleysQuery(), ct)))
            .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.read"))
            .WithName("GetValleys")
            .WithSummary("Lista valli")
            .Produces(StatusCodes.Status200OK);

        group.MapGet("/{id:int}", async (int id, IMediator mediator, CancellationToken ct) =>
            Results.Ok(await mediator.Send(new GetValleyByIdQuery(id), ct)))
            .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.read"))
            .WithName("GetValleyById")
            .WithSummary("Dettaglio valle")
            .Produces(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPost("/", async (CreateValleyCommand cmd, IMediator mediator, CancellationToken ct) =>
        {
            var result = await mediator.Send(cmd, ct);
            return Results.Created($"/api/valleys/{result.Id}", result);
        })
            .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.write"))
            .WithName("CreateValley")
            .WithSummary("Crea una nuova valle")
            .Produces(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest);

        group.MapPut("/{id:int}", async (int id, UpdateValleyRequest body, IMediator mediator, CancellationToken ct) =>
            Results.Ok(await mediator.Send(new UpdateValleyCommand(id, body), ct)))
            .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.write"))
            .WithName("UpdateValley")
            .WithSummary("Aggiorna una valle")
            .Produces(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapDelete("/{id:int}", async (int id, IMediator mediator, CancellationToken ct) =>
        {
            await mediator.Send(new DeleteValleyCommand(id), ct);
            return Results.NoContent();
        })
            .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.delete"))
            .WithName("DeleteValley")
            .WithSummary("Elimina una valle")
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
- **`UpdateValleyRequest` è il body**, e l'handler riceve un `UpdateValleyCommand(id, body)`: l'id
  viene dalla rotta, non dal corpo della richiesta.

Poi va agganciato:

```csharp
// Features/_Shared/Extensions/EndpointExtensions.cs
app.MapValleyEndpoints();
```

## 8. I permessi

Vanno aggiunti al seed (`_Shared/Seed/DataSeeder.cs`) come `valleys.read`, `valleys.write`,
`valleys.delete`, e assegnati ai ruoli che devono averli.

> Il seed popola **solo un database vuoto**: su un'installazione già avviata i nuovi permessi **non
> compaiono da soli**. Vanno creati dal pannello Permessi e assegnati ai ruoli — oppure, in sviluppo,
> si droppa il database a mano e si riparte (non esiste un comando di reset).

---

# Frontend

La catena è sempre la stessa, e non si salta un anello: **tipi → service → store → pagina**.

## 9. Tipi, service, store

```typescript
// types/api.types.ts
export interface Valley {
  id: number
  descIt: string
  descEn: string
  order: number
  createdAt: string
  updatedAt: string
}

export interface CreateValleyRequest {
  descIt: string
  descEn: string
  order: number
}

export type UpdateValleyRequest = CreateValleyRequest
```

Gli id sono **`number`**, coerenti con gli `int` del backend.

```typescript
// services/valleys.service.ts — le uniche righe del progetto in cui si usa axios
import { api } from '@/plugins/axios'
import type { Valley, CreateValleyRequest, UpdateValleyRequest } from '@/types/api.types'

export const valleysService = {
  getAll: () => api.get<Valley[]>('/api/valleys').then(r => r.data),
  getById: (id: number) => api.get<Valley>(`/api/valleys/${id}`).then(r => r.data),
  create: (data: CreateValleyRequest) => api.post<Valley>('/api/valleys', data).then(r => r.data),
  update: (id: number, data: UpdateValleyRequest) =>
    api.put<Valley>(`/api/valleys/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/api/valleys/${id}`),
}
```

```typescript
// stores/valleys.store.ts — composition API, mai options API
export const useValleysStore = defineStore('valleys', () => {
  const items = ref<Valley[]>([])
  const selectedItem = ref<Valley | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchAll() {
    loading.value = true
    error.value = null
    try {
      items.value = await valleysService.getAll()
    } catch {
      error.value = i18n.global.t('errors.loadValleys')   // mai una stringa a mano
    } finally {
      loading.value = false
    }
  }

  async function create(data: CreateValleyRequest) {
    loading.value = true
    error.value = null
    try {
      const result = await valleysService.create(data)
      await fetchAll()          // ricarica: la lista resta allineata al server
      return result
    } catch (e) {
      error.value = i18n.global.t('errors.loadValleys')
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

Due: la lista (`ValleysPage.vue`) e il dettaglio, usato sia per la creazione sia per la modifica
(`ValleyDetailPage.vue`).

```vue
<script setup lang="ts">
const { t } = useI18n()
const { mobile } = useDisplay()
const store = useValleysStore()
const { can } = usePermission()

onMounted(() => store.fetchAll())
</script>

<template>
  <h1 class="text-h5">{{ t('valleys.title') }}</h1>

  <!-- il pulsante non esiste se manca il permesso -->
  <v-btn v-if="can('valleys.write')" color="primary" prepend-icon="mdi-plus"
         :to="{ name: 'valley-create' }">
    {{ t('valleys.createButton') }}
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
  path: 'data/valleys',
  name: 'valleys',
  component: () => import('@/pages/data/ValleysPage.vue'),     // lazy load, sempre
  meta: { requiresAuth: true, permission: 'valleys.read', title: 'routes.valleys', section: 'data' },
},
{
  path: 'data/valleys/new',
  name: 'valley-create',
  component: () => import('@/pages/data/ValleyDetailPage.vue'),
  meta: { requiresAuth: true, permission: 'valleys.write', title: 'routes.newValley', section: 'data' },
},
{
  path: 'data/valleys/:id(\d+)',
  name: 'valley-detail',
  component: () => import('@/pages/data/ValleyDetailPage.vue'),
  meta: { requiresAuth: true, permission: 'valleys.read', title: 'routes.valleyDetail', section: 'data' },
},
```

Due dettagli:

- **`:id(\d+)`** è il corrispettivo frontend del constraint `{id:int}` del backend: con id numerici,
  la rotta `data/valleys/new` non rischia di essere catturata dalla rotta di dettaglio.
- **Ogni rotta dichiara `meta.permission`**: il navigation guard la usa per bloccare l'accesso diretto
  via URL. Nota che la creazione richiede `valleys.write` mentre il dettaglio richiede `valleys.read`,
  pur essendo lo stesso componente.

Infine i testi, in **entrambe** le lingue (`locales/it.ts` e `locales/en.ts`):

```typescript
// locales/it.ts
nav: { valleys: 'Valli' },
routes: { valleys: 'Valli', newValley: 'Nuova valle', valleyDetail: 'Dettaglio valle' },
valleys: {
  title: 'Valli',
  subtitle: 'Gestione valli',
  createButton: 'Nuova valle',
  deleteConfirm: 'Sei sicuro di voler eliminare questa valle?',
  descIt: 'Descrizione (IT)',
  descEn: 'Descrizione (EN)',
},
errors: { loadValleys: 'Errore nel caricamento valli', deleteValley: 'Errore nell\'eliminazione della valle' },
```

---

## Prima di dire che è finita

- [ ] L'entità ha `int Id`, implementa `ITimestamped` se ha i timestamp, non ha attributi di persistenza
- [ ] La mappatura in `OnModelCreating` c'è, le colonne stringa sono **dimensionate**, le FK sono `Restrict`
- [ ] **Entrambe** le migration sono generate (SqlServer + Postgres) e committate
- [ ] Le query LINQ sono traducibili da entrambi i provider — attenzione a `Contains` su stringa
- [ ] Le rotte con id usano il constraint `{id:int}`
- [ ] Ogni scrittura produce un audit log, con lo snapshot `Before` catturato **prima** della modifica
- [ ] I testi esistono in italiano **e** in inglese
