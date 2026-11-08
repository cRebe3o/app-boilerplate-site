# Lavori programmati

Un lavoro programmato è codice che gira a un orario fisso, senza che nessuno lo chieda: ogni notte,
ogni ora, il primo del mese. Il template li affida a **Hangfire**, che gira dentro l'API e tiene
lavori e orari nel database dell'app. Questa pagina spiega come si ottengono, com'è fatto
l'impianto, come si aggiunge un lavoro, come si entra nel pannello di Hangfire e dove ci sono dei
limiti.

```
appsettings.json  Jobs:TrimLogs:Cron = "0 3 * * *"
        │
Api/Jobs/JobsExtensions.cs        AddOrUpdate<TrimLogsJob>("trim-logs", …)   quando
        │
Infrastructure/Jobs/JobsSetup.cs  storage da Database:Provider, server        dove
        │                         dentro l'API
Application/Jobs/TrimLogsJob.cs   ISender → ResetAuditLogs, ResetErrorLogs  che cosa
```

## Averli: la domanda `include_jobs`

I lavori programmati sono **a richiesta**. Copier lo chiede alla generazione con `include_jobs`, e
la risposta di base è **no**: chi risponde no non riceve niente di Hangfire, né pacchetti, né
codice, né il permesso, né le tabelle. Lo stesso vale per un progetto che aggiorna senza
chiederlo.

Per aggiungerli a un progetto che non li ha:

```powershell
copier update --trust --data include_jobs=true
```

L'update porta pacchetti, codice, test, la voce di menu e il permesso `jobs.dashboard`, che il seed
aggiunge anche a un database esistente. Le tabelle di Hangfire le crea Hangfire al primo avvio
(sotto).

## Com'è fatto

Tre posti, come il resto della [Clean Architecture](../architettura/clean-architecture.md):

| Che cosa | Dove | Chi conosce Hangfire |
|---|---|---|
| il lavoro: che cosa fa | `Application/Jobs/XxxJob.cs`, una classe semplice con `RunAsync(CancellationToken)` | nessuno: un test di architettura vieta Hangfire in Domain e Application |
| storage e server | `Infrastructure/Jobs/JobsSetup.cs` | Infrastructure |
| quando gira, e il pannello | `Api/Jobs/JobsExtensions.cs` (`UseJobs`), con l'orario in `appsettings.json` sotto `Jobs:<Nome>` | Api |

**Lo storage segue `Database:Provider`**, come EF: Hangfire.SqlServer su SQL Server,
Hangfire.PostgreSql su PostgreSQL. Entrano tutti e due i pacchetti, così il cambio di provider
resta una questione di configurazione, come per il resto del [doppio provider](panoramica.md).
Su SQL Server Hangfire usa `Microsoft.Data.SqlClient`, lo stesso client di EF.

**Le tabelle non hanno migration.** Le crea Hangfire al primo avvio, nel suo schema: `HangFire` su
SQL Server, `hangfire` su PostgreSQL. Per questo l'utente del database deve poter creare uno schema
e delle tabelle, almeno al primo avvio. `UseJobs` si chiama dopo le migration e il seed, quindi le
tabelle dell'app esistono già quando Hangfire si collega.

**Il server gira nell'API**, nello stesso processo: non c'è un servizio a parte da distribuire. Non
parte quando si genera lo schema OpenAPI, che esegue `Program.cs` senza un database.

### Il primo lavoro: la pulizia dei log

`TrimLogsJob` fa ogni giorno alle 3 UTC ciò che fa "Reset da configurazione" nelle pagine dei log:
per l'[audit log](audit-log.md) e per l'error log, se il log è disattivato lo svuota, se è attivo
tiene solo le righe più recenti, secondo la conservazione impostata in **Configurazione**. Non ha
logica sua: manda i due comandi che esistono già.

```csharp
public class TrimLogsJob(ISender sender)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        await sender.Send(new ResetAuditLogsCommand(), cancellationToken);
        await sender.Send(new ResetErrorLogsCommand(), cancellationToken);
    }
}
```

Orario e fuso stanno in `appsettings.json`:

```json
"Jobs": {
  "TrimLogs": {
    "Cron": "0 3 * * *",
    "TimeZone": "UTC"
  }
}
```

## Aggiungere un lavoro

Un esempio con nomi di fantasia: archiviare ogni notte gli ordini chiusi da più di un anno.

**1. La classe, in Application.** Senza Hangfire: riceve le dipendenze nel costruttore e di solito
manda un comando che esiste già, o uno nuovo scritto come gli altri
([Comandi e query](../architettura/comandi-e-query.md)). Non serve registrarla nella DI: Hangfire
la crea con le dipendenze del container.

```csharp
namespace MioProgetto.Application.Jobs;

public class ArchiveOrdersJob(ISender sender)
{
    public Task RunAsync(CancellationToken cancellationToken) =>
        sender.Send(new ArchiveClosedOrdersCommand(), cancellationToken);
}
```

**2. L'orario, in Api.** Una chiamata in `UseJobs`, accanto a quella di `TrimLogsJob`:

```csharp
var archiveOrders = app.Configuration.GetSection("Jobs:ArchiveOrders");
app.Services.GetRequiredService<IRecurringJobManager>().AddOrUpdate<ArchiveOrdersJob>(
    "archive-orders",
    job => job.RunAsync(CancellationToken.None),   // Hangfire passa il token del lavoro
    archiveOrders["Cron"] ?? "0 2 * * *",
    new RecurringJobOptions { TimeZone = TimeZoneInfo.FindSystemTimeZoneById(archiveOrders["TimeZone"] ?? "UTC") });
```

e la sua sezione in `appsettings.json`, `Jobs:ArchiveOrders`, con `Cron` e `TimeZone`.

**3. Il test, come un handler.** Il lavoro si prova senza Hangfire, con un `ISender` sostituito,
come fa `TrimLogsJobTests`: si controlla che mandi i comandi giusti. Che Hangfire lo lanci
all'orario giusto è affar suo.

Due cose da sapere sugli id:

- **L'id del lavoro ricorrente è stabile.** `AddOrUpdate` con lo stesso id aggiorna orario e
  metodo; con un id nuovo crea un secondo lavoro, e il vecchio resta nel database. Per rinominarne
  uno si toglie il vecchio con `RemoveIfExists("vecchio-id")`.
- **Il metodo è registrato per nome.** Hangfire salva tipo e metodo del lavoro: rinominare la
  classe o `RunAsync` lascia nel database lavori che non trovano più il codice. Si rinomina insieme
  all'id, togliendo quello vecchio.

## Il pannello

Hangfire ha un pannello web: lavori ricorrenti, esecuzioni riuscite e fallite, coda. Da lì si
rilancia un lavoro fallito, se ne cancella uno o lo si fa partire subito. Il template lo monta su
`/hangfire` del backend e lo apre dalla voce **Lavori programmati** della sezione **Sistema**, in
una scheda nuova, a chi ha il permesso `jobs.dashboard`. Sul database nuovo ce l'ha solo
SuperAdmin, e il seed lo aggiunge solo a SuperAdmin anche su un database esistente.

### Perché un biglietto

Il pannello si apre con una **navigazione**, non con una chiamata dell'app: il JWT, che il frontend
manda nell'header `Authorization`, lì non viaggia. In produzione il pannello sta poi sull'origine
del backend, diversa da quella del frontend. Serve un altro modo per dire al backend chi è
l'utente, e il template usa un biglietto per entrare e un cookie per restare:

```
frontend                                  backend
────────                                  ───────
clic su "Lavori programmati"
  apre subito una scheda vuota
  POST /api/jobs/dashboard-ticket  ─────▶ JWT valido + permesso jobs.dashboard
                                   ◀───── biglietto: un minuto, un solo uso
  form POST /hangfire/login        ─────▶ consuma il biglietto, ricontrolla il permesso
  (nella scheda, biglietto nel corpo)     imposta il cookie del pannello (30 minuti)
                                   ◀───── pagina che porta a /hangfire
                                          a ogni richiesta: permesso riletto dal database
```

Ogni passo ha una ragione:

| Scelta | Perché |
|---|---|
| la scheda si apre **prima** di chiedere il biglietto | il browser blocca le finestre aperte dopo un'attesa: si apre nel clic, poi ci si manda il form |
| il biglietto va in un **POST**, nel corpo | un biglietto nell'indirizzo finirebbe nel log della richiesta, in cronologia e nel Referer. `?ticket=` nell'indirizzo non vale |
| un minuto, un solo uso | se qualcuno lo intercetta, non lo può riusare: il backend lo toglie dalla cache prima di guardarlo |
| `/hangfire/login` risponde con una pagina, non con un redirect | il cookie è `SameSite=Strict`: il browser non lo manderebbe nel redirect di una navigazione partita da un altro sito, il frontend. La pagina è già del backend, e la navigazione che parte da lì lo porta |
| cookie `HttpOnly`, `Secure`, `SameSite=Strict`, sul percorso `/hangfire` | JavaScript non lo legge, non va in chiaro, non parte da altri siti, non arriva al resto dell'API. Se l'app gira sotto un sotto-percorso, il cookie sta sotto quello |
| il cookie è un JWT con un'**audience sua** | firmato con la chiave dei JWT, ma non vale come token dell'API, né il token dell'API come cookie del pannello |
| il permesso si rilegge **a ogni richiesta** | togliere `jobs.dashboard`, o disattivare l'utente, chiude il pannello subito, senza aspettare che il cookie scada |

Il filtro di base di Hangfire ammette solo le richieste locali: il template lo sostituisce con il
suo, che fa il controllo dell'ultima riga.

Quando l'accesso si chiude (sessione scaduta, permesso tolto, link già usato) il pannello non
mostra la finestra 401 del browser ma una pagina breve, in italiano o in inglese secondo il
browser, che dice di riaprirlo dalla voce **Lavori programmati**. Il pannello si aggiorna da solo
ogni pochi secondi: le sue richieste non finiscono nella [telemetria](../deploy/observability.md),
che altrimenti ne sarebbe piena.

## Dove gira: i limiti

### Host che addormentano l'API

Sui piani gratuiti di molti host, [Render](../deploy/render.md) compreso, l'API si ferma quando non
riceve richieste per un po' e riparte alla prima che arriva. Il server di Hangfire è dentro l'API:
**mentre dorme, i lavori non partono**. Un lavoro ricorrente saltato parte al risveglio, non
all'orario. Se un lavoro deve girare davvero alle 3, serve un piano che tenga l'API accesa.

### Più istanze

Più istanze dell'API si dividono i lavori coordinandosi dal database: un lavoro gira su una sola.
Il **biglietto del pannello** invece sta in una cache in memoria (`IDistributedCache`, con
l'implementazione in memoria di base): dietro un bilanciatore, un biglietto emesso da un'istanza
non vale sull'altra. Con più istanze si registra una cache condivisa, per esempio Redis, al posto
di `AddDistributedMemoryCache` in `JobsExtensions`.

### PostgreSQL: Hangfire.PostgreSql

Su SQL Server lo storage è di Hangfire stesso. Su PostgreSQL è **Hangfire.PostgreSql**, un
pacchetto della comunità fermo da marzo 2026. Il template usa la 1.21.1, con due limiti noti:

- **Molti lavori creati insieme** possono rallentare le richieste fino al timeout (issue #431).
  Conta per chi accoda molti lavori in una volta, non per qualche lavoro ricorrente.
- **Più istanze che partono insieme su un database vuoto** possono fallire nel creare lo schema
  (#425): la prima volta se ne avvia una sola, poi si scala.

Chi mantiene il template lo ricontrolla a ogni aggiornamento delle dipendenze, e cercherà
un'alternativa se resta fermo.

### `Newtonsoft.Json`

Hangfire.Core 1.8.25 chiede `Newtonsoft.Json` 11.0.1, che ha un advisory alto
(GHSA-5crp-9r3c-p9vr) e farebbe fallire il controllo delle vulnerabilità di `pnpm verify`.
Infrastructure lo fissa alla 13.0.4. Il pin si toglie quando Hangfire.Core ne chiederà una
versione corretta.

## Errori comuni

| Sintomo | Causa |
|---|---|
| all'avvio, errore di permessi sullo schema `HangFire` o `hangfire` | l'utente del database non può creare schemi o tabelle: serve almeno al primo avvio |
| la voce "Lavori programmati" non c'è nel menu | l'utente non ha `jobs.dashboard`: sul database nuovo ce l'ha solo SuperAdmin |
| il pannello, appena aperto, dice di riaprirlo dal menu | il biglietto è scaduto o già usato, oppure con più istanze è arrivato a un'altra: vedi sopra |
| un lavoro rinominato gira ancora con il nome vecchio, o fallisce perché non trova il metodo | è rimasto il lavoro con l'id vecchio: `RemoveIfExists` |
| un lavoro notturno parte la mattina | l'API dormiva: vedi gli host che addormentano l'API |

## Da qui

- [Generare e aggiornare](../progetto/generazione.md) — la domanda `include_jobs` e `copier update --data`
- [Audit log](audit-log.md#consultazione-e-retention) — la conservazione che `TrimLogsJob` applica
- [Comandi e query](../architettura/comandi-e-query.md) — il comando che un lavoro manda
- [Deploy su Render](../deploy/render.md) — l'API che dorme sul piano gratuito
