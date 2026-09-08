# Struttura del progetto Vue

Il frontend è una SPA **Vue 3 + TypeScript + Vuetify 3**, costruita con Vite. Questa pagina percorre
`apps/frontend/` cartella per cartella e risponde, per ciascuna, a tre domande: **che cosa contiene**,
**quando serve** aggiungerci qualcosa e **quando invece no**. La pagina gemella,
[Convenzioni e flussi](convenzioni.md), spiega come le parti collaborano quando si scrive una feature.

> **Dove sta la verità.** Le regole operative vivono accanto al codice, in `apps/frontend/CLAUDE.md`:
> è il file che Claude Code legge e che le skill applicano. Questa pagina le spiega per esteso; se
> le due dovessero divergere, vince il `CLAUDE.md` del progetto.

## La mappa

```
apps/frontend/
├── index.html                   # l'unica pagina HTML: monta #app
├── src/
│   ├── main.ts                  # bootstrap: Pinia, router, Vuetify, i18n
│   ├── App.vue                  # radice: v-app, snackbar globale, titolo del tab, tema
│   ├── router/index.ts          # tutte le rotte + guard (auth, permessi, accessMode)
│   ├── config/                  # app.config.ts (import.meta.env) · sections.config.ts (menu)
│   ├── pages/<dominio>/         # una pagina per rotta
│   ├── components/
│   │   ├── layout/              # AppShell, AppTopBar, AppNav, AppBreadcrumb, AppFooter
│   │   ├── shared/              # ConfirmDialog, ServerWakeBanner
│   │   └── <dominio>/           # dialog, card e picker di una feature
│   ├── stores/                  # Pinia: uno per dominio + auth, toast, navigation, server-wake
│   ├── services/                # le chiamate HTTP, un file per dominio
│   ├── composables/             # logica riusabile senza stato globale
│   ├── constants/               # valori condivisi (paginazione, stati di dominio)
│   ├── plugins/                 # axios, i18n, vuetify, msal: le istanze delle librerie
│   ├── locales/                 # it.ts ed en.ts — entrambi obbligatori
│   ├── types/                   # api.generated.ts (generato) · api.types.ts (alias) · auth.types.ts
│   ├── styles/                  # CSS globale, il meno possibile
│   └── assets/                  # logo e immagini importate dal codice
├── public/                      # file serviti così come sono (favicon, _redirects)
├── scripts/generate-api-types.mjs   # `pnpm gen:api`
├── vite.config.ts · vitest.config.ts · vitest.setup.ts
├── eslint.config.js · .prettierrc · tsconfig.json
├── .env · .env.local.example · .env.production
├── project.json                 # i target Nx: build, serve, test, lint, typecheck
└── package.json
```

La regola che ordina tutto è una catena a senso unico:

```
pagina  →  store  →  service  →  api (axios)  →  backend
```

Ogni anello conosce solo quello successivo. Una pagina non chiama mai `axios`; uno store non sa che
cosa sia un URL; un service non tiene stato. Quando non si sa dove mettere una cosa, la domanda è:
*a quale anello appartiene?*

## Come parte l'applicazione

Il percorso di avvio spiega perché i file di radice sono così pochi:

1. **`index.html`** contiene solo `<div id="app">` e carica `src/main.ts`.
2. **`main.ts`** crea l'app e registra i quattro plugin: Pinia, router, Vuetify, i18n. Non fa altro.
3. **`App.vue`** monta `<v-app>`, l'unico `<v-snackbar>` dell'applicazione (alimentato da
   `toast.store`), il banner "server in riattivazione" e il `<router-view>`. Al mount ripristina il
   tema salvato e da lì in poi aggiorna il titolo del tab a ogni cambio di rotta.
4. **Il router** carica `AppShell` per la rotta `/`, e dentro AppShell si aprono tutte le pagine
   applicative come rotte figlie. Solo `/login` sta fuori dallo shell.

Non c'è nient'altro da "inizializzare": lo stato di sessione lo ricostruisce `auth.store` da
`localStorage` al primo accesso, la lingua la ripristina `plugins/i18n.ts`.

## `pages/` — una pagina per rotta

**Che cosa contiene.** Un componente per ogni rotta, raggruppato per dominio: `users/UsersPage.vue`
(lista), `users/UserDetailPage.vue` (dettaglio), `system/MonitoringPage.vue`, `auth/LoginPage.vue`,
`home/HomePage.vue`, `NotFoundPage.vue`.

**Che cosa fa una pagina.** Compone: prende lo store, chiede i dati, mette insieme tabella, filtri e
dialog. La logica di business non sta qui, e nemmeno le chiamate HTTP. Una pagina lista tipica ha
tre righe di "impianto":

```typescript
const store = useUsersStore()
const { can } = usePermission()
const { search, page, itemsPerPage, onOptionsUpdate, reload } =
  useServerTable(query => store.fetchUsers(query))
```

**Le due forme.** Ogni dominio ha di norma **due pagine**:

| Pagina | Rotta | Ruolo |
|---|---|---|
| `XxxPage.vue` | `system/users` | lista: ricerca, tabella server-side, azioni di riga, dialog di conferma |
| `XxxDetailPage.vue` | `system/users/new` · `system/users/:id(\d+)` | dettaglio: **la stessa pagina** serve creazione e modifica, distinte dalla presenza di `:id` |

**Quando serve una pagina nuova.** Quando serve una rotta nuova. Se il contenuto è una porzione di
una pagina esistente (una card, un dialog, un pannello), non è una pagina: va in `components/`.

**Quando NON serve.** Una pagina che supera le ~300 righe sta facendo il lavoro di due o tre
componenti: ESLint lo segnala (`max-lines`, avviso). Il rimedio non è una seconda pagina ma lo
spezzettamento in componenti di dominio — vedi [Convenzioni e flussi](convenzioni.md#dimensioni-quando-spezzare).

## `components/` — layout, condivisi, di dominio

Tre sottocartelle con tre ruoli diversi.

### `components/layout/`

Il guscio dell'applicazione. Non si tocca aggiungendo una feature: legge la configurazione e si
adatta da solo.

| Componente | Che cosa fa |
|---|---|
| `AppShell.vue` | Contenitore delle pagine: top bar, drawer laterale (rail su desktop, overlay su mobile), breadcrumb, `<router-view>` |
| `AppTopBar.vue` | Le **tab di sezione** (una per voce di `SECTIONS`), il toggle del tema, il menu utente con logout, il pulsante Login per l'anonimo |
| `AppNav.vue` | Le voci della sezione attiva, già filtrate per permesso da `navigation.store` |
| `AppBreadcrumb.vue` | Le briciole generate da `useBreadcrumb` dai `meta.title` delle rotte |
| `AppFooter.vue` | Logo e versione (letta da `package.json` via `useAppVersion`) |

Una voce di menu nuova **non** è un `v-if` in `AppNav`: è una riga in `sections.config.ts`.

### `components/shared/`

Componenti senza dominio, riusati ovunque:

- **`ConfirmDialog.vue`** — la conferma "sei sicuro?" con `v-model`, `message`, `loading` ed evento
  `confirm`. Ogni cancellazione nel progetto passa da qui.
- **`ServerWakeBanner.vue`** — il banner mostrato se la prima richiesta della sessione tarda più di
  tre secondi (cold start di un hosting free tier). Lo pilota `server-wake.store`, alimentato
  dall'interceptor axios.

**Quando aggiungerne uno.** Quando lo stesso pezzo di interfaccia serve a **più domini** e non
contiene logica di un dominio specifico.

### `components/<dominio>/`

I pezzi in cui si spezza una pagina: dialog, card, picker. Nel template:
`users/ChangePasswordDialog.vue`, `roles/RolePermissionsPicker.vue` (con il suo test accanto).

**Quando serve.** Ogni volta che una pagina ha un dialog (mai inline nel template della pagina), o
quando una sezione della pagina ha stato e comportamento propri — un picker con selezione multipla,
una card con le proprie azioni. Il componente riceve i dati per prop, emette eventi o usa
`v-model`, e può usare direttamente uno store se è un pezzo "autonomo".

**Quando NON serve.** Per un blocco di template senza logica: un `v-card` con tre campi in sola
lettura resta nella pagina. Si spezza per responsabilità, non per lunghezza.

## `stores/` — lo stato, con Pinia

**Che cosa contiene.** Uno store per dominio (`users.store.ts`, `groups.store.ts`, …) più quattro
store trasversali:

| Store | Ruolo |
|---|---|
| `auth.store` | Sessione: token, utente, permessi, lingua. Persistita in `localStorage`. Espone `login`, `loginWithMsal`, `loginWithWindows`, `logout`, `refresh` |
| `toast.store` | La notifica globale: `success`, `error`, `warning`, `info`. La `v-snackbar` è una sola, in `App.vue` |
| `navigation.store` | Sezione attiva, sezioni e voci visibili (filtrate per permesso a partire da `SECTIONS`) |
| `server-wake.store` | Il timer del banner di riattivazione |

**La forma di uno store di dominio.** Composition API, mai options API. Lo stato (`users`,
`totalCount`, `selectedUser`), `loading` ed `error` presi da `useAsyncAction`, e un'azione per ogni
chiamata al service:

```typescript
export const useUsersStore = defineStore('users', () => {
  const users = ref<User[]>([])
  const totalCount = ref(0)                 // dal backend, mai users.length
  const selectedUser = ref<User | null>(null)
  const { loading, error, run, runOrThrow, clearError } = useAsyncAction()

  let lastQuery: UsersQuery | undefined

  const fetchUsers = (params?: UsersQuery) =>
    run(async () => {                        // lettura: l'errore finisce in `error`
      lastQuery = params
      const res = await usersService.getAll(params)
      users.value = res.items
      totalCount.value = res.totalCount
    }, 'errors.loadUsers')

  const createUser = (data: CreateUserRequest) =>
    runOrThrow(async () => {                 // scrittura: l'errore viene anche rilanciato
      const created = await usersService.create(data)
      await reload()                         // la lista è paginata e ordinata dal server
      return created
    }, 'errors.createUser')

  return { users, totalCount, selectedUser, loading, error, fetchUsers, createUser, clearError }
})
```

**Quando serve uno store.** Quando un dominio ha dati che più componenti leggono, o azioni che
devono esporre `loading`/`error` in modo uniforme. In pratica: ogni feature con una lista ne ha uno.

**Quando NON serve.** Per stato locale di un solo componente (un dialog aperto, un form in
compilazione): resta un `ref` nel componente. E non si crea uno store per "passare dati" fra due
componenti vicini: si usano prop ed eventi.

## `services/` — le chiamate HTTP

**Che cosa contiene.** Un oggetto per dominio con un metodo per endpoint, e nient'altro:

```typescript
export const usersService = {
  getAll: (params?: UsersQuery) =>
    api.get<PagedResponse<User>>('/api/users', { params }).then(r => r.data),
  getById: (id: number) => api.get<User>(`/api/users/${id}`).then(r => r.data),
  create: (data: CreateUserRequest) => api.post<User>('/api/users', data).then(r => r.data),
  update: (id: number, data: UpdateUserRequest) => api.put<User>(`/api/users/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/api/users/${id}`),
}
```

Sono le **uniche righe del progetto** in cui compare l'istanza `api` di axios. Il service non
gestisce errori, non traduce, non tiene stato: restituisce `r.data` tipizzato e lascia che l'errore
salga allo store.

**Quando serve.** Un file per dominio, un metodo per endpoint. Se il backend espone un endpoint
nuovo, qui compare un metodo nuovo. Mai un metodo che ne chiama due: la composizione sta nello store.

## `composables/` — logica riusabile

**Che cosa contiene.** Funzioni `useXxx()` che incapsulano un comportamento ricorrente. A differenza
di uno store, un composable **non ha stato globale**: ogni chiamata crea il proprio.

| Composable | Quando lo usi |
|---|---|
| `useAsyncAction` | In **ogni store**: `loading`, `error`, `run` (letture), `runOrThrow` (scritture), `attempt` (nei dialog, restituisce `true`/`false`) |
| `useServerTable` | In ogni **pagina lista** con `v-data-table-server`: pagina, righe per pagina, ordinamento, ricerca con debounce, `reload()` |
| `useApiErrors` | Nei **form**: separa gli errori per campo (400 di FluentValidation) dall'errore generale. `extractApiError` è la funzione di base usata anche da `useAsyncAction` |
| `usePermission` | `can('users.write')` e `canAny(...)` per mostrare o nascondere i pulsanti |
| `useBackNavigation` | Nelle **pagine di dettaglio**: il pulsante indietro torna alla provenienza (`?from=`), alla history o al fallback |
| `useBreadcrumb` | Solo in `AppBreadcrumb`: costruisce le briciole. Non lo chiama una pagina |
| `useFormatters` | Valute e date nel formato della lingua corrente (`currency`, `date`). Un solo posto, così nessuna pagina hardcoda `'it-IT'` |
| `useTheme` (`useAppTheme`) | Toggle chiaro/scuro con persistenza. Lo usano `App.vue` e la top bar |
| `useAppVersion` | La versione da `package.json`, per il footer |

**Quando aggiungerne uno.** Quando lo stesso blocco di logica (non di template) compare in due
componenti: un timer, una trasformazione di dati, la meccanica di un controllo. Se ha bisogno di
stato condiviso fra componenti lontani, non è un composable: è uno store.

**Quando NON serve.** Per una funzione pura senza `ref`/`computed`: una funzione normale in un
modulo basta.

## `config/` — le due configurazioni

### `app.config.ts`

**L'unico file che legge `import.meta.env`.** Espone valori già normalizzati:

| Campo | Da | Valori |
|---|---|---|
| `apiBaseUrl` | `VITE_API_BASE_URL` | URL del backend, senza slash finale |
| `authStrategy` | `VITE_AUTH_STRATEGY` | `jwt` · `msal` · `windows` — quale schermata di login mostrare |
| `accessMode` | `VITE_APP_ACCESS_MODE` | `public` · `private` — vedi [Panoramica](../progetto/panoramica.md#modalita-di-accesso-pubblica-o-privata) |
| `msal.*` | `VITE_MSAL_*` | client id, tenant id, app registration dell'API |
| `isDev` | `import.meta.env.DEV` | abilita gli aiuti di sviluppo (credenziali demo nel login) |

Un valore d'ambiente nuovo si aggiunge qui e in `vite-env.d.ts` (per il tipo), poi si legge da
`appConfig`. Nessun altro file nomina `import.meta.env`: se lo fa, ESLint e la review lo segnalano.

### `sections.config.ts`

La struttura di navigazione: un array `SECTIONS`, dove ogni sezione ha `id`, `labelKey`, `icon`,
`dashboardTo` e le sue `items` — ciascuna con `titleKey`, `icon`, `to` e il `permission` minimo.

Da qui derivano **tre cose insieme**: le tab della top bar, le voci del drawer, le card della
dashboard di sezione. Una pagina nuova è una riga in una sezione; una sezione nuova è un oggetto
nuovo, e le sue rotte usano lo stesso `id` in `meta.section`.

## `router/index.ts` — le rotte e il guard

Tutte le rotte applicative sono **figlie di `/` (AppShell)** con path relativo e prefisso della
sezione:

```typescript
{
  path: 'system/users/:id(\\d+)',                    // doppio backslash: con '\d' la regex diventa 'd+'
  name: 'user-detail',
  component: () => import('@/pages/users/UserDetailPage.vue'),   // lazy load, sempre
  meta: {
    requiresAuth: true,
    permission: 'users.read',      // permesso minimo
    title: 'routes.userDetail',    // chiave i18n: breadcrumb e titolo del tab
    section: 'system',             // id della sezione in sections.config.ts
  },
}
```

Il guard globale fa tre cose, in ordine: con `accessMode = private` manda al login qualsiasi
anonimo; manda al login chi tenta una rotta con `requiresAuth`; manda alla home con un toast chi
non ha `meta.permission`. Dopo il login si va sempre su `/home` — nessun `returnUrl`, per avere lo
stesso comportamento fra le tre strategie di autenticazione.

**Quando si tocca.** Per ogni pagina nuova: una rotta. Il guard non si tocca mai.

## `plugins/` — le istanze delle librerie

| File | Che cosa configura |
|---|---|
| `axios.ts` | L'istanza `api`: `baseURL`, `withCredentials` (per il cookie del refresh token), header `Authorization` e `Accept-Language` su ogni richiesta; su **401** un tentativo di refresh e la ripetizione della richiesta, poi logout; su **5xx** l'invio di un `ErrorLog` al backend; il timer del banner di riattivazione |
| `i18n.ts` | vue-i18n con `it` ed `en`, lingua ripristinata da `localStorage` |
| `vuetify.ts` | Tema chiaro e scuro (colori delle barre inclusi), `defaults` dei componenti: `outlined` + `compact` per gli input, `rounded: 0` ovunque |
| `msal.ts` | L'istanza MSAL, creata solo con la strategia `msal` |

**Quando si toccano.** Quasi mai. Un colore del tema nuovo va in `vuetify.ts`; un header da
aggiungere a tutte le richieste va in `axios.ts`. Non contengono logica applicativa.

## `locales/` — i testi

Due file, `it.ts` ed `en.ts`, **entrambi obbligatori** e sempre aggiornati insieme. Chiavi
`dominio.elemento` (`users.title`, `users.deleteConfirm`) più le famiglie trasversali:

| Famiglia | Contenuto |
|---|---|
| `routes.*` | i titoli delle rotte (breadcrumb e tab del browser) |
| `nav.*` | le voci di menu e le sezioni |
| `common.*` | salva, annulla, elimina, cerca, "salvato con successo"… |
| `validation.*` | i messaggi delle regole di form |
| `errors.*` | i **fallback** degli store, uno per operazione, usati solo se il backend non ha risposto con un ProblemDetails |

Nei template si scrive sempre `t('chiave')`: nessun testo fisso, nemmeno un'etichetta.

## `types/` — generati, non scritti

| File | Origine | Si modifica? |
|---|---|---|
| `api.generated.ts` | **generato** da `pnpm gen:api` dallo schema OpenAPI del backend (`/openapi/v1.json`) | mai a mano |
| `api.types.ts` | alias con i nomi brevi (`User`, `Group`, `PagedResponse<T>`, `ProblemDetails`) verso gli schemi generati | sì: un alias per ogni tipo nuovo |
| `auth.types.ts` | i tipi della sessione (`LoginRequest`, `AuthState`) | raramente |

Un campo rinominato in un record C# rompe `vue-tsc`, non la pagina a runtime: è il motivo per cui i
tipi non si scrivono a mano. Perché un tipo compaia nello schema, l'endpoint deve dichiarare
`.Produces<T>()` nel backend.

**Gli id sono `number`.** Il parametro di rotta è una stringa: nelle pagine di dettaglio
`const id = Number(route.params.id)`. L'unica eccezione è `authStore.userId`, che resta `string`
perché arriva dal claim `sub` del JWT.

## `constants/`

Valori condivisi che non sono configurazione d'ambiente. Nel template `pagination.ts`
(`ITEMS_PER_PAGE_OPTIONS`, allineato al tetto `Pagination.MaxPageSize` del backend). È anche il
posto per le **costanti di stato di un dominio** — etichette i18n e colori di un `EquipmentStatus`,
per esempio — quando liste, dettagli e dialog le condividono.

## `styles/` e `assets/`

`styles/` contiene il CSS globale, e ne contiene poco: il template preferisce le classi e i
`defaults` di Vuetify. `readonly-field.css` è l'esempio di ciò che ci va: un overlay che usa la
variabile di tema `--v-theme-on-surface`, non un grigio fisso. `assets/` tiene il logo importato dal
codice; ciò che deve essere servito tale e quale (favicon, `_redirects` per l'hosting statico) sta in
`public/`.

## I file di configurazione

| File | Ruolo | Quando si tocca |
|---|---|---|
| `vite.config.ts` | Plugin Vue e Vuetify (auto-import), alias `@` → `src`, porta del dev server (variabile `frontend_port` del template) | quasi mai |
| `tsconfig.json` | `strict`, `noUnusedLocals`, `noUnusedParameters`; alias `@/*` | quasi mai |
| `eslint.config.js` | Flat config: regole JS, TypeScript, Vue, Prettier; globali browser per `src/`, Node per test e `scripts/`; `max-lines` 300 per le pagine e 200 per i componenti, come avviso | per una regola nuova |
| `.prettierrc` | Niente `;`, virgolette singole, 120 colonne | mai |
| `vitest.config.ts` | jsdom, `globals`, `vitest.setup.ts`, soglie di coverage (sotto `thresholds`, altrimenti vengono ignorate) | per alzare le soglie |
| `vitest.setup.ts` | i18n minimale, Pinia, mock di `matchMedia` e `localStorage` | per un mock globale nuovo |
| `.env` · `.env.local.example` · `.env.production` | Le variabili `VITE_*`. `.env.local` è gitignored ed è dove si mettono i valori locali | per una variabile nuova |
| `project.json` | I target Nx: `build`, `serve`, `test`, `lint`, `typecheck`. Sono ciò che `pnpm build`, `pnpm lint:frontend` e `pnpm typecheck:frontend` dalla radice invocano | per un target nuovo |
| `scripts/generate-api-types.mjs` | `pnpm gen:api`: legge lo schema dal backend avviato e scrive `api.generated.ts` | mai |

## Dove va una cosa: la tabella di decisione

| Ho bisogno di… | Va in | Non va in |
|---|---|---|
| una schermata raggiungibile da URL | `pages/<dominio>/` + una rotta + una voce in `sections.config.ts` | — |
| un dialog di creazione/modifica | `components/<dominio>/XxxDialog.vue` | il template della pagina |
| una card o un pannello con azioni proprie | `components/<dominio>/` | — |
| una conferma "sei sicuro?" | `ConfirmDialog` già esistente | un nuovo dialog |
| una chiamata HTTP | `services/<dominio>.service.ts` | store, pagina, composable |
| stato letto da più componenti, `loading`/`error` | `stores/<dominio>.store.ts` | componente |
| logica riusabile con `ref`/`computed` | `composables/useXxx.ts` | store (se non serve stato globale) |
| un valore d'ambiente | `.env*` + `vite-env.d.ts` + `app.config.ts` | `import.meta.env` nel codice |
| una voce di menu | `sections.config.ts` | `AppNav.vue` |
| un testo | `locales/it.ts` **e** `en.ts` | il template |
| un tipo dell'API | `pnpm gen:api` + alias in `api.types.ts` | un'interfaccia scritta a mano |
| un formato di data o valuta | `useFormatters` | `toLocaleDateString('it-IT')` nella pagina |
| una notifica all'utente | `useToastStore()` | una `v-snackbar` nel componente |
| un colore | il tema in `plugins/vuetify.ts` (`color="primary"`) | un esadecimale nel template |
| un test | accanto al file (`x.test.ts`) | una cartella `tests/` separata |

## Da qui

- [Convenzioni e flussi](convenzioni.md) — come si scrive una feature attraversando queste cartelle
- [Aggiungere una feature](../guide/nuova-feature.md) — il percorso completo, backend compreso
- [Le skill Claude](../progetto/skill.md) — `vue-feature`, `detail-page`, `vuetify-dialog-form` e le skill di test
