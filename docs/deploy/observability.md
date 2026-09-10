# Observability

Un log dice **che cosa** è successo. Una traccia dice **come**: mostra una richiesta come un
albero unico — la chiamata HTTP, il comando MediatR che ha innescato, ogni query SQL che ne è
seguita — con il tempo di ciascun livello. È la differenza tra sapere che un'operazione ha
impiegato 1,2 secondi e sapere **quale query** se li è presi.

Il backend è instrumentato con **OpenTelemetry**, lo standard di settore per questa telemetria.
È **spento per default**: senza un endpoint configurato non viene registrato nulla e
l'applicazione si comporta esattamente come se il codice non ci fosse.

## Che cosa si vede

> **Da dove viene l'esempio.** La richiesta usata qui sotto viene dalla sezione **Noleggi** di
> `app-demo`, la *reference implementation* del template: serve un handler che faccia parecchie
> cose per mostrare che cosa aggiunge una traccia. Il meccanismo è identico su qualunque comando.

Questo è ciò che finisce nei log quando un utente apre un contratto:

```
Handling CreateRentalContractCommand
Handled CreateRentalContractCommand in 1243ms
```

L'handler però fa cinque cose — carica il cliente, verifica le regole, genera il numero
progressivo, crea il contratto, salva — e il tempo è uno solo per tutte. Per scoprire quale sia
lenta bisogna aggiungere log a mano, ridistribuire, riprodurre il caso, poi togliere i log.

Con la telemetria attiva la stessa richiesta si legge così, senza aver scritto nulla:

```
POST /api/rentals                                    1243ms
└─ CreateRentalContractCommand                       1230ms
   ├─ rentals   SELECT ... FROM Customers WHERE Id = @p0        8ms
   ├─ rentals   SELECT MAX(Sequence) FROM RentalContracts    1180ms  ←
   └─ rentals   INSERT INTO RentalContracts                     35ms
```

Tre livelli, uno per instrumentation: la richiesta HTTP (ASP.NET Core), il comando MediatR
(`LoggingBehavior`) e le query (EF Core). Autenticazione, CORS e rate limiting non compaiono come
righe separate: sono middleware, e il loro tempo è dentro lo span HTTP.

La query del progressivo si prende 1180ms su 1243: manca un indice, o la query scansiona
l'intera tabella. Questa informazione non è in nessun log e non lo sarebbe mai stata, perché
nessuno logga le singole query di EF Core con i rispettivi tempi.

## I tre segnali

| | Risponde a | Esempio |
|---|---|---|
| **Metriche** | *Quanto?* | il 5% delle richieste supera i 2 secondi |
| **Tracce** | *Dove?* | il tempo se ne va nella query su `Customers` |
| **Log** | *Che cosa?* | timeout sulla connessione al database |

Servono tutti e tre perché rispondono a domande diverse, in sequenza: si vede il problema con le
metriche, lo si localizza con le tracce, lo si capisce con i log.

Il valore vero però è la **correlazione**. Ogni richiesta riceve un `trace_id` che finisce sia
nella traccia sia in ogni riga di log che quella richiesta produce. Da una traccia lenta si
arriva con un clic ai **soli log di quella richiesta**, invece di cercarli in mezzo a tutti gli
altri. È il motivo per cui questo template esporta anche i log via OTLP e non solo le tracce.

## I pezzi in gioco

OpenTelemetry raccoglie e **spedisce**: non conserva niente e non mostra niente. Se non gli si dà
un indirizzo dove consegnare, i dati si perdono nell'istante in cui la richiesta finisce. Serve
sempre una destinazione.

```
  applicazione                collector                    interfaccia
 ┌─────────────┐            ┌───────────┐                ┌────────────┐
 │OpenTelemetry│  ──OTLP──> │ archivia  │  ─────────────>│ si consulta│
 └─────────────┘            └───────────┘                └────────────┘
   nel codice            Tempo · Loki · Prometheus            Grafana
                          oppure Aspire Dashboard         (o il dashboard)
```

| Pezzo | Ruolo |
|---|---|
| **OpenTelemetry** | Nel codice dell'applicazione: raccoglie e spedisce |
| **Tempo** | Archivia le **tracce** |
| **Loki** | Archivia i **log** |
| **Prometheus** / **Mimir** | Archivia le **metriche** |
| **Grafana** | L'interfaccia: non archivia niente, legge dagli altri e disegna |

Uno stack Grafana completo sono quindi **quattro servizi**. L'Aspire Dashboard li sostituisce
tutti per l'uso locale, ed è il motivo per cui il template lo usa in sviluppo e non in produzione.

**OTLP** (*OpenTelemetry Protocol*) è il protocollo con cui l'applicazione parla al collector.
Essendo standard, cambiare destinazione non richiede di toccare il codice: è tutta la strategia
di questa pagina.

## In locale: l'Aspire Dashboard

```bash
docker compose up -d
dotnet run --project apps/backend/NomeProgetto.Api
```

L'interfaccia è su **<http://localhost:18888>**. `appsettings.Development.json` punta già al
dashboard, quindi non serve configurare nulla.

Due porte diverse, da non confondere:

| Porta | Che cos'è |
|---|---|
| **18888** | L'interfaccia, si apre nel browser |
| **4317** | Dove il backend *consegna* i dati (OTLP/gRPC). Non è una pagina web |

La 4317 è la porta standard di OTLP: il `docker-compose.yml` la mappa sulla 18889 interna al
container proprio per esporre all'esterno il numero che ogni strumento si aspetta.

### Perché questo dashboard

Nonostante il nome, **non richiede il framework .NET Aspire** e non lo introduce nel progetto: è
un'immagine autonoma che parla OTLP standard, quindi funziona come visualizzatore per qualunque
servizio instrumentato con OpenTelemetry. Nel template non esiste alcun progetto Aspire, e la
solution resta quella di sempre.

Un solo container dà tracce, log e metriche già correlati fra loro, con un'interfaccia curata: in
sviluppo sostituisce da solo Tempo, Loki, Prometheus e Grafana.

Il compromesso è che **i dati stanno in memoria**: allo stop del container spariscono. In
sviluppo è accettabile — anzi desiderabile, perché ogni sessione riparte pulita — ed è
esattamente il motivo per cui in produzione serve altro.

Se il container non è avviato l'applicazione parte lo stesso: l'export fallisce in silenzio e
viene ritentato, senza alcun impatto sulle richieste.

### Le pagine del dashboard

In alto a destra ci sono le impostazioni (tema chiaro/scuro, lingua, formato dell'ora) e l'icona
`?`. **Shift+?** apre l'elenco delle scorciatoie; le più utili sono i tasti singoli che cambiano
pagina:

| Tasto | Pagina |
|---|---|
| **S** | Structured logs |
| **T** | Traces |
| **M** | Metrics |
| **R** / **C** | Resources / Console logs — *vuote, vedi sotto* |
| **Shift+S** | Impostazioni |

Sui pannelli di dettaglio: `+` e `-` ridimensionano, **Shift+T** ruota il pannello da destra a
sotto, **Shift+X** lo chiude.

> **Resources e Console logs restano vuote, ed è normale.** Quelle due pagine mostrano i processi
> avviati e governati dall'*app host* di .NET Aspire — start, stop, restart, stdout. Qui il
> dashboard gira in **standalone**: riceve solo OTLP e non governa nulla, quindi le funzioni
> "resource" sono disattivate. Il backend si avvia e si ferma con `dotnet run`, e il suo output di
> console si legge nel terminale. Le tre pagine che contano sono **Structured logs**, **Traces** e
> **Metrics**.

#### Traces

La lista mostra **Timestamp**, **Name**, **Spans** e **Duration**, quest'ultima con un indicatore
radiale che rende la durata confrontabile a colpo d'occhio con le altre tracce.

Il campo di ricerca filtra per nome; **Add filter** costruisce invece filtri sugli attributi, e
propone da sé i valori già visti — filtrare su `http.route` = `/api/users/{id}` isola tutte le
chiamate a quell'endpoint senza scrivere una query.

Aprendo una traccia con **View details** si ottiene l'albero: in testa **Duration**, **Resources**,
**Depth** e **Total Spans**, poi una riga per span con la barra proporzionale alla durata.
L'indentazione è la gerarchia, la barra è *quando* lo span è iniziato e quanto è durato. Due letture
diverse e ugualmente importanti:

- barre **in cascata**, ognuna dopo la precedente → lavoro sequenziale (il caso tipico: query in
  serie, spesso una N+1);
- barre **sovrapposte** → lavoro parallelo.

Un buco tra la fine di uno span e l'inizio del successivo è tempo che *nessuno* ha rivendicato: sta
nel codice tra una chiamata e l'altra, non nel database.

Gli span in errore hanno l'icona rossa — è ciò che `LoggingBehavior` produce quando marca
l'activity con `SetStatus(Error)` e vi allega l'eccezione. Il campo di filtro interno alla traccia
cerca tra gli span di *quella* traccia, comodo quando sono decine.

#### Dal trace ai log e ritorno

È la funzione che giustifica da sola l'esportazione dei log via OTLP:

- da una traccia, **View Logs** apre Structured logs già filtrata su quel `trace_id`: si leggono
  **solo** le righe di quella richiesta;
- da una riga di log, la colonna **Trace** riporta alla traccia che l'ha prodotta.

È il ciclo "vedo che è lento → vedo dove → leggo cosa diceva l'applicazione in quel punto" senza
mai cercare a mano un identificativo.

#### Structured logs

Colonne **Resource**, **Level**, **Timestamp**, **Message**, **Trace** e **Details**. Il menu
**Level** filtra per gravità; l'icona del filtro costruisce condizioni su qualunque proprietà del
log.

Il punto è che i log sono **strutturati**: `logger.LogInformation("Handled {RequestName} in
{ElapsedMs}ms", ...)` non produce una stringa piatta ma un messaggio con i campi `RequestName` e
`ElapsedMs` interrogabili singolarmente. Si può quindi filtrare su `RequestName` =
`CreateUserCommand` invece di cercare sottostringhe. Poiché `IncludeScopes` è attivo, gli scope
aperti attorno alla richiesta arrivano come attributi.

#### Metrics

Si sceglie prima il **meter**, poi lo **strumento**. Sotto al grafico compaiono i filtri per
dimensione: sono i *tag* della metrica, e permettono di isolare per esempio il solo
`http.response.status_code` = `500`.

Due comandi che vale la pena conoscere:

- il toggle **Count** cambia l'asse verticale tra il valore misurato e il numero di occorrenze;
- il passaggio **grafico ↔ tabella** dà i numeri esatti quando il grafico non basta.

Sul grafico compaiono puntini piccoli: sono gli **exemplar**. Ognuno è una richiesta reale che ha
contribuito a quel punto della metrica; passandoci sopra si legge risorsa, operazione, valore e
istante, e **cliccandoci si salta alla traccia corrispondente**. È il ponte diretto dal picco alla
richiesta che l'ha causato — dal "quanto" al "dove" in un clic.

### Pausa, esportazione, limiti

Ogni pagina ha un pulsante di **pausa** della raccolta (indipendente per pagina): utile per
fermare l'arrivo di nuovi dati mentre si sta esaminando qualcosa. Il pulsante di **rimozione**
svuota i dati della pagina.

Da *Settings → Resource logs and telemetry → Manage* si possono **esportare** i dati selezionati in
uno zip (`aspire-telemetry-export-<timestamp>.zip`) e **reimportarli** in seguito: è il modo di
allegare a una segnalazione la telemetria di un problema riprodotto in locale.

I dati stanno in memoria e sono **limitati**. Superata la soglia il dashboard **elimina i più
vecchi**, in silenzio:

| Variabile | Default | Che cosa limita |
|---|---|---|
| `DASHBOARD__TELEMETRYLIMITS__MAXLOGCOUNT` | 10.000 | Righe di log |
| `DASHBOARD__TELEMETRYLIMITS__MAXTRACECOUNT` | 10.000 | Tracce |
| `DASHBOARD__TELEMETRYLIMITS__MAXMETRICSCOUNT` | 50.000 | Punti per dimensione |

Se una traccia di dieci minuti fa è sparita, quasi sempre è questo — non un problema di export. Si
alzano come le altre variabili, nel `docker-compose.yml`.

### Senza Docker

Chi ha generato il progetto con `include_docker` a `false` non ha il `docker-compose.yml`. Il
dashboard si avvia comunque da solo:

```bash
docker run --rm -p 18888:18888 -p 4317:18889 \
  -e DASHBOARD__FRONTEND__AUTHMODE=Unsecured \
  -e DASHBOARD__OTLP__AUTHMODE=Unsecured \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.0
```

Poi in `appsettings.Development.json`:

```json
"Telemetry": { "Endpoint": "http://localhost:4317" }
```

## In produzione: una destinazione persistente

In produzione servono due cose che il dashboard non dà: i dati devono **sopravvivere** al
riavvio, e devono essere raggiungibili da fuori la macchina di sviluppo.

La telemetria in produzione è **spenta finché non si sceglie una destinazione**: in
`appsettings.json` l'endpoint è vuoto di proposito. Si attiva impostando una variabile
d'ambiente, senza ricompilare.

### Grafana Cloud

La strada consigliata per iniziare. È lo stack Grafana completo — Tempo, Loki, Prometheus e
l'interfaccia Grafana — gestito da loro, con un piano gratuito dalla retention adeguata a un
progetto piccolo. Si ottiene l'interfaccia Grafana vera senza mantenere quattro servizi.

Sul servizio (per esempio su Render, in *Environment*):

| Variabile | Valore |
|---|---|
| `Telemetry__Endpoint` | l'endpoint OTLP fornito da Grafana Cloud |
| `Telemetry__ServiceName` | il nome con cui l'applicazione appare, es. `NomeProgetto.Api` |
| `Telemetry__SampleRatio` | `0.1` per campionare il 10% delle tracce, oppure omessa per tutte |

Grafana Cloud richiede un'autenticazione, che viaggia come header OTLP standard:

```
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <credenziale in base64>
```

È una variabile che l'SDK OpenTelemetry legge da sé, senza codice aggiuntivo. **È un segreto**: va
trattata come `Auth__Jwt__Secret`, quindi impostata sul servizio e mai committata.

### Stack Grafana self-hosted

Tempo, Loki, Prometheus e Grafana sui propri server. Ha senso quando i dati non possono uscire
dalla propria infrastruttura, o quando gestire lo stack è esso stesso un obiettivo. Il costo è
mantenere quattro servizi, ciascuno con il proprio storage e la propria retention.

Dal punto di vista dell'applicazione non cambia nulla:

```
Telemetry__Endpoint=http://tempo:4317
```

### Altre destinazioni

Qualunque collector che parli OTLP: **Jaeger**, **Honeycomb**, **Datadog**, **Azure Monitor** (con
il proprio distro), o un **OpenTelemetry Collector** intermedio che smista verso più backend.
Nessuna richiede modifiche al codice.

### La scelta, in breve

| | Sviluppo | Produzione |
|---|---|---|
| **Destinazione** | Aspire Dashboard | Grafana Cloud, o stack self-hosted |
| **Persistenza** | in memoria, si perde | duratura |
| **Da gestire** | un container | niente, oppure quattro servizi |
| **Configurazione** | già pronta | `Telemetry__Endpoint` sul servizio |

Non sono alternative in concorrenza: sono **due momenti** della stessa strategia, con la stessa
identica instrumentation. Cambia solo dove i dati vengono consegnati.

## Configurazione

| Chiave | Significato |
|---|---|
| `Telemetry:Endpoint` | Collector OTLP/gRPC. **Vuoto = telemetria spenta** |
| `Telemetry:ServiceName` | Nome con cui l'applicazione appare nel backend. Default: il nome dell'assembly |
| `Telemetry:SampleRatio` | Frazione di tracce da campionare, fra 0 e 1. `null` = tutte |

Come ogni altra chiave, in deploy diventano variabili d'ambiente con il doppio underscore:
`Telemetry__Endpoint`, `Telemetry__ServiceName`, `Telemetry__SampleRatio`. Vedi
[Configurazione](../progetto/configurazione.md).

L'endpoint è **l'interruttore generale**: se manca, OpenTelemetry non viene nemmeno registrato nel
container di dipendenze, e non c'è alcun costo a runtime. Se è valorizzato ma non è un URI
assoluto valido, l'applicazione **non parte** e lo dice: un errore di battitura che disattiva in
silenzio la telemetria sarebbe peggio di un avvio fallito.

### Il campionamento

Con `SampleRatio` a `null` vengono esportate tutte le tracce: è quello che si vuole in sviluppo e
su un servizio a traffico contenuto. In produzione, sotto carico, il volume va contenuto.

Vale però la pena ricordare che **una traccia campionata via è una traccia che non si potrà più
esaminare**: al primo problema che non si riesce a riprodurre, la percentuale va alzata. La scelta
è fra costo di storage e capacità diagnostica, e conviene partire generosi.

## Che cosa viene tracciato

| Instrumentation | Che cosa produce |
|---|---|
| **ASP.NET Core** | Le richieste HTTP in ingresso: la radice di ogni traccia |
| **HttpClient** | Le chiamate in uscita (per esempio verso Azure AD durante il login MSAL) |
| **EF Core** | Le query SQL: il livello che nei log non si vede |
| **Runtime** | GC, thread pool ed eccezioni del processo (solo metriche) |
| **`ApplicationDiagnostics`** | Gli span dei comandi MediatR, aperti da `LoggingBehavior` |

Vengono esclusi dalle tracce `/health`, `/swagger`, `/openapi` e `/favicon`: genererebbero
traffico costante senza alcun valore diagnostico, e filtrarli all'origine costa meno che filtrarli
a valle. Il filtro vale per le **tracce**: le metriche HTTP continuano a contare anche quelle
richieste.

## Leggere i valori

Le sezioni precedenti dicono dove guardare. Questa dice che cosa significano i numeri.

### Gli attributi di uno span

**View details** su uno span apre l'elenco dei suoi attributi. Quelli che si incontrano qui:

| Attributo | Su quale span | Che cosa contiene |
|---|---|---|
| `http.route` | HTTP | Il *template* della rotta, `/api/users/{id}` — non l'URL concreto |
| `http.request.method` · `http.response.status_code` | HTTP | Metodo e stato |
| `url.path` | HTTP | Il percorso realmente chiamato, con gli id veri |
| `db.statement` | EF Core | **Il testo SQL**, con i parametri come segnaposto |
| `db.name` | EF Core | Il database |
| `db.system` · `ef.provider` | EF Core | `mssql` o `postgresql`, e il provider EF |
| `server.address` · `server.port` | EF Core, HttpClient | Dove sta il server contattato |

Due avvertenze che fanno risparmiare tempo:

- **Gli span EF Core si chiamano come il database, non come la query.** Nell'albero appaiono tutti
  con lo stesso nome (`rentals`, `mio_db`…): per sapere *quale* query sia, va aperto
  `db.statement`. È il motivo per cui sopra le righe SQL sono mostrate con il nome del database
  davanti.
- `http.route` è il template e `url.path` il percorso concreto. Per raggruppare (“quanto costa
  *questo endpoint*”) serve `http.route`; per ritrovare la singola richiesta, `url.path`.

Il valore dei parametri SQL non c'è, e non è una dimenticanza: vedi
[Sicurezza](#sicurezza-che-cosa-non-esce).

### Le metriche disponibili

Il template non definisce metriche proprie: quelle che si vedono arrivano tutte dalle tre
instrumentation registrate. Le più utili, con l'unità in cui sono espresse:

**`Microsoft.AspNetCore.Hosting`** — le richieste in ingresso

| Strumento | Tipo | Unità | Legge |
|---|---|---|---|
| `http.server.request.duration` | Histogram | **secondi** | Quanto durano le richieste |
| `http.server.active_requests` | UpDownCounter | richieste | Quante ne sono in corso adesso |

**`Microsoft.AspNetCore.Server.Kestrel`** — le connessioni

| Strumento | Tipo | Unità | Legge |
|---|---|---|---|
| `kestrel.active_connections` | UpDownCounter | connessioni | Connessioni aperte |
| `kestrel.queued_requests` | UpDownCounter | richieste | Richieste in coda: se sale, il server non sta al passo |

**`Microsoft.AspNetCore.RateLimiting`** — il rate limiter di `Program.cs`

| Strumento | Tipo | Legge |
|---|---|---|
| `aspnetcore.rate_limiting.requests` | Counter | Tentativi, con `aspnetcore.rate_limiting.result` |
| `aspnetcore.rate_limiting.queued_requests` | UpDownCounter | In attesa di un permesso |

Il tag `aspnetcore.rate_limiting.policy` distingue `auth-policy` da `error-log-policy`: è il modo
di vedere se qualcuno sta martellando il login.

**`System.Runtime`** — il processo

| Strumento | Unità | Legge |
|---|---|---|
| `dotnet.gc.pause.time` | **secondi totali** | Tempo passato in pausa per il GC |
| `dotnet.gc.heap.total_allocated` | byte | Allocato da inizio processo |
| `dotnet.process.memory.working_set` | byte | Memoria fisica del processo |
| `dotnet.thread_pool.queue.length` | work item | Lavoro in coda sul thread pool |
| `dotnet.exceptions` | eccezioni | Eccezioni lanciate, con `error.type` |

**`System.Net.Http`** — le chiamate in uscita: `http.client.request.duration` (secondi) e
`http.client.open_connections`.

### Come si legge un istogramma

`http.server.request.duration` è un **istogramma in secondi**, e sono i due dettagli che traggono
più spesso in inganno:

- **secondi, non millisecondi**: `0.25` è 250ms;
- non è una media, ma una distribuzione in intervalli predefiniti — i bucket di default sono
  `0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10`.

La media è la statistica sbagliata per le latenze: novantacinque richieste da 20ms e cinque da 3
secondi danno una media di 170ms, un numero che nessun utente ha mai sperimentato. Si leggono
invece i **percentili**: la P50 (la richiesta tipica), la P95 e la P99 (le peggiori, quelle di cui
gli utenti si lamentano). Un divario ampio tra P50 e P99 dice che il problema riguarda *alcune*
richieste — di solito un caso con più dati, una cache fredda o un lock.

L'ultimo bucket è `10`: tutto ciò che supera i 10 secondi finisce insieme, e da lì non si distingue
più una richiesta da 11 secondi da una da due minuti. Se la coda si accumula lì, la risposta sta
nelle tracce, non nella metrica.

### Un percorso completo

Come si incastrano le tre pagine, su un caso concreto:

1. **Metrics** → `http.server.request.duration`: la P99 è a 2 secondi mentre la P50 sta a 30ms.
   Qualcosa è lento, ma solo a volte.
2. Un **exemplar** sul picco → clic → si apre la traccia di *una* di quelle richieste lente.
3. **Traces**: l'albero mostra il comando MediatR e, sotto, dodici span EF Core in cascata quasi
   identici. `db.statement` li rivela: la stessa `SELECT` ripetuta per ogni riga — una N+1.
4. **View Logs** → i log di quella sola richiesta confermano quale handler l'ha eseguita.

Diagnosi completa senza aggiungere un solo log e senza riprodurre il problema a mano.

### Quando manca qualcosa

| Sintomo | Causa quasi sempre |
|---|---|
| Nessun dato | Container non avviato, o `Telemetry:Endpoint` vuoto |
| Traccia senza il livello SQL | Il pacchetto EF Core è stato rimosso |
| Traccia senza il livello MediatR | La richiesta non passa da un handler MediatR |
| Una traccia vecchia è sparita | Il limite di 10.000 tracce ha eliminato le più vecchie |
| Manca una parte delle tracce | `Telemetry:SampleRatio` sta campionando |
| Nulla su `/health` | È escluso di proposito |

## Sicurezza: che cosa non esce

I **valori** dei parametri SQL non vengono mai esportati. È deliberato: attraverso quei parametri
passano hash di password, refresh token e dati personali, che finirebbero in chiaro nello storage
delle tracce — un archivio che, per sua natura, è consultabile da più persone di quante possano
leggere il database.

Il **testo** della query invece viene esportato, ed è ciò che serve per capire quale query è
lenta. I valori compaiono come segnaposto:

```sql
SELECT TOP(1) [u].[Id], [u].[Email], [u].[PasswordHash] FROM [Users] AS [u]
WHERE [u].[Username] = @p0
```

Il comportamento è stato verificato inviando un login con una password riconoscibile e
ispezionando il payload OTLP esportato: né la password né il nome utente vi comparivano.

Se una versione futura dell'instrumentation introducesse un'opzione per includere i valori, **va
lasciata disattivata**.

## Dove sta il codice

```
Api/Extensions/TelemetryExtensions.cs          tutta la configurazione
Api/Program.cs                                 builder.AddAppTelemetry();
Application/ApplicationDiagnostics.cs          l'ActivitySource del layer
Application/Behaviors/LoggingBehavior.cs       apre lo span di ogni comando
```

L'instrumentation vive **soltanto nel progetto `Api`**, il guscio HTTP. `Application` non ha alcun
pacchetto OpenTelemetry: emette i suoi span attraverso `ActivitySource`, che appartiene a
`System.Diagnostics` nel framework base.

Non è un dettaglio stilistico. I test di architettura vietano ad `Application` di dipendere da
ASP.NET e dal provider di database, per la stessa ragione per cui deve restare indipendente dal
sistema di observability: è una scelta infrastrutturale, e domani potrebbe cambiare. Il prezzo di
questa indipendenza è un'unica costante condivisa — il nome della sorgente — e in cambio il layer
applicativo non sa nemmeno che la telemetria esiste.

Quando nessuno è in ascolto, `StartActivity` restituisce `null` e il costo a runtime è
trascurabile: è il motivo per cui `LoggingBehavior` può aprire uno span incondizionatamente.

## Il pacchetto in prerelease

`OpenTelemetry.Instrumentation.EntityFrameworkCore` è l'unico pacchetto del gruppo in versione
beta. Non è una svista: per EF Core non esiste una release stabile, perché EF espone un
`DiagnosticSource` e non un `ActivitySource` proprio, e serve quindi un adapter. È la versione
correntemente in uso anche in produzione altrove, ed è annotata nel `.csproj` come da riportare a
una stabile appena verrà pubblicata.

Chi preferisse evitare del tutto le prerelease può rimuovere quel pacchetto e la riga
`AddEntityFrameworkCoreInstrumentation()`: si perde il livello SQL nell'albero delle tracce — che
è però il più interessante.

## Convive con l'`ErrorLog`

Il template ha già una tabella `ErrorLogs`, alimentata da un endpoint pubblico su cui il frontend
riporta i propri errori. Non è stata rimossa e continua a funzionare: sopravvive a un riavvio, è
interrogabile in SQL e non richiede alcuna infrastruttura esterna.

Le due cose coprono però bisogni vicini, e conviene sapere qual è la differenza: `ErrorLogs`
registra **gli errori del frontend**, la telemetria racconta **il comportamento del backend**. Se
un giorno la telemetria coprirà anche il browser — OpenTelemetry ha un SDK per il frontend, che
porterebbe il clic dell'utente e la query SQL nella stessa traccia — sarà il momento di decidere
se `ErrorLogs` ha ancora senso.

## Da qui

- [Leggere i valori](#leggere-i-valori) — che cosa significano gli attributi e le metriche
- [Configurazione](../progetto/configurazione.md) — tutte le chiavi e come si sovrascrivono
- [Deploy su Render](render.md) — dove impostare le variabili d'ambiente in produzione
- [Clean Architecture](../architettura/clean-architecture.md) — perché `Application` resta senza
  dipendenze infrastrutturali
