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
├─ Autenticazione JWT                                   4ms
├─ CreateRentalContractCommand                       1230ms
│  ├─ SELECT ... FROM Customers WHERE Id = @p0          8ms
│  ├─ SELECT MAX(Sequence) FROM RentalContracts      1180ms  ←
│  └─ INSERT INTO RentalContracts                      35ms
└─ Risposta 201                                         6ms
```

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
a valle.

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

- [Configurazione](../progetto/configurazione.md) — tutte le chiavi e come si sovrascrivono
- [Deploy su Render](render.md) — dove impostare le variabili d'ambiente in produzione
- [Clean Architecture](../architettura/clean-architecture.md) — perché `Application` resta senza
  dipendenze infrastrutturali
