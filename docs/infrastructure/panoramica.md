# Infrastruttura — panoramica

L'impianto tecnico che un progetto generato ha già montato: dove finiscono i dati, come attraversa
il sistema una richiesta, che cosa succede all'avvio. È la parte che non si riscrive per ogni
progetto, ed è la ragione per cui il template esiste.

## In una frase

L'applicazione salva i propri dati su **SQL Server** oppure su **PostgreSQL**, tramite **Entity
Framework Core**: la scelta si fa in configurazione, senza modificare una riga di codice
applicativo.

| Provider | Come | Note |
|---|---|---|
| **SQL Server** | EF Core (`Microsoft.EntityFrameworkCore.SqlServer`) | Default se `Database:Provider` non è specificato |
| **PostgreSQL** | EF Core (`Npgsql.EntityFrameworkCore.PostgreSQL`) | Si attiva con `Database:Provider=PostgreSQL` |

Un valore diverso da `SqlServer` o `PostgreSQL` fa fallire l'avvio con un messaggio esplicito: un
errore di configurazione deve fermarsi subito, non a metà di una richiesta.

## Perché due provider SQL

- **Flessibilità di installazione.** Molte organizzazioni sono standardizzate su SQL Server — DBA,
  backup, procedure di ripristino, competenze. Altre, soprattutto in cloud e in hosting a basso
  costo, hanno PostgreSQL. Poter installare l'applicazione in entrambi i mondi elimina un ostacolo
  che non è tecnico ma organizzativo.
- **Libertà di hosting.** SQL Server on-premise oggi, Postgres gestito su Render o Azure domani,
  senza riscrivere nulla.
- **Costo quasi nullo.** I due provider condividono **lo stesso identico modello EF Core**: cambia
  solo il driver e il set di migration. Non ci sono due implementazioni da mantenere in parallelo.

Per un template è un requisito quasi obbligato: il provider giusto non lo decide chi scrive il
boilerplate, lo decide il cliente del progetto che ne nascerà.

## Come si sceglie

La variabile `db_provider` risposta alla generazione imposta il valore iniziale, ma resta una
normale voce di configurazione:

```json
{
  "Database": { "Provider": "SqlServer" },
  "ConnectionStrings": {
    "SqlServer": "Server=.;Database=MioProgetto;Trusted_Connection=True;TrustServerCertificate=True",
    "PostgreSQL": "Host=localhost;Database=mioprogetto;Username=postgres;Password=postgres"
  }
}
```

| Valore di `Database:Provider` | Effetto |
|---|---|
| `SqlServer` | SQL Server via EF Core |
| `PostgreSQL` | PostgreSQL via EF Core (Npgsql) |
| *chiave assente* | Default `SqlServer` |
| *qualsiasi altro valore* | Errore esplicito **all'avvio**, con i valori ammessi nel messaggio |

In sviluppo i segreti vanno in `appsettings.local.json` (gitignored), che vince su
`appsettings.json`. In produzione non si toccano i file: si usano le variabili d'ambiente, dove il
doppio underscore separa le sezioni. Una variabile d'ambiente vince su tutto.

```bash
Database__Provider=PostgreSQL
ConnectionStrings__PostgreSQL="Host=…;Database=mioprogetto;Username=…;Password=…;SSL Mode=Require"
```

## Che cosa non cambia fra i due provider

Cambiando provider non cambia **niente di visibile**:

- **Le funzionalità**: accesso, utenti e permessi, audit, configurazione, monitoraggio.
- **Le API e il frontend**: gli identificativi sono **numeri interi** su entrambi; il frontend non sa
  quale database ci sia sotto, e non deve saperlo.
- **Le regole sul seed**: i dati iniziali vengono creati **solo se il database è vuoto** (basta che
  esista un solo ruolo perché il seeder esca subito). Mai una cancellazione, mai un reseed automatico.
- **L'audit**: ogni scrittura produce lo stesso record, con gli snapshot prima/dopo in JSON.

## Come funziona, in parole semplici

```
        Handler MediatR (la logica di business)
                    │
                    │  unica dipendenza: AppDbContext
                    ▼
         AppDbContext (abstract, provider-agnostico)
         tutto il model config vive qui
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
 SqlServerAppDbContext   PostgresAppDbContext
   (derivata vuota)        (derivata vuota)
          │                   │
   Migrations/SqlServer  Migrations/Postgres
          │                   │
          ▼                   ▼
      SQL Server          PostgreSQL
```

1. **Un solo modello dati.** Le entità POCO in `Entities/` valgono per entrambi i provider.
2. **Un solo `AppDbContext`.** È `abstract` e contiene **tutta** la configurazione del modello
   (`OnModelCreating`): tabelle, lunghezze colonne, indici, relazioni.
3. **Due derivate vuote.** `SqlServerAppDbContext` e `PostgresAppDbContext` non aggiungono nulla:
   esistono **solo** per separare i due set di migration (è il pattern Microsoft "migrations with
   multiple providers").
4. **Uno switch all'avvio.** `AddDatabase` legge `Database:Provider` e registra la derivata giusta
   dietro il tipo `AppDbContext`.

Chi scrive un handler inietta `AppDbContext` e non sa quale dei due sta girando.

## La pipeline di una richiesta

La persistenza è metà del quadro. L'altra metà è il percorso che ogni richiesta compie, uguale per
tutte le feature:

```
HTTP
 │
 ├─ UseForwardedHeaders     IP e schema reali del client, prima di chiunque li legga
 ├─ UseCors                 preflight OPTIONS
 ├─ ExceptionHandling       ogni eccezione → ProblemDetails (RFC 7807)
 ├─ RateLimiter             partizionato per IP
 ├─ RequestLocalization     Accept-Language → it | en
 ├─ Authentication          JWT Bearer (+ Negotiate su /windows-login)
 └─ Authorization           policy sui claim "permissions"
      │
      ▼
   Endpoint (solo routing)  →  IMediator.Send(comando)
                                   │
                                   ├─ LoggingBehavior      durata ed esito
                                   ├─ ValidationBehavior   FluentValidation → 400
                                   └─ Handler              la logica, qui e solo qui
                                        │
                                        └─ AppDbContext
```

Le tre regole che discendono da questo schema, e che valgono per ogni feature aggiunta dopo:

- **Gli endpoint non contengono logica.** Instradano e dichiarano il permesso richiesto.
- **I validator non si invocano.** Il `ValidationBehavior` li trova da sé: se la validazione
  fallisce, l'handler non viene mai raggiunto.
- **Le eccezioni non si catturano negli handler.** Si lancia `NotFoundException`,
  `ConflictException` e simili; il middleware le traduce in risposte HTTP coerenti.

## L'avvio

| Passo | Che cosa succede |
|---|---|
| **Schema** | `Database.MigrateAsync()` applica le migration mancanti del provider attivo e crea il database se non esiste. Mai `EnsureCreated`, mai drop |
| **Seed** | `SeedAsync()`: popola **solo uno store vuoto**. Se esiste anche un solo ruolo, esce subito |

Il seed crea i 18 permessi di sistema, quattro ruoli (`SuperAdmin`, `Admin`, `Viewer`, `Custom`),
due gruppi e gli utenti iniziali. Gira **dentro una transazione**: senza, un'interruzione a metà
lascerebbe dati parziali che il gate al riavvio non riconoscerebbe come "database già popolato".

> **Regola operativa**: non esiste wipe né reseed automatico. Per ripartire da zero il database si
> droppa a mano.

## Che cosa cambia per chi sviluppa

**Niente strato repository.** Gli handler iniettano `AppDbContext` e usano `db.Set<Entità>()` con
LINQ. Le letture proiettano direttamente sul response record — niente tracking, niente mapping
intermedio:

```csharp
var items = await db.Set<Group>()
    .AsNoTracking()
    .Select(g => new GroupResponse(g.Id, g.Name, g.Description))
    .ToListAsync(ct);
```

**Una nuova entità richiede due migration**, una per provider:

```bash
dotnet dotnet-ef migrations add <Nome> --context SqlServerAppDbContext --output-dir Features/_Shared/Persistence/Migrations/SqlServer
dotnet dotnet-ef migrations add <Nome> --context PostgresAppDbContext  --output-dir Features/_Shared/Persistence/Migrations/Postgres
```

Il percorso completo, passo per passo, è nella pagina
[Aggiungere una feature](../guide/nuova-feature.md).

La regola da non violare mai: **ogni query LINQ deve essere traducibile da entrambi i provider**.
Le uniche query provider-specifiche ammesse vivono in `DatabaseStats/`, dietro un'interfaccia.

⚠️ **Trappola nota**: `Contains` su stringa è **case-insensitive su SQL Server** (per la collation
di default) e **case-sensitive su PostgreSQL**. Per questo l'username di login si salva in minuscolo
e si confronta con input già normalizzato.

## Domande frequenti

**Posso usare i due database contemporaneamente?**
No. Un'istanza dell'applicazione usa un solo provider; lo switch è globale, non per entità.
Istanze diverse possono usare provider diversi.

**Ho scelto `SqlServer` alla generazione: posso passare a PostgreSQL?**
Sì, ed è il punto di questa architettura. Si cambia `Database:Provider` e la connection string
corrispondente. Il codice generato supporta entrambi in ogni caso.

**Posso migrare i dati da SQL Server a PostgreSQL, o viceversa?**
Non con gli strumenti inclusi. Lo schema è equivalente sui due provider, quindi un export/import è
fattibile, ma è un lavoro a sé.

**Serve creare lo schema a mano?**
No, ma le **migration vanno generate una volta**, alla nascita del progetto: il template non ne
contiene (vedi [Generare e aggiornare](../progetto/generazione.md)). Da lì in poi si applicano da
sole all'avvio con `MigrateAsync()`, che crea anche il database se non esiste.

**`MigrateAsync` crea sempre il database?**
Solo dove l'utente ha il permesso di farlo. Dietro un connection pooler — Neon, per esempio, che
espone host `*-pooler` — la `CREATE DATABASE` non è consentita e il login viene rifiutato: in quel
caso il database va creato a monte.

## Approfondimenti

- **[Architettura](architettura.md)** — il modello EF, lo schema relazionale, i due set di migration
- **[Implementazione](implementazione.md)** — il codice: switch, `AppDbContext`, pipeline, handler, seed
- **[Decisioni](decisioni.md)** — perché la chiave primaria è `int`, perché niente repository
