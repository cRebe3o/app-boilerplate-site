# Infrastruttura — decisioni

Le scelte di progetto che conviene non rimettere in discussione a memoria, con il motivo per cui
sono state prese e le condizioni alle quali andrebbero riviste.

In un template contano più che altrove: una decisione presa qui si propaga a ogni progetto che ne
nasce, e cambiarla dopo significa cambiarla in tutti.

## Le decisioni in breve

| Decisione presa | Alternativa scartata | Perché |
|---|---|---|
| **Due provider SQL** (SQL Server + PostgreSQL) | Un solo database | Il provider lo decide il cliente del progetto, non chi scrive il template. Il costo di supportarli entrambi è quasi nullo: stesso modello EF, cambia il driver |
| **Niente strato repository**: gli handler usano `AppDbContext` | Interfacce `I*Repository` con implementazioni per provider | Con due provider entrambi su EF Core, le interfacce non astrarrebbero nulla: sarebbero indirezione pura. `AppDbContext` **è già** il seam |
| **PK `int` identity** | `Guid`, `bigint`, chiavi naturali | Default convenzionale, compatto ed efficiente su entrambi i provider. Sotto, per esteso |
| **Un `AppDbContext` astratto + due derivate vuote** | Due DbContext indipendenti, o uno solo con migration condivise | Pattern MS "migrations with multiple providers": EF lega un set di migration a un tipo. Le derivate danno l'identità, il modello resta uno |
| **Vertical slice** invece di livelli tecnici | Controller / Service / Repository | Una feature si legge e si cancella in una cartella sola. Su un template conta doppio: l'aggiunta di codice è l'operazione più frequente |
| **Snapshot audit come `string` JSON** | Colonna JSON nativa (`json`/`jsonb`) | Una colonna testo è portabile fra i due provider senza codice condizionale e resta interrogabile con `JSON_VALUE`/`OPENJSON` (SQL Server) e con gli operatori JSON (Postgres) |
| **Nessun concurrency token** | `rowversion` / `xmin` | Last-wins. Scelta consapevole, da rivalutare in un progetto con scritture concorrenti sulla stessa riga |
| **Enum come stringa** | Enum come int | Valore leggibile nel DB e stabile se cambia l'ordine dei membri |
| **Nessuna migration nel template** | Un `InitialCreate` già pronto | Una migration committata nel template vincolerebbe ogni progetto generato. La prima è il primo file di storia del progetto |

## Perché due provider SQL

La domanda legittima è l'opposto: perché non sceglierne uno e semplificare?

Perché un template non conosce il proprio contesto di installazione. Molte organizzazioni sono
standardizzate su **SQL Server** — DBA, backup, procedure di ripristino, competenze già in casa.
Altre, soprattutto in cloud e in hosting a basso costo, hanno **PostgreSQL**. Un boilerplate che ne
supporta uno solo esclude a priori metà dei progetti possibili, per un motivo che non è tecnico ma
organizzativo.

Quello che rende la scelta sostenibile è il **costo di mantenimento**, che qui è quasi nullo: i due
provider condividono lo **stesso identico modello EF** e lo stesso codice applicativo. Le uniche
cose che raddoppiano sono:

- i file di **migration**, che però sono generati automaticamente;
- `DatabaseStats`, che è **un file per provider** — l'unico punto dell'applicazione con SQL
  provider-specifico.

Il prezzo non è zero, però, ed è bene sapere dove si paga: la portabilità non è garantita dal
compilatore, ma dalla **disciplina nello scrivere query LINQ traducibili da entrambi**. Il caso
concreto è `Contains` su stringa, case-insensitive su SQL Server e case-sensitive su PostgreSQL.
È il motivo per cui l'username di login si salva in minuscolo, ed è il controllo da fare su ogni
nuova query di ricerca.

## Perché niente strato repository

Un'interfaccia `IUserRepository` con una sola implementazione non astrae niente: aggiunge un file,
un livello di indirezione e un punto in cui il codice può divergere dal modello, senza dare in
cambio la libertà di sostituire l'implementazione.

Il seam c'è già, ed è `AppDbContext`: è `abstract`, è provider-agnostico, e la DI decide quale
derivata iniettare. Gli handler dipendono da lui e non sanno quale database c'è sotto — esattamente
la garanzia che darebbero le interfacce, senza il codice da mantenere.

Che cosa si guadagna concretamente:

```csharp
// Un handler di lettura, per intero.
public class GetGroupsHandler(AppDbContext db) : IRequestHandler<GetGroupsQuery, List<GroupResponse>>
{
    public Task<List<GroupResponse>> Handle(GetGroupsQuery request, CancellationToken ct) =>
        db.Set<Group>()
            .Select(g => new GroupResponse(g.Id, g.Name, g.Description))
            .ToListAsync(ct);
}
```

Con uno strato repository la stessa lettura richiederebbe un metodo nell'interfaccia, la sua
implementazione, e comunque questo handler — che a quel punto si limiterebbe a inoltrare la
chiamata.

**Quando andrebbe rivista.** Se il progetto dovesse accedere a una sorgente dati che non è EF Core
— un servizio esterno, una coda, un database non relazionale — quella sorgente merita la propria
astrazione. Il punto non è "mai interfacce": è non introdurre un'interfaccia dove esiste una sola
implementazione possibile.

## Perché la chiave primaria è `int` identity

### I vantaggi che si incassano

- **Storage compatto**: 4 byte. In SQL Server la chiave del clustered index viene copiata dentro
  *ogni* indice non-clustered, quindi una PK stretta alleggerisce tutti gli indici.
- **Insert sequenziali**: essendo monotòni, niente page split da chiavi casuali — il difetto
  classico dei `Guid` come chiave clusterizzata.
- **Join più veloci**: confronto fra interi invece che fra stringhe con collation.
- **Leggibilità operativa**: `WHERE Id = 1042` è comodo da digitare e da citare in un ticket.
- **Convenzione di casa**: è ciò che ogni DBA si aspetta, su entrambi i provider.

### I costi che si sono accettati

Sono reali e vanno conosciuti:

- **L'id lo genera il database**, quindi lo si conosce solo *dopo* l'`INSERT`. Conseguenza pratica
  visibile ovunque: gli handler di creazione fanno **due** `SaveChangesAsync`, perché l'audit log ha
  bisogno dell'id. Nel seed, i legami si esprimono via navigation property invece che con id
  costanti.
- **Enumerabilità**: `/users/1`, `/users/2`… sono indovinabili. Espone allo scraping sequenziale e al
  rischio IDOR **se un controllo di autorizzazione fosse debole** — per questo ogni endpoint è
  protetto da una policy sui permessi, che è la difesa vera. Espone anche informazioni di business
  (quanti utenti hai).
- **Non globalmente unici**: unire due database o generare id offline richiederebbe una sequence
  centrale. Non è uno scenario previsto dal template.
- **Collisioni fra ambienti**: replicare dati fra sviluppo e produzione è meno immediato.

Il primo costo è strutturale e si vede nel codice tutti i giorni. Gli altri tre sono accettabili in
un gestionale con endpoint autenticati e permessi granulari — che è esattamente il profilo di
applicazione per cui il template esiste.

### Perché non `bigint`

`int` arriva a ~2,1 miliardi di righe: un gestionale interno non si avvicina neanche lontanamente a
quel limite. Se una tabella di log dovesse crescere oltre le previsioni, la si può migrare a
`bigint` singolarmente — è una migration mirata, non una decisione da prendere adesso per tutte le
tabelle.

| Tipo di chiave | Byte | Note |
|---|---:|---|
| **`int` identity** | 4 | **Scelta attuale**: limite ~2,1 miliardi di righe |
| `bigint` identity | 8 | Se una singola tabella dovesse superare il limite |
| `uniqueidentifier` (Guid) | 16 | Casuale → frammentazione degli indici |

### Quando andrebbe rivista

Se servisse esporre identificativi **non enumerabili** verso l'esterno — per esempio aprendo una
parte delle API a un pubblico non autenticato — la strada non sarebbe cambiare la PK, ma aggiungere
una colonna **chiave pubblica** (`Guid` o slug, unique) accanto alla PK intera, lasciando le FK
interne su `int`.

## Perché il template non contiene migration

Le cartelle `Migrations/SqlServer` e `Migrations/Postgres` nascono **vuote**, e il primo comando che
si esegue in un progetto nuovo genera l'`InitialCreate`.

È deliberato. Una migration committata nel template sarebbe **immutabile per sempre** in ogni
progetto generato: il primo file di storia dello schema, scritto da qualcun altro, in un momento in
cui il modello del template poteva essere diverso da quello che il progetto riceve. Peggio, un
`copier update` che modificasse le entità dovrebbe poi riconciliare migration già applicate su
database reali.

Generandola nel progetto, invece, la prima migration riflette esattamente il modello ricevuto ed è
il primo commit di una storia che appartiene al progetto.

**Il prezzo**: è un passaggio in più da ricordare dopo la generazione, e se lo si dimentica
l'applicazione parte con un database senza schema. Per questo compare nei task post-generazione,
nel README del progetto e in [Generare e aggiornare](../progetto/generazione.md).

## Perché vertical slice

Il criterio non è estetico: è il costo dell'operazione più frequente.

In un'architettura a livelli, aggiungere un'operazione significa toccare quattro file in quattro
cartelle diverse — e cancellarla significa ricordarsi di tutti e quattro. In vertical slice
l'operazione **è** una cartella: si crea, si legge e si elimina in un posto solo.

Per un template il vantaggio è doppio, perché rende meccanico ciò che deve accadere in ogni
progetto: aggiungere feature. È anche il motivo per cui le [skill](../progetto/skill.md) possono
scaffoldare una slice in modo affidabile — c'è una forma sola, ripetuta.

**Il rovescio**: c'è più ripetizione fra slice simili di quanta ne avrebbe un service condiviso, e
la tentazione di estrarre "il metodo comune" arriva presto. La regola del template è resistere
finché la ripetizione non è **identica e stabile**: la duplicazione fra due slice è quasi sempre
apparente, e il service condiviso estratto troppo presto diventa il punto in cui le feature si
accoppiano di nuovo.

## Approfondimenti

- **[Architettura](architettura.md)** — la struttura che queste decisioni hanno prodotto
- **[Implementazione](implementazione.md)** — il codice, con i punti in cui le decisioni si vedono
