# Database — panoramica

> **Stato: implementato.** Da luglio 2026 DelVoltone si collega **esclusivamente a database SQL**.
> Il supporto a MongoDB è stato rimosso. La versione precedente della documentazione è conservata,
> come storico, in [Database (SQL + Mongo)](../database_sql-mongo/panoramica.md).

## In una frase

DelVoltone salva i propri dati su **SQL Server** oppure su **PostgreSQL**, tramite **Entity Framework
Core**: la scelta si fa in configurazione, senza modificare una riga di codice applicativo.

| Provider | Come | Note |
|---|---|---|
| **SQL Server** | EF Core (`Microsoft.EntityFrameworkCore.SqlServer`) | Default se `Database:Provider` non è specificato |
| **PostgreSQL** | EF Core (`Npgsql.EntityFrameworkCore.PostgreSQL`) | Si attiva con `Database:Provider=PostgreSQL` |

**MongoDB non è più supportato.** Non esiste un provider Mongo, né una via di configurazione per
attivarlo: un valore diverso da `SqlServer` o `PostgreSQL` fa fallire l'avvio con un messaggio
esplicito.

## Perché due provider SQL

- **Flessibilità di installazione.** Molte organizzazioni sono standardizzate su SQL Server — DBA,
  backup, procedure di ripristino, competenze. Altre, soprattutto in cloud e in hosting a basso
  costo, hanno PostgreSQL. Poter installare l'applicazione in entrambi i mondi elimina un ostacolo
  che non è tecnico ma organizzativo.
- **Libertà di hosting.** SQL Server on-premise oggi, Postgres gestito su Render o Azure domani,
  senza riscrivere nulla.
- **Costo quasi nullo.** A differenza del vecchio doppio supporto Mongo/SQL, qui i due provider
  condividono **lo stesso identico modello EF Core**: cambia solo il driver e il set di migration.
  Non ci sono due implementazioni da mantenere in parallelo.

## Come si sceglie

```json
{
  "Database": { "Provider": "SqlServer" },
  "ConnectionStrings": {
    "SqlServer": "Server=.;Database=DelVoltone;Trusted_Connection=True;TrustServerCertificate=True",
    "PostgreSQL": "Host=localhost;Database=delvoltone;Username=postgres;Password=postgres"
  }
}
```

| Valore di `Database:Provider` | Effetto |
|---|---|
| `SqlServer` | SQL Server via EF Core |
| `PostgreSQL` | PostgreSQL via EF Core (Npgsql) |
| *chiave assente* | Default `SqlServer` |
| *qualsiasi altro valore* (compreso `MongoDB`) | Errore esplicito **all'avvio**, con i valori ammessi nel messaggio |

In sviluppo i segreti vanno in `appsettings.local.json` (gitignored), che vince su `appsettings.json`.
In produzione non si toccano i file: si usano le variabili d'ambiente, dove il doppio underscore
separa le sezioni. Una variabile d'ambiente vince su tutto.

```bash
Database__Provider=PostgreSQL
ConnectionStrings__PostgreSQL="Host=…;Database=delvoltone;Username=…;Password=…;SSL Mode=Require"
```

## Che cosa non cambia fra i due provider

Cambiando provider non cambia **niente di visibile**:

- **Le funzionalità**: accesso, utenti e permessi, catalogo, ricerca, audit, export, monitoraggio.
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

## Che cosa cambia per chi sviluppa

**Niente strato repository.** Gli handler iniettano `AppDbContext` e usano `db.Set<Entità>()` con
LINQ. Le letture proiettano direttamente sul response record — niente tracking, niente mapping
intermedio:

```csharp
var items = await db.Set<Format>()
    .AsNoTracking()
    .Select(f => new FormatResponse(f.Id, f.DescIt, f.DescEn, f.Order))
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
di default) e **case-sensitive su PostgreSQL**. Per questo le email si salvano in minuscolo e si
confrontano con input già normalizzato in minuscolo.

## Domande frequenti

**Posso usare i due database contemporaneamente?**
No. Un'istanza dell'applicazione usa un solo provider; lo switch è globale, non per entità.
Istanze diverse possono usare provider diversi.

**Posso ancora usare MongoDB?**
No. Il provider è stato rimosso dal codice. La documentazione storica è in
[Database (SQL + Mongo)](../database_sql-mongo/panoramica.md), ma descrive codice che non esiste più.

**Posso migrare i dati da SQL Server a PostgreSQL, o viceversa?**
Non con gli strumenti inclusi. Lo schema è equivalente sui due provider, quindi un export/import è
fattibile, ma è un lavoro a sé.

**Serve creare lo schema a mano?**
No. Le migration si applicano da sole all'avvio con `MigrateAsync()`, che crea anche il database se
non esiste. Mai `EnsureCreated`, mai drop automatici.

**Che fine hanno fatto gli id `ObjectId` di 24 caratteri?**
Sostituiti da `int` identity, assegnati dal database. Il perché è in [Decisioni](decisioni.md).

## Approfondimenti

- **[Architettura](architettura.md)** — il modello EF, lo schema relazionale, i due set di migration
- **[Implementazione](implementazione.md)** — il codice: switch, `AppDbContext`, handler, seed
- **[Decisioni](decisioni.md)** — perché la chiave primaria è `int`, perché è caduto Mongo
