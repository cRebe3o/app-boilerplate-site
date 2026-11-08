# Convenzioni e flussi

[Struttura del progetto](struttura.md) dice *dove* sta ogni cosa. Questa pagina dice *come* le
parti collaborano quando si scrive una feature: il giro di una lista paginata, la gestione degli
errori, i dialog, i permessi, la navigazione, i test. Sono le regole che le skill `vue-feature`,
`detail-page` e `vuetify-dialog-form` applicano, e che `/review` verifica.

## Il flusso di una feature

```
tipi (gen:api)  →  service  →  store  →  pagina  →  rotta + menu + testi
```

L'ordine è quello delle dipendenze: si parte da ciò che non dipende da nulla (i tipi generati dal
backend) e si arriva alla rotta, che dipende da tutto.

| # | Passo | File | Che cosa produce |
|---|---|---|---|
| 1 | Tipi | `pnpm gen:api`, poi `types/api.types.ts` | gli alias `Supplier`, `CreateSupplierRequest`, … |
| 2 | Service | `services/suppliers.service.ts` | un metodo per endpoint |
| 3 | Store | `stores/suppliers.store.ts` | stato + azioni con `useAsyncAction` |
| 4 | Pagine | `pages/suppliers/SuppliersPage.vue`, `SupplierDetailPage.vue` | lista e dettaglio |
| 5 | Componenti | `components/suppliers/` | dialog, card, picker |
| 6 | Rotte | `router/index.ts` | figlie di AppShell, con `title` e `section` |
| 7 | Menu | `config/sections.config.ts` | la voce con il suo `permission` |
| 8 | Testi | `locales/it.ts` e `en.ts` | `routes.*`, `nav.*`, `suppliers.*`, `errors.*` |
| 9 | Verifica | `pnpm vue-tsc --noEmit`, `pnpm eslint .`, `pnpm vitest run` | — |

## Tipi: generati dal backend

```bash
pnpm gen:api      # con il backend avviato: legge /openapi/v1.json e scrive api.generated.ts
```

Poi l'alias, in `api.types.ts`:

```typescript
export type Supplier = Schemas['SupplierResponse']
export type CreateSupplierRequest = Schemas['CreateSupplierCommand']
```

Se il tipo **non compare** nel file generato, la causa è quasi sempre nel backend: l'endpoint
dichiara `.Produces(200)` senza il tipo. Con `.Produces<SupplierResponse>(200)` lo schema lo
descrive e il frontend lo vede. Non si aggira scrivendo l'interfaccia a mano: si corregge l'endpoint.

## Lo store: `useAsyncAction`

Ogni azione di uno store passa da `useAsyncAction`, che tiene `loading`, `error` e `loadFailed` e
gestisce l'errore in un punto solo. `loadFailed` dice che l'ultima **lettura** è fallita, ed è
separato da `error`: chiuso l'avviso, `error` torna vuoto ma la lista continua a sapere che i suoi
dati non sono caricati. Tre modi, per tre esigenze:

| Funzione | Per | Comportamento |
|---|---|---|
| `run(fn, 'errors.loadX')` | **letture** | l'errore finisce in `error`, la promise si risolve con `undefined`. La pagina mostra `store.error` se valorizzato, senza try/catch |
| `runOrThrow(fn, 'errors.createX')` | **scritture** | l'errore finisce in `error` **e viene rilanciato**: chi chiama sa se chiudere il dialog |
| `attempt(fn, 'errors.confirmX')` | **dialog e componenti** | come `runOrThrow`, ma restituisce `true`/`false`: "se riesce chiudi" è un `if` |

```typescript
// nel componente di un dialog
if (await attempt(() => store.confirm(id), 'errors.confirmOrder')) dialog.value = false
```

**Il messaggio lo dice il backend, il testo lo scrive il frontend.** Il ProblemDetails porta un
`code` (un codice di `ErrorCode`, del template o del progetto) e i suoi `params`: `extractApiError` lo traduce con
`errors.codes.<code>` — "Username 'mario' già in uso", "I ruoli di sistema non possono essere
eliminati". Le eccezioni di dominio hanno sempre un codice; un codice senza traduzione mostra il
`detail`, che il backend scrive in inglese. Gli errori di validazione arrivano in `fieldErrors`, uno
per campo, con lo stesso codice e i suoi parametri. La chiave i18n passata a `run`/`runOrThrow` è solo il **fallback** per un
4xx che non è un ProblemDetails; rete assente, timeout e 5xx hanno i loro messaggi
(`errors.serverUnreachable`, `errors.serverError`).

Due errori ricorrenti che la review intercetta:

- **`try/catch` scritto a mano** in un'azione: `loading` ed `error` finiscono fuori sincrono, e il
  messaggio diventa generico.
- **`run` su una scrittura**: il dialog si chiude anche se il salvataggio è fallito, perché la
  promise si risolve comunque.

### Liste paginate: `reload()` con l'ultima query

Le liste sono paginate e ordinate dal server, quindi dopo una scrittura **non si appende** alla
lista: si ricarica. Lo store tiene l'ultima query e la riusa, così l'utente non torna a pagina 1 e
non perde la ricerca:

```typescript
let lastQuery: SupplierListParams | undefined

const fetchSuppliers = async (params?: SupplierListParams) => {
  await run(async () => {
    lastQuery = params
    const res = await suppliersService.getAll(params)
    suppliers.value = res.items
    totalCount.value = res.totalCount       // dal backend: mai items.length
  }, 'errors.loadSuppliers')
  // lettura fallita: la lista si svuota
  if (loadFailed.value) {
    suppliers.value = []
    totalCount.value = 0
  }
}

const reload = () => fetchSuppliers(lastQuery)
```

Lo svuotamento dopo una lettura fallita non è un dettaglio: riaprendo la lista dal menu con il
backend giù, senza, resterebbero le righe della volta prima, e chiuso l'avviso sembrerebbero dati
appena caricati. Lo store espone `loadFailed` insieme a `loading` ed `error`.

## La pagina lista: `useServerTable`

`useServerTable` raccoglie la meccanica che ogni lista ripeteva: tradurre le opzioni di
`v-data-table-server` in parametri di query, azzerare la pagina quando cambiano ricerca o filtri,
evitare la doppia fetch quando Vuetify emette più eventi per la stessa azione, e tenere tutto
**nell'indirizzo**.

```vue
<script setup lang="ts">
const store = useSuppliersStore()
const { can } = usePermission()
const toast = useToastStore()

// un filtro della pagina: il valore iniziale del ref è il default
const active = ref<boolean | null>(null)
const { search, page, itemsPerPage, sortBy, onOptionsUpdate, reload, clearFilters } = useServerTable(
  query => store.fetchSuppliers({ ...query, isActive: active.value ?? undefined }),
  { totalCount: () => store.totalCount, filters: { active } }
)

// lista senza righe: caricamento fallito, nessun risultato o lista davvero vuota
const emptyState = computed(() => ({
  error: store.loadFailed,
  filtered: !!search.value || active.value !== null,
  createLabel: can('suppliers.write') ? t('suppliers.createButton') : undefined,
}))

const headers = computed(() => [
  { title: t('suppliers.name'), key: 'name' },
  { title: t('common.actions'), key: 'actions', sortable: false, align: 'end' as const },
])
</script>

<template>
  <v-text-field v-model="search" :label="t('common.search')" prepend-inner-icon="mdi-magnify" clearable />

  <v-data-table-server
    :headers="headers" :items="store.suppliers" :items-length="store.totalCount"
    :loading="store.loading" :page="page" :items-per-page="itemsPerPage"
    :items-per-page-options="ITEMS_PER_PAGE_OPTIONS" :sort-by="sortBy"
    @update:options="onOptionsUpdate"
  >
    <template #no-data>
      <list-empty-state v-bind="emptyState" @retry="reload" @clear-filters="clearFilters" @create="openCreate" />
    </template>
  </v-data-table-server>

  <supplier-dialog v-model="showDialog" :item="editing" @saved="reload(); toast.success(t('common.saved'))" />
</template>
```

Da notare:

- Si ascolta **solo `@update:options`**, non i singoli `@update:page` / `@update:sort-by`: un cambio
  di "righe per pagina" fa emettere a Vuetify anche `update:page`, e con listener separati si
  avrebbero due fetch per un gesto.
- La **ricerca è in debounce** (400 ms) e riporta a pagina 1: con un filtro nuovo, la pagina 5 può
  non esistere più.
- `:items-per-page-options` è **esplicito**: il default di Vuetify include "Tutti" (`-1`), che con
  migliaia di record è una risposta enorme. Per estrarre tutto c'è l'export CSV.
- `totalCount` riporta all'ultima pagina valida quando un'eliminazione svuota quella corrente.

### Lo stato nell'indirizzo

Pagina, righe per pagina, ricerca, ordinamento e filtri stanno nella query:
`?page=3&q=rossi&sort=name&desc=1&active=1`. Tornando dal dettaglio con "indietro", ricaricando o
aprendo un link copiato, la lista si ripresenta com'era. Le regole:

- i **filtri della pagina** vanno in `filters`: la chiave è il nome nell'indirizzo, il valore
  iniziale del ref è il default. Un filtro cambiato riporta a pagina 1 e ricarica da solo, senza un
  `watch` scritto a mano; il fetcher li legge dai ref;
- **`:sort-by="sortBy"` va legato**: l'ordinamento letto dall'indirizzo deve arrivare alla tabella,
  altrimenti la lista è ordinata ma l'intestazione non lo mostra;
- **`clearFilters()`** toglie ricerca e filtri con una sola richiesta, tenendo righe per pagina e
  ordinamento: è il pulsante "Azzera filtri";
- l'indirizzo si aggiorna con `router.replace`, quindi digitare una ricerca non riempie la history,
  e i valori uguali al default non compaiono. Le altre chiavi, come `from`, restano;
- un clic nel menu sulla lista in cui si è già la riporta all'indirizzo pulito, e la lista ricarica.

Il meccanismo è `useRouteQueryState`, che si usa anche da solo nelle liste **non paginate dal
server** (`v-data-table`, come `GroupsPage`, `RolesPage`, `PermissionsPage`) per tenere ricerca e
pagina nell'indirizzo.

### La lista vuota: `ListEmptyState`

Una tabella senza righe direbbe sempre "Nessun dato", ma i casi sono tre e chiedono gesti diversi.
`ListEmptyState`, nello slot `#no-data` della tabella e sotto l'elenco per telefono, li distingue:

| Caso | Prop | Mostra |
|---|---|---|
| lettura fallita | `error` (da `store.loadFailed`) | "Dati non caricati" con **Riprova** (`@retry`) |
| ricerca o filtri senza risultati | `filtered` | "Nessun risultato" con **Azzera filtri** (`@clear-filters`) |
| lista davvero vuota | — | "Ancora nessun elemento" con il pulsante per creare, se c'è `createLabel` |

`createLabel` si passa solo con il permesso di scrittura; con `createTo` il pulsante apre una
rotta, senza emette `create` (per aprire un dialog). Il motivo dell'errore resta nell'avviso della
pagina: `ListEmptyState` offre solo di riprovare.

### Telefono e tablet

Sotto i **960 px** la tabella lascia il posto a una `v-list`: decide `useDisplay().mobile`, con la
soglia fissata in `plugins/vuetify.ts` (`display.mobileBreakpoint: 'md'`). Si usa `mobile`, non
`smAndDown` (600 px): così il tablet verticale ha l'elenco e quello orizzontale la tabella.

L'elenco non ha il piè di pagina della tabella: lo pagina `MobileListPager`, con `page`, `total` e
`itemsPerPage` e l'evento `update:page`, che la pagina gira a `useServerTable`:

```typescript
function goToPage(newPage: number) {
  page.value = newPage
  reload()
}
```

I suoi pulsanti sono da 48 px (`density="default"`), grandi abbastanza per il dito; gli altri
pulsanti dell'app restano `compact`. Il riferimento completo, tabella ed elenco, è `UsersPage`.

## La pagina di dettaglio

La stessa pagina serve **creazione e modifica**: la distinzione è la presenza di `:id`.

```typescript
const isCreate = route.name === 'supplier-create'
const supplierId = Number(route.params.id)          // il param è una stringa, l'id è number
const { goBack } = useBackNavigation({ name: 'suppliers' })
const { fieldErrors, generalError, handleError, clearErrors } = useApiErrors()
```

Il form è sempre un `v-form` con `ref` e `validate()` prima del submit. Gli errori hanno due
livelli, e `useApiErrors` li separa:

- **per campo** — il `400` di FluentValidation porta `fieldErrors: { Name: [{ code, params, message }] }`,
  tradotti come sopra; `fieldErrors.name` (chiave lowercase) va in `:error-messages` del campo;
- **generale** — il codice tradotto o il `detail` del ProblemDetails (404, 409), oppure il fallback,
  in un `v-alert`.

```vue
<v-alert v-if="generalError" type="error" class="mb-4">{{ generalError }}</v-alert>
<v-text-field v-model="form.name" :rules="[rules.required]" :error-messages="fieldErrors['name']" />
```

Dopo il salvataggio: toast di successo e `goBack()`. Il breadcrumb non lo costruisce la pagina —
lo genera `AppBreadcrumb` dai `meta.title` delle rotte, e la barra resta fissa in cima anche nelle
pagine lunghe.

### Le modifiche non salvate: `useUnsavedChanges`

Un form con modifiche non si perde in silenzio:

```typescript
const { markClean } = useUnsavedChanges(() => form)
onMounted(async () => { await load(); markClean() })     // anche in creazione
async function save() { await store.update(id, form); markClean(); goBack() }
```

`markClean()` fissa i dati "salvati": dopo il caricamento e dopo un salvataggio riuscito. Da lì una
differenza (per valore, non per riferimento: tornare al valore iniziale non conta) è una modifica,
e:

- lasciando la pagina — link, menu, tasto indietro — l'app chiede conferma con il suo dialog;
  rispondendo no si resta dove si è;
- chiudendo o ricaricando la scheda compare l'avviso del browser, l'unico possibile lì;
- "Esci" chiede prima di chiudere la sessione (`confirmUnsavedChanges()`);
- a sessione scaduta si esce senza domande: non si potrebbe più salvare.

Lo usano `UserDetailPage`, `GroupDetailPage`, `RoleDetailPage` e `ConfigurationPage`.

### Il ritorno: `useBackNavigation`

Il pulsante indietro **non è un link alla lista**. Una pagina di dettaglio ha più ingressi (la
lista, una dashboard, un'altra entità che la referenzia) e un back cablato sulla lista riporta
sempre lì. `goBack()` applica tre regole in cascata:

1. **`?from=<origine>`** dichiarato da chi apre il dettaglio: si torna lì. Sopravvive al refresh e
   al link condiviso, e il breadcrumb mostra la stessa provenienza. Se la pagina precedente nella
   history è proprio l'origine, `goBack()` fa un back reale, così la lista torna con i suoi filtri;
   altrimenti apre l'origine.
2. **History del browser**: senza `from`, se si è arrivati navigando dentro l'app si fa un back
   reale, che ripresenta la lista con filtri, pagina e scroll intatti.
3. **Fallback**: link incollato o apertura diretta → la lista.

Chi apre il dettaglio dichiara da dove arriva:

```vue
:to="{ name: 'supplier-detail', params: { id: item.id }, query: { from: 'suppliers' } }"
```

Le origini ammesse sono un **dizionario chiuso** (`ORIGINS` in `useBackNavigation.ts`), perché
`from` arriva dall'URL e non deve diventare una destinazione arbitraria. Ogni feature con dettaglio
aggiunge una riga per ogni punto da cui ci si arriva.

## I dialog

Un dialog è **sempre un componente separato** in `components/<dominio>/`, mai inline nel template
della pagina. Regole:

- `v-model` di tipo `ref<boolean>`, mai `string | null`;
- il dialog riceve l'elemento da modificare come prop (`item: Supplier | null`) e capisce da solo se
  è creazione o modifica;
- al chiudersi resetta il form (`watch` su `modelValue`);
- **scrive tramite lo store** e usa `attempt` per decidere se chiudersi;
- emette `saved`: è la pagina a fare `reload()` e a mostrare il toast.

Un dialog **con un form** in più:

- va a schermo intero sul telefono, `:fullscreen="mobile"`;
- usa `useUnsavedChanges` solo mentre è aperto, e "Annulla" passa da `confirmDiscard()`:

```typescript
const { markClean, confirmDiscard } = useUnsavedChanges(() => form, { active: () => props.modelValue })

// all'apertura, dopo aver riempito il form: markClean()
async function cancel() {
  if (await confirmDiscard()) emit('update:modelValue', false)
}
```

Il riferimento nel template è `ChangePasswordDialog`, che è anche `persistent`: un clic fuori non
butta via la password scritta.

La conferma di cancellazione è `ConfirmDialog` di `components/shared/`: `v-model`, `message`,
`loading`, `confirmText` facoltativo, evento `confirm`. Non se ne scrive una nuova per dominio. Dove
il dialog non può stare nel template di chi chiede — una guardia del router, come quella delle
modifiche non salvate — si usa `useConfirmStore().ask({ message, title, confirmText })`, che
restituisce una promise con la risposta; la mostra l'unico `GlobalConfirm`, in `App.vue`. Il messaggio dice **che cosa** si
elimina — "Eliminare il gruppo 'Amministratori'?" —, così non si conferma sulla riga sbagliata: la
pagina tiene l'elemento intero, non solo l'id, e la traduzione ha il segnaposto `{name}`, riempito
con `shortName` (`src/utils/text.ts`), che accorcia con "…" oltre i 40 caratteri.

## Toast e messaggi

Una sola `v-snackbar`, in `App.vue`, pilotata da `useToastStore()`: `success` (3 s), `error` (5 s),
`warning`, `info`. Dopo una scrittura riuscita: `toast.success(t('common.saved'))`. Gli errori
invece **non** vanno in un toast: restano nel `v-alert` della pagina o del dialog, dove l'utente può
leggerli e agire.

## Permessi

Lo stesso permesso `risorsa.azione` del backend, verificato in tre punti del frontend:

| Punto | Come | Effetto |
|---|---|---|
| Rotta | `meta.permission: 'suppliers.read'` | il guard manda alla home con un toast |
| Menu | `permission: 'suppliers.read'` nella voce di `sections.config.ts` | la voce non compare; se nessuna voce della sezione è accessibile, sparisce la sezione |
| Pulsante | `v-if="can('suppliers.write')"` | il pulsante non esiste (`v-if`, non `v-show`) |

I permessi arrivano da `auth.store` (risposta di login e di refresh), non da una decodifica del JWT
nel browser. E nascondere un pulsante è cortesia: a **negare** è sempre il backend.

## Rotte, sezioni, testi

Ogni pagina nuova tocca tre file, sempre gli stessi:

```typescript
// router/index.ts — figlia di AppShell, con il prefisso della sezione
{
  path: 'suppliers',
  name: 'suppliers',
  component: () => import('@/pages/suppliers/SuppliersPage.vue'),
  meta: { requiresAuth: true, permission: 'suppliers.read', title: 'routes.suppliers', section: 'system' },
},
{
  path: 'suppliers/:id(\\d+)',       // doppio backslash, altrimenti la rotta non matcha mai
  name: 'supplier-detail',
  component: () => import('@/pages/suppliers/SupplierDetailPage.vue'),
  meta: { requiresAuth: true, permission: 'suppliers.read', title: 'routes.supplierDetail', section: 'system' },
},
```

```typescript
// config/sections.config.ts — la voce di menu
{ titleKey: 'nav.suppliers', subtitleKey: 'suppliers.subtitle', icon: 'mdi-truck',
  color: 'primary', to: '/system/suppliers', permission: 'suppliers.read' },
```

```typescript
// locales/it.ts (e en.ts)
routes: { suppliers: 'Fornitori', supplierDetail: 'Dettaglio fornitore' },
nav: { suppliers: 'Fornitori' },
suppliers: { title: 'Fornitori', subtitle: 'Anagrafica fornitori', name: 'Ragione sociale', … },
errors: { loadSuppliers: 'Errore nel caricamento dei fornitori', createSupplier: '…' },
```

Una **sezione nuova** è un oggetto in `SECTIONS` con `id`, `labelKey`, `icon`, `dashboardTo` e
`items`; le sue rotte usano quell'`id` in `meta.section`. Tab, drawer e dashboard di sezione si
aggiornano da soli.

**Un numero accanto a un testo usa sempre le forme singolare e plurale di vue-i18n**, mai
un'etichetta fissa, che con 1 direbbe "1 ordini":

```typescript
// locales/it.ts (e en.ts)
suppliers: { orderCount: '{count} ordine | {count} ordini' },

// nel template: il numero sceglie la forma e riempie {count}
t('suppliers.orderCount', item.orderCount)
```

Con due forme lo 0 prende la seconda ("0 ordini"); se ha un testo suo si scrivono tre forme. La
regola non serve per un numero fisso ("almeno 8 caratteri"). Nei testi tradotti niente abbreviazioni
italiane come `gg`: si scrive la parola intera, `/giorno` e `/day`.

## Vuetify

- Componenti Vuetify per tutto: niente CSS custom se esiste un componente. Icone `mdi-*`.
- Colori dal tema (`color="primary"`, `color="error"`), mai esadecimali nel template.
- Layout `v-container` → `v-row` → `v-col`; per telefono e tablet verticale si controlla
  `useDisplay().mobile` (sotto i 960 px), non `smAndDown`.
- I `defaults` in `plugins/vuetify.ts` fissano `outlined` + `compact` per gli input e `rounded: 0`:
  non si ripetono nei componenti.
- I testi dei componenti ("Elementi per pagina", "1-2 di 2") seguono la lingua di vue-i18n, tramite
  l'adapter in `plugins/vuetify.ts`. Una lingua nuova va aggiunta anche ai messaggi `$vuetify` in
  `plugins/i18n.ts`.
- Slot con il punto nel nome (`#item.actions` di `v-data-table`) sono ammessi: ESLint è configurato
  per accettarli.

## Dimensioni: quando spezzare

Una **pagina** sopra le ~300 righe e un **componente** sopra le ~200 stanno facendo più di un
lavoro. ESLint lo segnala come avviso (`max-lines`): non blocca la build, ma la review lo legge.

Il rimedio, in ordine:

1. i dialog in `components/<dominio>/XxxDialog.vue`;
2. le sezioni con stato proprio in card o picker (`RolePermissionsPicker` è l'esempio nel
   template: `RoleDetailPage` gli delega la scelta dei permessi, con `v-model` sugli id);
3. la logica ripetuta in un composable.

Si spezza per **responsabilità**, non a metà: un componente estratto deve avere un nome che dice
che cosa fa.

## Formattazione: `useFormatters`

Date e valute passano da `useFormatters()`, che usa la lingua corrente (`it-IT` / `en-GB`):

```typescript
const { currency, date } = useFormatters()
currency(1234.5)               // "1.234,50 €"
currency(total, { maximumFractionDigits: 0 })   // per le dashboard, senza centesimi
date(item.createdAt)           // "08/09/2026", oppure "—" se assente
```

Nessuna pagina chiama `toLocaleDateString('it-IT')`: un utente in inglese vedrebbe comunque il
formato italiano.

## Chiamate API e sessione

L'istanza `api` in `plugins/axios.ts` fa da sola ciò che un componente non deve nemmeno sapere:

- aggiunge `Authorization: Bearer` e `Accept-Language` a ogni richiesta;
- su **401** tenta **una volta** il refresh (`POST /api/auth/refresh`, cookie HttpOnly) e ripete la
  richiesta; se il refresh fallisce, logout. Con più 401 in parallelo il refresh è uno solo;
- le chiamate `/api/auth/*` sono escluse dal meccanismo, altrimenti un login sbagliato innescherebbe
  un refresh;
- su **5xx** invia un `ErrorLog` al backend (fire-and-forget), escluso l'endpoint dei log stessi;
- avvia e ferma il timer del banner "server in riattivazione".

Nessuna chiamata `axios` o `fetch` fuori dai service.

## Test

Vitest + jsdom, test **accanto al file** (`users.store.test.ts`, `RolePermissionsPicker.test.ts`).
`vitest.setup.ts` installa a ogni `mount` i plugin i18n e Vuetify dell'app, quindi i `v-*` si
montano veri e i testi sono quelli di `it.ts`, e aggiunge i mock di `matchMedia`, `ResizeObserver` e
`localStorage`. Pinia no: ogni test la crea nel `beforeEach`, così lo stato non passa da un test
all'altro. Un errore non gestito o un `[Vue warn]` fa fallire il test in cui compare: per esempio un
tag che non trova il suo componente.

La regola: **si mocka il service, mai la rete**. Lo store si testa reale, con risposte controllate:

```typescript
vi.mock('@/services/customers.service', () => ({
  customersService: { getAll: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}))
const service = vi.mocked(customersService)

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

it('una scrittura fallita registra l'errore E rilancia', async () => {
  service.create.mockRejectedValue({
    response: {
      status: 409,
      data: {
        code: 'TaxCodeTaken',
        params: { taxCode: '00743110157' },
        detail: 'A customer with tax code 00743110157 already exists.',
      },
    },
  })
  const store = useCustomersStore()

  await expect(
    store.create({ name: 'X', taxCode: '00743110157', creditLimit: 0, email: null, phone: null })
  ).rejects.toBeDefined()
  // il codice tradotto da errors.codes, non il detail inglese né il fallback
  expect(store.error).toBe('Esiste già un cliente con codice fiscale 00743110157')
})
```

Gli errori simulati hanno la forma di un AxiosError, `{ response: { status, data } }`: è ciò che
legge `extractApiError`. Con un `code` mostra la sua traduzione in `errors.codes`, riempita con i
`params`; il `detail` inglese serve solo quando il codice manca. Un `new Error('x')` fa scattare il
fallback i18n, ed è un caso da testare a parte.

Due cose da sapere quando si testa una pagina:

- **jsdom ha una finestra di 1024 px**, sopra la soglia dei 960: il layout è quello con la tabella.
  Per provare l'elenco del telefono, o per non dipendere dalla larghezza, si fissa `mobile` con
  `vi.mock('vuetify', ...)`, come in `listPages.errors.test.ts`.
- **`useUnsavedChanges` ricorda i form montati**, per "Esci": un form lasciato montato da un test,
  con modifiche, cambia la risposta del test dopo. Un file che usa `confirmUnsavedChanges` o monta
  più form con modifiche chiama `enableAutoUnmount(afterEach)`. La domanda si risponde con
  `useConfirmStore().answer(true)` o `answer(false)`.

Che cosa testare, per tipo di file:

| File | Test | Skill |
|---|---|---|
| store | stato iniziale; ogni lettura (dati e parametri); lettura fallita → `error` e `loadFailed` senza throw, lista svuotata; scrittura fallita → `error` e promise rigettata; `reload` con l'ultima query; `loading` durante | `frontend-testing` |
| service | URL, parametri e payload con `toHaveBeenCalledWith`; 4xx con ProblemDetails; errore di rete | `frontend-testing` |
| componente | prop, eventi, `v-model`, slot; per un dialog con form: non valido, salvataggio riuscito (si chiude), fallito (resta aperto con il messaggio del backend) | `frontend-testing` |
| pagina | mount con router in memoria, service mockato, store reale; caricamento, un'interazione, l'errore visibile, la ricarica dopo una scrittura. `flushPromises()`, mai `setTimeout` | `frontend-testing` |

Un testo con un numero si prova con 0, 1 e più, in entrambe le lingue: le traduzioni sono già quelle
vere, si sceglie la lingua con `i18n.global.locale.value`. La ricetta è nella skill `vue-feature`.

Le soglie di coverage in `vitest.config.ts` sono il livello raggiunto: impediscono di peggiorare e
vanno alzate man mano.

## Verifica

Prima di dichiarare finita una feature, da `apps/frontend`:

```bash
pnpm vue-tsc --noEmit     # tipi: un campo rinominato nel backend si vede qui
pnpm eslint .             # lint: 0 errori; gli avvisi max-lines vanno letti
pnpm vitest run           # test
pnpm build                # vue-tsc + vite build, lo stesso target Nx di `pnpm build` in radice
```

Dalla radice del monorepo gli stessi comandi sono `pnpm typecheck:frontend`, `pnpm lint:frontend`,
`pnpm test:frontend`, `pnpm build`.

## Gli errori che la review cerca

- Store con `try/catch` a mano invece di `run`/`runOrThrow`.
- Scrittura con `run`: il dialog si chiude anche se il salvataggio è fallito.
- Lista che dopo una scrittura ricarica da pagina 1 invece di `reload()`.
- Un `watch` scritto a mano per riportare a pagina 1 quando cambia un filtro, invece di `filters`;
  `:sort-by` non legato; lista senza `ListEmptyState`.
- Store di una lista che dopo una lettura fallita tiene le righe di prima.
- Form senza `useUnsavedChanges`; dialog con un form non a schermo intero sul telefono.
- `smAndDown` per decidere fra tabella ed elenco, invece di `mobile`.
- Rotta con `'\d+'` invece di `'\\d+'`: non matcha mai.
- Tipo dell'API scritto a mano invece di generato (di solito perché manca `.Produces<T>()` nel backend).
- `import.meta.env` fuori da `app.config.ts`; `axios` fuori dai service.
- Testo fisso nel template, o una chiave presente in `it.ts` ma non in `en.ts`.
- Un numero accanto a un'etichetta fissa invece delle forme singolare e plurale; abbreviazioni italiane come `gg`.
- Pulsante di scrittura senza `v-if="can(...)"`; voce di menu aggiunta in `AppNav` invece che in `sections.config.ts`.
- Pulsante indietro cablato sulla lista invece di `useBackNavigation`.

## Da qui

- [Struttura del progetto](struttura.md) — le cartelle, una per una
- [Aggiungere una feature](../guide/nuova-feature.md) — il percorso completo, backend compreso
- [Le skill Claude](../claude/skill.md) — le skill frontend e di test che applicano queste regole
