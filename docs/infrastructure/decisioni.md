# Infrastruttura — decisioni

Le scelte di progetto che conviene non rimettere in discussione a memoria, con il motivo per cui
sono state prese e le condizioni alle quali andrebbero riviste.

In un template contano più che altrove: una decisione presa qui si propaga a ogni progetto che ne
nasce, e cambiarla dopo significa cambiarla in tutti.

## Le decisioni in breve

| Decisione presa | Alternativa scartata | Perché |
|---|---|---|
| **Due provider SQL** (SQL Server + PostgreSQL) | Un solo database | Il provider lo decide il cliente del progetto, non chi scrive il template. Il costo di supportarli entrambi è quasi nullo: stesso modello EF, cambia il driver |
| **Clean Architecture** in quattro progetti | Un solo progetto a vertical slice | Il dominio ha invarianti veri da proteggere: separarlo rende le regole non aggirabili e testabili senza infrastruttura. Sotto, per esteso |
| **Repository sulle scritture, `IQueryable` sulle letture** | Repository per tutto, oppure `AppDbContext` per tutto | I repository proteggono gli invarianti degli aggregati; una lettura non ha invarianti da proteggere. Sotto, per esteso |
| **PK `int` identity** | `Guid`, `bigint`, chiavi naturali | Default convenzionale, compatto ed efficiente su entrambi i provider. Sotto, per esteso |
| **Un `AppDbContext` astratto + due derivate vuote** | Due DbContext indipendenti, o uno solo con migration condivise | Pattern MS "migrations with multiple providers": EF lega un set di migration a un tipo. Le derivate danno l'identità, il modello resta uno |
| **Slice per caso d'uso dentro `Application`** | Livelli tecnici (Controller / Service / Repository) | Una feature si legge e si cancella in una cartella sola. La Clean Architecture riguarda i confini fra layer, non impone di organizzare i casi d'uso per tipo tecnico |
| **Snapshot audit come `string` JSON** | Colonna JSON nativa (`json`/`jsonb`) | Una colonna testo è portabile fra i due provider senza codice condizionale e resta interrogabile con `JSON_VALUE`/`OPENJSON` (SQL Server) e con gli operatori JSON (Postgres) |
| **Concurrency token `Guid` applicativo** | `rowversion` (SQL Server) / `xmin` (Postgres) | I token nativi hanno tipi e semantiche diverse sui due provider: un `Guid` rigenerato da un interceptor si comporta identico su entrambi |
| **Enum come stringa** | Enum come int | Valore leggibile nel DB e stabile se cambia l'ordine dei membri |
| **`InitialCreate` inclusa nel template** | Cartelle `Migrations` vuote, prima migration generata nel progetto | Lo schema dell'impianto è identico per ogni progetto: rigenerarlo produce lo stesso file. Le migration del dominio restano del progetto |

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

## Perché Clean Architecture

Il template è nato **a vertical slice**, con gli handler che iniettavano `AppDbContext`
direttamente. Era una scelta difendibile, e per un CRUD lo è ancora: meno file, meno salti, un solo
progetto.

È cambiata quando il dominio ha iniziato ad avere **regole vere**. Un'applicazione che si limita a
scrivere righe non ha invarianti da proteggere; una che deve garantire che *un'attrezzatura non
venga noleggiata due volte negli stessi giorni*, o che *il totale di un contratto corrisponda sempre
alle sue righe*, sì. E un invariante vale solo se **non è aggirabile da nessuna strada**.

Con la logica negli handler, la garanzia dura finché tutti passano da quell'handler. Basta un
import massivo, una seconda API, un job notturno — e la regola c'è ancora, ma qualcuno le è passato
accanto. Non produce un errore: produce numeri leggermente sbagliati, mesi dopo.

Separando i layer, la regola sta **nel tipo**: `RentalContract.TotalAmount` è calcolato, non
impostabile; le righe si aggiungono solo con `AddLine`, che verifica lo stato. Non c'è modo di
costruire un contratto incoerente, da nessuna strada.

Che cosa si guadagna, in concreto:

- **Testabilità senza infrastruttura.** `<Progetto>.Domain.Tests` non ha database né mock: gli
  oggetti si costruiscono e si interrogano.
- **Le regole hanno un posto solo**, e chi legge il codice sa dove cercarle.
- **I dettagli restano sostituibili.** I due provider SQL convivono perché nessun layer interno sa
  quale sia attivo.

Che cosa costa, e va detto:

- **Più file.** Una lettura banale richiede comando, handler, response ed endpoint; una scrittura
  aggiunge il metodo sul repository e la sua implementazione.
- **Più salti per capire un flusso**, perché un'interfaccia va seguita fino all'implementazione.
- **Disciplina**: la tentazione di iniettare `AppDbContext` "solo stavolta" arriva presto. È il
  motivo per cui i test di architettura esistono e fanno fallire la build.

**Quando non conviene.** Se il progetto è un CRUD anagrafico senza invarianti, questa struttura è
sovrastruttura. È anche il motivo per cui, nel template, le anagrafiche restano sottili: il dominio
si irrobustisce dove ci sono regole, non per uniformità.

Il dettaglio operativo è nella sezione [Architettura](../architettura/clean-architecture.md).

## Perché i repository solo sulle scritture

La scelta meno ovvia del backend: i **comandi** passano da `I{Aggregato}Repository`, le **query** da
`IReadDbContext`, che espone `IQueryable`. Due strade diverse per lo stesso database.

La ragione è che i repository servono a **proteggere gli invarianti**, e una lettura non ha
invarianti da proteggere. Una query proietta verso un DTO: non ricostruisce il modello di dominio,
quindi non c'è nulla da aggirare.

Farle passare comunque da un repository costerebbe, senza dare nulla in cambio. Una griglia con
ricerca, cinque filtri e ordinamento su otto colonne diventerebbe o una firma con dodici parametri,
o un metodo per ogni combinazione — oppure si materializzerebbero gli aggregati interi per
proiettare in memoria, caricando colonne inutili come `PasswordHash`.

Il prezzo di questa asimmetria è dichiarato: `<Progetto>.Application` referenzia **l'assembly base
di EF Core** (per `IQueryable`), pur non referenziando nessun provider. È scritto nel `.csproj` come
scelta consapevole, ed è verificato da un test di architettura:

| Riferimento in `Application` | Ammesso |
|---|---|
| `Microsoft.EntityFrameworkCore` (assembly base) | Sì — serve per `IQueryable` |
| `Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.*` | No — legherebbero a un database preciso |
| `Microsoft.AspNetCore.*` | No — l'utente della richiesta arriva da `ICurrentUser` |

**Quando andrebbe rivista.** Se le query diventassero abbastanza complesse da meritare un modello di
lettura separato — viste materializzate, un database di reporting — allora la strada sarebbe un vero
read model, non un repository in mezzo.

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

- **L'id lo genera il database**, quindi lo si conosce solo *dopo* l'`INSERT`. Si vede in due punti:
  gli eventi sollevati da un factory nascono con id `0` e vanno completati dopo il commit (è il
  ruolo di `IDeferredIdentityEvent`), e nel seed i legami si esprimono via navigation property
  invece che con id costanti.
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

## Perché il template contiene `InitialCreate`

Le cartelle `Migrations/SqlServer` e `Migrations/Postgres` contengono una migration sola,
`InitialCreate`, che descrive lo schema dell'**impianto**: utenti, gruppi, ruoli, permessi, audit
log, error log, configurazione, refresh token.

La prima versione del template le lasciava vuote, per non vincolare i progetti generati a una
migration scritta da qualcun altro. In pratica il costo era maggiore del beneficio: ogni progetto
doveva ricordarsi di generarla, e chi lo dimenticava vedeva l'applicazione partire su un database
senza schema. E il file generato era lo stesso in ogni progetto, con un timestamp diverso — lo
schema dell'impianto non dipende dalle risposte a Copier.

Il compromesso: `InitialCreate` è del template, **tutto ciò che viene dopo è del progetto**. Le
migration del dominio si generano nel progetto, una per provider, e sono la sua storia. Se un
`copier update` porta una modifica al modello dell'impianto, arriva come migration nuova, non come
riscrittura di `InitialCreate`.

**Il prezzo**: le entità dell'impianto non si possono rinominare o rimodellare nel template senza
una migration aggiuntiva che i progetti generati riceveranno all'update — che è comunque il
comportamento corretto per uno schema già applicato su database reali.

## Perché le slice per caso d'uso

La Clean Architecture prescrive i confini **fra** i layer, non come organizzare il codice dentro
ciascuno. Dentro `Application` i casi d'uso restano organizzati **per funzionalità**, non per tipo
tecnico: `CreateGroup/` contiene comando, handler, validator e response.

Il criterio non è estetico, è il costo dell'operazione più frequente. Con le cartelle per tipo
(`Commands/`, `Handlers/`, `Validators/`), aggiungere un'operazione significa toccare quattro
cartelle diverse — e cancellarla significa ricordarsi di tutte e quattro. Così, l'operazione **è**
una cartella: si crea, si legge e si elimina in un posto solo.

Per un template il vantaggio è doppio, perché rende meccanico ciò che accade in ogni progetto:
aggiungere feature. È anche il motivo per cui le [skill](../progetto/skill.md) possono scaffoldare
una slice in modo affidabile — c'è una forma sola, ripetuta.

**Il rovescio**: c'è più ripetizione fra slice simili di quanta ne avrebbe un service condiviso, e
la tentazione di estrarre "il metodo comune" arriva presto. La regola è resistere finché la
ripetizione non è **identica e stabile** — con un'eccezione importante: se la ripetizione riguarda
una **regola di business**, non va estratta in un helper ma spostata nel dominio, dove diventa un
metodo dell'aggregato o un domain service. Vedi
[Dove mettere la logica](../architettura/dove-mettere-la-logica.md).

## Perché un concurrency token applicativo

Le entità che possono essere modificate da due operatori insieme implementano `IVersioned`, che
porta un `Guid` rigenerato a ogni scrittura da `ConcurrencyTokenInterceptor`.

Il problema che risolve:

> Due operatori aprono lo stesso contratto; il primo lo conferma, il secondo — che vede ancora la
> schermata di prima — lo conferma a sua volta. Senza controllo, la seconda scrittura sovrascrive
> la prima e nessuno se ne accorge: la modifica di qualcuno sparisce in silenzio, che è il peggiore
> dei modi di perdere dati.

Con il token, EF include il valore corrente nella `WHERE` dell'`UPDATE`: se qualcuno ha salvato nel
frattempo la riga non viene trovata, `SaveChanges` lancia `DbUpdateConcurrencyException` e il
middleware la traduce in un **409** con l'invito a ricaricare.

**Perché un `Guid` e non `rowversion`.** I token nativi esistono su entrambi i provider ma con tipi
e semantiche diverse (`rowversion` su SQL Server, `xmin` su PostgreSQL): mapparli richiederebbe
configurazione condizionale. Un `Guid` applicativo si comporta in modo identico sui due, al prezzo
di doverlo rigenerare noi — che è esattamente il compito dell'interceptor.

**Perché in un interceptor e non negli aggregati**: così nessuno può dimenticarsene. Un metodo
nuovo, un import massivo, una correzione da un hosted service sono tutti coperti senza scrivere una
riga in più.

Non tutte le entità ce l'hanno: si aggiunge dove la modifica concorrente è plausibile e costosa, non
per principio.

## Approfondimenti

- **[Clean Architecture](../architettura/clean-architecture.md)** — i layer che queste decisioni hanno prodotto
- **[Architettura](architettura.md)** — il modello dati e lo schema relazionale
- **[Implementazione](implementazione.md)** — il codice, con i punti in cui le decisioni si vedono
