# Database — decisioni

Le scelte di progetto che conviene non rimettere in discussione a memoria, con il motivo per cui
sono state prese e le condizioni alle quali andrebbero riviste.

> Questa pagina **ribalta** diverse decisioni della versione precedente, documentate in
> [Decisioni (SQL + Mongo)](../database_sql-mongo/decisioni.md). Dove una decisione è stata
> rovesciata, qui sotto è indicato perché.

## Le decisioni attuali

| Decisione presa | Alternativa scartata | Perché |
|---|---|---|
| **Solo database SQL** (SQL Server + PostgreSQL) | Mantenere il supporto MongoDB | Il doppio paradigma costava due implementazioni per ogni repository e vincolava il modello dati al minimo comune denominatore. Sotto, per esteso |
| **Niente strato repository**: gli handler usano `AppDbContext` | Mantenere le 15 interfacce `I*Repository` | Con un solo paradigma di accesso ai dati, le interfacce non astraevano più niente: erano indirezione pura. EF Core **è già** il seam |
| **PK `int` identity** | `ObjectId` come `char(24)`, `Guid`, `bigint` | Caduto il vincolo dual-paradigma, `int` è il default convenzionale e più efficiente. Sotto, per esteso |
| **Un `AppDbContext` astratto + due derivate vuote** | Due DbContext indipendenti, o uno solo con migration condivise | Pattern MS "migrations with multiple providers": EF lega un set di migration a un tipo. Le derivate danno l'identità, il modello resta uno |
| **Snapshot audit come `string` JSON** | Colonna JSON nativa (`json`/`jsonb`) | Una colonna testo è portabile fra i due provider senza codice condizionale e resta interrogabile con `JSON_VALUE`/`OPENJSON` (SQL Server) e con gli operatori JSON (Postgres) |
| **Nessun concurrency token** | `rowversion` / `xmin` | Last-wins, come prima. Scelta consapevole, rivalutabile se servisse davvero |
| **Enum come stringa** | Enum come int | Valore leggibile nel DB e stabile se cambia l'ordine dei membri |

## Perché è caduto MongoDB

Il supporto a MongoDB è stato rimosso a **luglio 2026**. Non è stata una scelta contro Mongo come
database, ma contro il **costo di mantenere due paradigmi diversi** nella stessa applicazione.

### Che cosa costava davvero

- **Due implementazioni per ogni repository.** 15 interfacce × 2 implementazioni: ogni nuova query
  andava scritta due volte, in due linguaggi di accesso ai dati diversi, e verificata due volte.
- **Il modello dati al minimo comune denominatore.** La chiave primaria era `ObjectId` — un tipo
  della libreria di Mongo — anche quando girava su SQL Server, dove diventava un `char(24)`
  innaturale. Le liste di id erano array dentro il documento su Mongo e join table su SQL: quella
  singola differenza generava quasi tutto il lavoro extra del ramo SQL.
- **Astrazioni esistenti solo per la coesistenza.** `ITransactionRunner` con la sessione "ambient"
  in un accessor scoped, `Conversions.cs`, `Links.cs`, `SaveAndDetachAsync` per il bug del change
  tracker: componenti nati per far convivere i due mondi, non per servire il dominio.
- **Funzioni da ricostruire da una parte all'altra.** L'indice TTL di Mongo non esiste su SQL, e ha
  richiesto un `BackgroundService` dedicato — che infatti è rimasto.

### Che cosa si è guadagnato rimuovendolo

Sono spariti interi rami del codice: `Repositories/` (con `Mongo/` ed `Ef/`), `Transactions/`,
`Documents/`, `Conversions.cs`, `Links.cs`. Gli handler sono diventati più corti e più diretti: una
query LINQ che proietta sul response, senza passare da un'interfaccia che non astrae più niente.

E soprattutto: **il modello dati ha smesso di essere un compromesso**. Chiavi intere, FK vere,
cascade dichiarativa nel database invece che scritta a mano negli handler.

### Che cosa si è perso

Va detto con onestà: si è persa la possibilità di installare l'applicazione su MongoDB. Se un domani
servisse — perché un cliente ha solo quello — la strada non sarebbe reintrodurre il vecchio doppio
supporto, ma valutare il provider EF Core per MongoDB, che nel frattempo è maturato. Il modello EF
oggi è unico e pulito: sarebbe un punto di partenza migliore di quello di allora.

## Perché la chiave primaria è `int` identity

Questa è la decisione **ribaltata** rispetto alla versione precedente, dove la PK era `ObjectId`
salvato come `char(24)`. Vale la pena spiegare perché il ribaltamento è coerente e non un
ripensamento.

### La vecchia decisione era condizionata, e lo diceva

La documentazione dell'epoca chiudeva l'analisi con una condizione esplicita:

> *"Se l'applicazione diventasse **solo SQL Server**, greenfield, senza Mongo: lì `int IDENTITY` — o
> `bigint` — è un default eccellente e convenzionale per un gestionale, perché sparisce il vincolo
> del modello condiviso."*

È esattamente quello che è successo. `ObjectId` non era stato scelto perché migliore in assoluto: era
il **minimo comune denominatore** fra i due provider, dato che Mongo non ha auto-increment nativo e
il modello POCO era condiviso. Caduto Mongo, è caduto il vincolo.

### I vantaggi che ora si incassano

- **Storage compatto**: 4 byte contro 24. In SQL Server la chiave del clustered index viene copiata
  dentro *ogni* indice non-clustered, quindi una PK stretta alleggerisce tutti gli indici.
- **Insert sequenziali**: essendo monotòni, niente page split da chiavi casuali.
- **Join più veloci**: confronto fra interi invece che fra stringhe con collation.
- **Leggibilità operativa**: `WHERE Id = 1042` è comodo da digitare e da citare in un ticket.
- **Convenzione di casa**: è ciò che ogni DBA si aspetta, su entrambi i provider.

### I costi che si sono accettati

Sono reali e vanno conosciuti:

- **L'id lo genera il database**, quindi lo si conosce solo *dopo* l'`INSERT`. Conseguenza pratica
  visibile ovunque: gli handler di creazione fanno **due** `SaveChangesAsync`, perché l'audit log ha
  bisogno dell'id. Nel seed, i legami si esprimono via navigation property invece che con id
  costanti.
- **Enumerabilità**: `/users/1`, `/users/2`… sono indovinabili. Espone al scraping sequenziale e al
  rischio IDOR **se un controllo di autorizzazione fosse debole** — per questo ogni endpoint è
  protetto da una policy sui permessi, che è la difesa vera. Espone anche informazioni di business
  (quanti utenti hai).
- **Non globalmente unici**: unire due database o generare id offline richiederebbe una sequence
  centrale. Non è uno scenario previsto.
- **Collisioni fra ambienti**: replicare dati fra sviluppo e produzione è meno immediato.

Il primo costo è strutturale e si vede nel codice tutti i giorni. Gli altri tre sono accettabili in
un gestionale di catalogo con endpoint autenticati e permessi granulari.

### Perché non `bigint`

`int` arriva a ~2,1 miliardi di righe. DelVoltone è un catalogo — prodotti, località, formati,
utenti, più i log — e non si avvicina neanche lontanamente a quel limite. Se una tabella di log
dovesse crescere oltre le previsioni, la si può migrare a `bigint` singolarmente: è una migration
mirata, non una decisione da prendere adesso per tutte le tabelle.

| Tipo di chiave | Byte | Note |
|---|---:|---|
| **`int` identity** | 4 | **Scelta attuale**: limite ~2,1 miliardi di righe |
| `bigint` identity | 8 | Se una singola tabella dovesse superare il limite |
| `ObjectId` come `binary(12)` | 12 | Variante ottimizzata della vecchia scelta |
| `uniqueidentifier` (Guid) | 16 | Casuale → frammentazione degli indici |
| `ObjectId` come `char(24)` | 24 | La **vecchia** scelta, legata al vincolo dual-provider |

### Quando andrebbe rivista

Se servisse esporre identificativi **non enumerabili** verso l'esterno — per esempio aprendo una
parte delle API a un pubblico non autenticato — la strada non sarebbe tornare a `ObjectId` come PK,
ma aggiungere una colonna **chiave pubblica** (`Guid` o slug, unique) accanto alla PK intera,
lasciando le FK interne su `int`.

## Perché niente strato repository

Nella versione dual-paradigma le interfacce `I*Repository` erano il seam: cambiare provider
significava cambiare quali classi le implementavano. Con due provider **entrambi SQL ed entrambi su
EF Core**, quella funzione è scomparsa — l'astrazione sarebbe stata un'interfaccia con una sola
implementazione, cioè indirezione pura.

`AppDbContext` è già il punto di astrazione: è `abstract`, è provider-agnostico, e la DI decide quale
derivata iniettare. Gli handler dipendono da lui e non sanno quale database c'è sotto — esattamente
la garanzia che prima davano le interfacce, senza il codice da mantenere.

**Il rovescio della medaglia**, da tenere presente: la portabilità fra provider non è più garantita
dal tipo, ma dalla **disciplina nello scrivere query LINQ traducibili da entrambi**. Il caso concreto
è `Contains` su stringa, case-insensitive su SQL Server e case-sensitive su PostgreSQL. È il motivo
per cui le email si salvano in minuscolo, ed è il controllo da fare su ogni nuova query di ricerca.

## Perché due provider SQL, e non uno solo

Si potrebbe obiettare che, avendo rimosso Mongo per semplificare, la conclusione coerente sarebbe
stata restare su un solo database. La differenza è nel **costo di mantenimento**, che qui è quasi
nullo: SQL Server e PostgreSQL condividono lo **stesso identico modello EF** e lo stesso codice
applicativo. Le uniche cose che raddoppiano sono i file di migration — generati automaticamente — e
`DatabaseStats`, che è un file per provider.

Non era così con Mongo, dove a raddoppiare era ogni singola query.

Il beneficio è concreto: SQL Server per le installazioni on-premise standardizzate, PostgreSQL per
l'hosting cloud a basso costo, senza toccare il codice.

## Approfondimenti

- **[Architettura](architettura.md)** — la struttura che queste decisioni hanno prodotto
- **[Implementazione](implementazione.md)** — il codice, con i punti in cui le decisioni si vedono
