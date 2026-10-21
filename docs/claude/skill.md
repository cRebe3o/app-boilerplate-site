# Le skill e i comandi

Un progetto generato porta con sé una cartella `.claude/` con le sue **skill** e i suoi
**comandi**. Sono
istruzioni scritte, versionate insieme al codice, che Claude Code carica quando il compito
corrisponde: descrivono come si scrive *in questo progetto* una slice, un'entità, una pagina, un
test.

Non sono generatori di codice a scatola chiusa. Sono il modo in cui le convenzioni del template
restano applicate anche mesi dopo, quando nessuno ricorda più perché gli endpoint non contengono
logica o perché ogni entità richiede due migration.

> **A che cosa servono davvero.** Il valore del boilerplate non è solo il codice iniziale: è che il
> codice aggiunto dopo continui ad assomigliargli. Le skill sono quel meccanismo — la
> documentazione operativa che l'assistente legge da sé.

## Come si usano

Nella maggior parte dei casi non serve invocarle: ogni skill dichiara i propri *trigger*, e Claude
Code la carica quando la richiesta li tocca. Chiedere "aggiungi l'endpoint per creare le categorie"
attiva `backend-slice`; parlare di paginazione attiva `pagination`.

Si possono comunque richiamare per nome quando si vuole essere espliciti sul pattern da seguire.

## Backend

| Skill | Quando si attiva |
|---|---|
| **`backend-slice`** | Qualsiasi nuova operazione di backend: comando o query, handler, validator, response. È la skill centrale del backend. Sa che i comandi usano repository + `IUnitOfWork` e le query `IReadDbContext`, e che ogni endpoint con body dichiara `.Produces<T>()` perché il frontend ne generi il tipo |
| **`domain-modeling`** | Modellare una regola di business: che cosa è un aggregato, dove vive una regola, quando serve un value object, un domain service, un evento o una specification. Vedi [Dove mettere la logica](../architettura/dove-mettere-la-logica.md) |
| **`db-entity`** | Una nuova entità: l'aggregato in `Domain/`, la sua `IEntityTypeConfiguration`, il repository e la **doppia migration** SQL Server + Postgres |
| **`audit-log`** | Come funziona l'audit automatico via `AuditLogInterceptor` e che cosa deve fare un repository perché lo snapshot *prima* sia corretto. Un handler non scrive mai l'audit a mano. Vedi [Audit log](../infrastructure/audit-log.md) |
| **`permissions`** | Un permesso nuovo end-to-end: policy sull'endpoint, guardia di rotta, `v-if` nella UI e voce nel seed |
| **`pagination`** | Una lista che deve paginare lato server: `PagedResponse` sul backend, `v-data-table-server` sul frontend |
| **`search-filter`** | Ricerca testuale o filtri su una lista, con il `Where` dinamico lato EF e il debounce lato Vue |
| **`bulk-operations`** | Cancellazioni o modifiche multiple, con `ExecuteDelete`/`ExecuteUpdate` e la selezione a checkbox |
| **`export-csv`** | Esportazione dei dati in CSV o Excel: endpoint che genera il file e pulsante di download |
| **`file-upload`** | Upload di file con `IFormFile`, storage e anteprima lato client |
| **`soft-delete`** | Cancellazione logica con `IsDeleted` e query filter globale. **Da usare solo se richiesto esplicitamente**: il default del template è la cancellazione fisica |

## Frontend

| Skill | Quando si attiva |
|---|---|
| **`vue-feature`** | Una nuova feature di frontend completa: tipi da `pnpm gen:api`, service, store con `useAsyncAction`, pagina, rotta figlia di AppShell, voce di menu in `sections.config.ts`, traduzioni. Vedi [Convenzioni e flussi](../frontend/convenzioni.md) |
| **`detail-page`** | Una pagina di dettaglio su rotta `:id(\\d+)`, che serve creazione e modifica, con `useBackNavigation` per il ritorno e `useApiErrors` per gli errori per campo |
| **`vuetify-dialog-form`** | Un dialog di creazione o modifica in `components/<dominio>/`: validazione, `attempt()` per chiudersi solo se il salvataggio riesce, reset all'apertura, un solo componente per create ed edit |

## Test

| Skill | Quando si attiva |
|---|---|
| **`frontend-testing`** | Qualsiasi test del frontend. Una sola skill per tutti i tipi, perché condividono le stesse regole (che cosa si mocka, la forma degli errori simulati, `flushPromises`): service con `api` mockato, store (`run` che non rilancia, `runOrThrow` che rilancia, `reload`, `loading`), componenti, dialog con form (non valido, salvataggio riuscito, fallito), pagine con router in memoria, e la configurazione di Vitest |

I test del backend non hanno una skill: le regole sono in `apps/backend/CLAUDE.md` e in
[Testare il backend](../guide/test-backend.md).

## I comandi

Oltre alle skill, cinque comandi per le operazioni ricorrenti. Tecnicamente sono skill anche
loro, in `.claude/skills/`, ma con `disable-model-invocation: true` nell'intestazione: Claude
non li avvia mai da solo, partono solo quando li scrivi. È la differenza voluta fra *sapere come
si fa* una cosa (una skill, che si carica da sola) e *farla* (un comando, che crea file e
genera migration).

| Comando | Che cosa fa |
|---|---|
| `/new-feature <Entità>` | Crea una feature CRUD completa end-to-end, backend e frontend, passando da un piano che approvi tu |
| `/add-field <Entità>` | Aggiunge un campo a un'entità esistente, lo propaga su tutti i punti che lo richiedono e verifica |
| `/remove-field <Entità>` | L'operazione inversa: chiede conferma prima della migration che cancella i dati |
| `/review` | Rilegge le modifiche del branch rispetto a `main` (o i percorsi indicati) contro le convenzioni del progetto, senza modificare file |
| `/fix <descrizione>` | Trova la causa di un bug, la dimostra con un test, la corregge e verifica; segnala lo stesso errore se lo trova altrove |

## Le combinazioni che ricorrono

Le skill sono pensate per comporsi, e le richieste reali ne toccano quasi sempre più d'una:

```
Una nuova entità di dominio, dal modello alla pagina
   domain-modeling  →  db-entity  →  backend-slice  →  audit-log  →  permissions
                                                                                   │
                                                             vue-feature  ←─────────┘
                                                                   │
                                                  vuetify-dialog-form  ·  detail-page
```

Una lista che deve crescere: `pagination` e `search-filter` insieme, perché il filtro va applicato
prima della paginazione e non dopo.

## Quando la skill non basta

Le skill coprono i pattern del template. Se una richiesta esce da quei binari — una integrazione
esterna, un calcolo di dominio, un job schedulato — vale la pena scriverne una nuova nella stessa
cartella: è versionata con il progetto, e da lì in avanti quel pattern diventa ripetibile come gli
altri.

Le skill che nascono nei progetti e si rivelano generali sono anche il canale naturale per
migliorare il template: portate in `app-boilerplate`, arrivano a tutti i progetti al successivo
[`copier update`](../progetto/generazione.md#aggiornare-un-progetto-quando-il-template-cambia).

## Da qui

- [Aggiungere una feature](../guide/nuova-feature.md) — lo stesso percorso delle skill, spiegato per esteso
- [Panoramica](../progetto/panoramica.md) — le convenzioni che le skill applicano
- [Contribuire al template](../progetto/contribuire.md) — come una skill nata in un progetto torna al template
