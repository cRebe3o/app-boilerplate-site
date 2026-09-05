# Deploy su Render

Pubblicare backend e frontend da GitHub su [Render](https://render.com). Sono due servizi distinti,
che si configurano una volta e poi si aggiornano da soli a ogni push.

Render è l'esempio usato qui perché è il percorso più rapido per mettere online un progetto appena
generato; i concetti — variabili d'ambiente, CORS, cookie cross-site, rewrite della SPA — valgono
identici su qualunque altro hosting.

| Servizio | Tipo Render | Root directory | Build |
|---|---|---|---|
| Backend | **Web Service** | `apps/backend/<Progetto>.Api` | Docker (rilevato dal `Dockerfile`) |
| Frontend | **Static Site** | `apps/frontend` | `pnpm install && pnpm run build` → `dist` |

> **Prerequisiti**: repository su GitHub, account Render collegato, e le credenziali del database
> (SQL Server, oppure PostgreSQL se si usa quel provider — su Render è disponibile nativamente).

## 1. Backend — Web Service

**New → Web Service**, collega il repository e configura:

| Campo | Valore |
|---|---|
| Name | `<progetto>-backend` |
| Root Directory | `apps/backend/<Progetto>.Api` |
| Environment | `Docker` |

Render trova da sé il `Dockerfile` nella root directory. L'immagine espone la porta **8080**, e
Render la rileva automaticamente.

### Variabili d'ambiente

In .NET il **doppio underscore** sostituisce i due punti della gerarchia: `Auth__Jwt__Secret`
corrisponde a `Auth:Jwt:Secret` in `appsettings.json`.

| Variabile | Valore | Note |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Production` | Carica `appsettings.Production.json` |
| `ConnectionStrings__SqlServer` | `Server=…;Database=…;…` | Connection string di produzione (provider di default) |
| `Auth__Jwt__Secret` | *(casuale, min 32 caratteri)* | **Obbligatorio**: senza, l'app non si avvia |
| `Seed__AdminPassword` | *(password dell'admin iniziale)* | Usata **solo** al primo seed, su database vuoto |
| `Cors__AllowedOrigins__0` | `https://<progetto>-frontend.onrender.com` | L'URL del frontend, esatto |
| `Database__SizeLimitMb` | *(es. `512`)* | Facoltativa: il tetto di spazio del piano, che il motore non conosce. Senza, la pagina Monitoraggio usa un riferimento indicativo e lo segnala |
| `Auth__Msal__TenantId` · `Auth__Msal__ClientId` | *(dal portale Azure)* | Solo se si usa l'accesso con account Microsoft. Il ClientId è quello dell'**app API** — vedi la [guida ad Azure](../autenticazione/azure-app-registration.md) |

**Per usare PostgreSQL** al posto di SQL Server, due variabili — e nient'altro:

```bash
Database__Provider=PostgreSQL
ConnectionStrings__PostgreSQL="Host=…;Database=…;Username=…;Password=…;SSL Mode=Require"
```

Le migration si applicano da sole al primo avvio. Vedi
[Infrastruttura](../infrastructure/panoramica.md).

> ⚠️ **Attenzione ai connection pooler.** `MigrateAsync` crea il database se non esiste, ma solo dove
> l'utente ha il permesso di farlo. Dietro un pooler — Neon, per esempio, che espone host `*-pooler`
> — la `CREATE DATABASE` non è consentita e il login viene rifiutato con `08P01 database does not
> exist`. In quel caso il database va creato a monte, prima del primo deploy.

## 2. Frontend — Static Site

**New → Static Site**, stesso repository:

| Campo | Valore |
|---|---|
| Name | `<progetto>-frontend` |
| Root Directory | `apps/frontend` |
| Build Command | `pnpm install && pnpm run build` |
| Publish Directory | `dist` |

Per far usare pnpm a Render serve la variabile `ENABLE_PNPM=true`. In alternativa si può usare npm,
con `npm install && npm run build`.

### Variabili d'ambiente

| Variabile | Valore |
|---|---|
| `VITE_API_BASE_URL` | `https://<progetto>-backend.onrender.com` |
| `VITE_AUTH_STRATEGY` | `jwt`, `msal` oppure `windows` |
| `VITE_APP_ACCESS_MODE` | `public` o `private` |
| `VITE_MSAL_CLIENT_ID` · `VITE_MSAL_TENANT_ID` · `VITE_MSAL_API_CLIENT_ID` | Solo con `msal` |

> **`VITE_AUTH_STRATEGY=windows` non ha senso su un hosting pubblico.** L'autenticazione integrata
> richiede che il browser possa negoziare Kerberos/NTLM con il server, cioè una rete aziendale
> Windows: è la strategia per i deploy intranet, non per Render.

Due avvertenze che costano tempo:

> **`VITE_API_BASE_URL` punta al BACKEND**, non al frontend. È l'errore più facile da fare, e il
> sintomo è una pagina che si carica ma non mostra dati.

> **Le variabili `VITE_*` sono iniettate al momento del build**, non a runtime. Cambiarle in
> dashboard non basta: bisogna rifare il build (*Manual Deploy → Clear build cache & deploy*).

Le variabili impostate nella dashboard di Render **hanno la precedenza** su un eventuale
`.env.production` committato nel repository.

### Il routing della SPA

Vue Router usa la history mode: ogni URL profondo (`/users/42`) deve servire `index.html`,
altrimenti un refresh della pagina restituisce 404.

Non serve configurare nulla: il file `apps/frontend/public/_redirects` contiene già la regola, e
Render la applica.

```
/* /index.html 200
```

(Se un domani sparisse, l'equivalente da dashboard è *Redirects/Rewrites*: source `/*`, destination
`/index.html`, action **Rewrite**.)

## 3. CORS

Il backend accetta richieste solo dalle origin dichiarate. In `appsettings.Production.json` c'è già
un valore, sovrascrivibile con `Cors__AllowedOrigins__0`.

```json
{
  "Cors": {
    "AllowedOrigins": [ "https://mioprogetto-frontend.onrender.com" ]
  }
}
```

L'URL deve corrispondere **esattamente**: protocollo incluso, **senza** barra finale.

```
✅ https://mioprogetto-frontend.onrender.com
❌ https://mioprogetto-frontend.onrender.com/
❌ http://mioprogetto-frontend.onrender.com
```

La policy abilita `AllowCredentials`, senza il quale il cookie del refresh token non viaggerebbe.
In sviluppo, invece, il backend accetta qualunque porta su `localhost`.

## 4. Segreti

**Nessun segreto nei file versionati.** Le connection string e i secret in `appsettings.json` sono
volutamente **vuoti**: i valori arrivano da `appsettings.local.json` (in `.gitignore`) in sviluppo e
dalle variabili d'ambiente in produzione.

Da tenere solo nell'ambiente: `ConnectionStrings__SqlServer` (o `__PostgreSQL`), `Auth__Jwt__Secret`,
`Seed__AdminPassword`.

> Se in passato una credenziale è finita in un commit, **non basta toglierla dal file**: resta nella
> history di Git. Va **ruotata** (password del database cambiata, secret rigenerato) e, se il
> repository è pubblico, va valutata la riscrittura della history con `git filter-repo` o BFG.

I ClientId e i TenantId di Azure, invece, **non sono segreti**: sono identificativi pubblici, presenti
nel bundle del frontend. Non serve nasconderli — serve solo non confonderli fra loro.

## 5. Deploy automatico

Collegato il repository, Render ridistribuisce a ogni push sul branch configurato (`main`).
Si disattiva da *Settings → Build & Deploy → Auto-Deploy*.

## 6. Diagnostica

**Il backend non parte.**
Guarda i log (*Logs*). Le cause tipiche falliscono tutte all'avvio con un messaggio esplicito:
`Auth__Jwt__Secret` mancante, connection string mancante, `Database__Provider` con un valore non
ammesso (i soli ammessi sono `SqlServer` e `PostgreSQL`). Se il database è esterno a Render,
controlla che il firewall consenta le connessioni in ingresso da Render.

**Il backend parte ma ogni chiamata dà 500.**
Controlla che le migration esistano nel repository: se il progetto è stato generato e nessuno ha mai
eseguito `migrations add`, lo schema non viene creato e ogni query fallisce. Vedi
[Generare e aggiornare](../progetto/generazione.md).

**Il frontend è bianco, o non carica i dati.**
Quasi sempre `VITE_API_BASE_URL` sbagliata o non ri-buildata. Controlla anche che la rewrite verso
`index.html` sia attiva.

**Errori CORS.**
`Cors__AllowedOrigins__0` non coincide *esattamente* con l'URL del frontend.

**Non resto connesso / il refresh fallisce.**
Frontend e backend sono su due origin diverse, quindi il cookie del refresh token è cross-site: deve
essere `SameSite=None; Secure`, e quindi la connessione **deve** essere HTTPS. Vedi
[Autenticazione](../autenticazione/autenticazione.md#il-cookie-e-il-samesite).

**Non riesco ad accedere la prima volta.**
L'utente `admin` viene creato dal seed con la password di `Seed__AdminPassword`. Se la variabile non
era impostata al primo avvio, la password è casuale e non recuperabile: il modo più rapido è
svuotare il database e ripartire con la variabile valorizzata — il seed gira solo su database vuoto.

**La prima richiesta dopo un po' di inattività va in timeout.**
È il piano gratuito: i servizi vanno in sleep dopo 15 minuti e il risveglio richiede 30–60 secondi.
Il frontend lo gestisce già — mostra un avviso mentre il backend si sveglia, invece di sembrare
rotto. Per eliminare il problema serve un piano a pagamento, oppure un ping periodico che tenga
sveglio il servizio.
