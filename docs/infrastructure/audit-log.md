# Audit log

Ogni scrittura su una radice di aggregato lascia una riga in `AuditLogs`: **chi** ha fatto **che
cosa**, su **quale** entità, **quando**, da quale IP, e com'era l'entità **prima e dopo**. Nessun
handler lo scrive: lo fa un interceptor sul `DbContext`, e questa pagina spiega come, che cosa
traccia, che cosa non traccia di proposito e che cosa deve fare chi aggiunge un'entità.

```
handler → repository.Add / Remove, o un metodo dell'aggregato
        → unitOfWork.SaveChangesAsync()
              ├── TimestampInterceptor          CreatedAt / UpdatedAt
              ├── ConcurrencyTokenInterceptor   token IVersioned
              └── AuditLogInterceptor           riga AuditLogs con Before / After
```

## La riga

| Campo | Valore | Da dove |
|---|---|---|
| `ActorId` · `ActorEmail` | l'utente della richiesta | `ICurrentUser` (claim `sub` ed `email` del JWT) |
| `EntityType` | il nome del tipo, es. `"User"` | il change tracker |
| `EntityId` | l'id dell'entità toccata | il change tracker; per le cancellazioni è fissato **prima** del commit |
| `Action` | `Created` · `Updated` · `Deleted` | costanti in `AuditActions` |
| `Before` · `After` | snapshot JSON camelCase | `AuditSnapshotTracker` e `IAuditSnapshotWriter` |
| `Timestamp` | ora UTC | `IDateTimeProvider` |
| `IpAddress` | IP del client | `ICurrentUser`, già ripristinato da `UseForwardedHeaders` dietro un proxy |

`ActorId` ed `EntityId` **non sono chiavi esterne**, ed è voluto: lo storico deve sopravvivere alla
cancellazione di utenti ed entità. Con una FK verso `Users`, cancellare un utente cancellerebbe (o
bloccherebbe) le tracce di ciò che ha fatto — l'opposto dello scopo di un audit. `EntityId` è poi
polimorfo: punta a tabelle diverse secondo `EntityType`, e una FK non sarebbe nemmeno esprimibile.

La riga è **immutabile**: `AuditLog` estende `Entity`, ha setter privati e un solo factory
`Record(...)`. Non esiste un update.

| Azione | `Before` | `After` |
|---|---|---|
| `Created` | — | lo stato creato, con id e timestamp definitivi |
| `Updated` | lo stato al caricamento | lo stato dopo il commit |
| `Deleted` | lo stato prima della cancellazione | — |

## Come funziona, in tre momenti

`AuditLogInterceptor` è un `SaveChangesInterceptor` con stato per richiesta (scoped). Lavora in
tre momenti, e l'ordine non è arbitrario.

**1. Prima del salvataggio — `SavingChanges`.** Scorre il change tracker e, per ogni **radice di
aggregato** aggiunta, modificata o cancellata, registra una modifica "pendente". È qui che si legge
l'id di un'entità cancellata: dopo il commit sarebbe staccata dal context. È qui anche che si
recupera il `Before`, chiedendolo ad `AuditSnapshotTracker`.

**2. Dopo il salvataggio — `SavedChanges`.** Solo ora un'entità appena creata ha l'id identity
assegnato dal database e i timestamp scritti da `TimestampInterceptor`: si scatta l'`After`, si
costruiscono le righe `AuditLog` e si fa un secondo `SaveChanges` interno. Se questo secondo
salvataggio fallisce, le righe di audit vengono staccate dal context e **l'operazione già
committata non viene annullata**: un audit perso è meno grave di un'operazione riuscita che
risulta fallita.

**3. Il `Before`, in realtà, viene prima di tutto.** Al momento del `SaveChanges` l'istanza in
memoria è già quella modificata: serializzarla darebbe un `Before` identico all'`After`. I valori
scalari si potrebbero recuperare da `entry.OriginalValues`, ma le collezioni many-to-many (ruoli,
gruppi, permessi) sono navigation e lì non compaiono — e sono proprio ciò che gli update di questa
applicazione cambiano più spesso. L'unico momento in cui lo stato precedente è integro è **subito
dopo la lettura dal database**, ed è lì che lo registrano i repository:

```csharp
public async Task<User?> GetByIdAsync(int id, CancellationToken ct = default)
{
    var user = await db.Users
        .Include(u => u.Roles).Include(u => u.Groups)   // le M2M servono nello snapshot
        .FirstOrDefaultAsync(u => u.Id == id, ct);

    tracker.Capture(user);          // ← lo snapshot "Before", finché l'handler non lo modifica
    return user;
}
```

`AuditSnapshotTracker` vive per la durata della richiesta e tiene gli snapshot in una tabella a
riferimenti deboli: un aggregato caricato e mai salvato non trattiene memoria. Se lo stesso
aggregato viene catturato due volte, vince il primo snapshot, che è lo stato iniziale.

## Che cosa viene tracciato, e che cosa no

Tracciato: **ogni radice di aggregato** (`AggregateRoot`) creata, modificata o cancellata da un
utente autenticato, qualunque sia la strada — handler, evento di dominio, operazione futura che
oggi non esiste. È il vantaggio di un interceptor rispetto a una chiamata negli handler.

Non tracciato, di proposito:

| Caso | Perché |
|---|---|
| **Operazioni di sistema**: seed, hosted service, migration | Non c'è un utente autenticato: non sono azioni di qualcuno. Il solo seed produrrebbe una trentina di righe "system" a ogni database nuovo, e un audit che si apre con 26 voci di sistema nasconde quelle che contano |
| **Entità di supporto** che estendono `Entity` e non `AggregateRoot`: `AuditLog`, `ErrorLog`, `RefreshToken` | Sarebbe rumore, e un `AuditLog` che si auto-traccia darebbe una ricorsione infinita |
| **Il lato passivo di una many-to-many** | Assegnare un ruolo a un utente modifica l'utente, non il ruolo. EF marca la collezione su entrambi i lati; l'interceptor scrive l'audit solo per chi ha uno snapshot registrato, cioè per chi è stato caricato *per essere modificato*. Senza questo filtro ogni assegnazione produrrebbe un "Role Updated" fantasma, con `Before` vuoto |
| **Operazioni bulk** (`ExecuteUpdate` / `ExecuteDelete`) | Non passano dal change tracker. Se serve traccia, va scritta esplicitamente |

Lo snapshot registrato dal repository ha quindi **due ruoli**: fornisce il `Before`, e distingue
una modifica vera dal lato passivo di una relazione. Un update che tocca solo le collezioni
(l'entità resta `Unchanged` per EF) viene tracciato solo se c'è uno snapshot.

## Gli snapshot

`Before` e `After` sono stringhe JSON camelCase — la stessa forma delle risposte API — prodotte da
`AuditSnapshotWriter`, con uno `switch` **esplicito per tipo**:

```csharp
User u => Serialize(new
{
    u.Id,
    Username = u.Username.Value,
    u.Email,
    u.DisplayName,
    u.IsActive,
    GroupIds = u.Groups.Select(g => g.Id),
    RoleIds = u.Roles.Select(r => r.Id),
    Language = u.Language.Code,
    u.CreatedAt,
    u.UpdatedAt,
}),
```

Niente reflection, niente serializzazione dell'intero grafo: **quali campi** finiscono nello
snapshot è una decisione, e `passwordHash` non può finirci per costruzione. Le relazioni compaiono
come array di id.

L'interfaccia `IAuditSnapshotWriter` sta in `Application/Abstractions`, l'implementazione in
`Infrastructure/Services`: la serializzazione è infrastruttura, la scelta dei campi è applicativa.

Lo snapshot è una colonna testo e non un tipo JSON nativo: è portabile fra SQL Server e
PostgreSQL senza codice condizionale, e resta interrogabile con `JSON_VALUE`/`OPENJSON` da una
parte e con gli operatori JSON dall'altra.

## Che cosa deve fare chi aggiunge un'entità

Tre cose, e nessuna sta nell'handler.

1. **Nel repository**, ogni metodo che carica l'aggregato *per modificarlo* chiama
   `tracker.Capture(...)` (o `CaptureAll` per una lista), dopo aver fatto l'`Include` delle
   relazioni che compaiono nello snapshot. Dimenticarlo non rompe nulla in modo visibile: l'audit
   avrà solo un `Before` vuoto, e un update di sole collezioni non verrà tracciato.
2. **In `AuditSnapshotWriter`**, un `case` per il nuovo tipo. Senza, l'operazione viene comunque
   registrata ma senza `Before`/`After`.
3. **Nell'handler, niente.** Un solo `SaveChangesAsync`, nessuna menzione di `AuditLog`.

Per un'azione che non è una Created/Updated/Deleted — un'esportazione, un'operazione massiva —
l'interceptor non può dedurla: si scrive una riga esplicita tramite `IAuditLogRepository`, e si
documenta il motivo. È l'eccezione.

## Consultazione e retention

L'audit si consulta dalla pagina **Audit Log** dell'area di sistema (`/api/audit-logs`, permesso
`audit.read`), con filtri per tipo di entità e azione, e con `Before`/`After` leggibili riga per
riga.

La retention è configurabile dalla pagina **Configurazione** (`SystemConfig.AuditLogs`): abilitato
sì/no e numero massimo di record. Il reset (`audit.write`) cancella i record oltre la soglia
configurata. I record non si modificano né si cancellano uno per uno.

## Errori comuni

| Errore | Conseguenza |
|---|---|
| Scrivere un `AuditLog` in un handler | Doppia riga: l'interceptor la scrive già |
| Un secondo `SaveChangesAsync` "per l'audit" | Inutile, e prima o poi qualcuno lo toglie dal posto sbagliato |
| Iniettare `IHttpContextAccessor` per sapere chi agisce | L'attore lo legge l'interceptor da `ICurrentUser`; i test di architettura lo vietano |
| Repository senza `tracker.Capture()` | `Before` vuoto; gli update di sole M2M non vengono tracciati |
| Repository senza `Include` delle relazioni | Array di id vuoti nello snapshot |
| Nuova entità senza `case` in `AuditSnapshotWriter` | Riga scritta, ma senza `Before`/`After` |
| Aspettarsi audit dal seed | Le operazioni di sistema non sono tracciate |

## Da qui

- [Comandi e query](../architettura/comandi-e-query.md#dove-finiscono-audit-timestamp-e-concorrenza) — dove stanno i tre interceptor nel flusso di un comando
- [Il codice](implementazione.md) — la registrazione degli interceptor e il resto dell'impianto EF
- [Modello EF e schema](architettura.md#perche-audit-ed-error-log-non-hanno-fk) — le tabelle `AuditLogs` ed `ErrorLogs`
