# Autenticazione — JWT, MSAL e Windows

Un progetto generato sa autenticare gli utenti in tre modi: con **username e password** custoditi
nel proprio database, con un **account Microsoft** (Azure AD / Entra ID), oppure con l'**identità
Windows** della macchina (autenticazione integrata, Kerberos/NTLM). Sono strategie diverse solo nel
primo passo. Da lì in poi il sistema è identico.

Tutte e tre sono già montate: non c'è nulla da implementare, al massimo da configurare.

## La cosa da capire per prima

**Il backend emette sempre un JWT proprio.** Sempre, con tutte e tre le strategie.

```
   Username + password        Account Microsoft            Identità Windows
          │                          │                            │
          │              token Azure AD (firmato        handshake Negotiate
          │                da Microsoft)                (Kerberos / NTLM)
          ▼                          ▼                            ▼
   POST /api/auth/login   POST /api/auth/msal-login   POST /api/auth/windows-login
          │                          │                            │
          │  verifica BCrypt   valida il token con le      il middleware Negotiate
          │                    chiavi pubbliche di Azure,   autentica il browser,
          │                    poi cerca l'utente locale    poi si cerca l'utente
          │                    con quello username          locale con quello username
          └────────────────────────┬────────────────────────────┘
                                   ▼
                      Risolve i permessi dell'utente
                      Emette un JWT interno (HS256) + un refresh token
                                   │
                                   ▼
                      Da qui in avanti tutto è identico:
                      Authorization: Bearer <JWT interno>
```

Il token di Azure e l'handshake Windows servono **solo** per il login iniziale, per stabilire *chi è*
chi sta bussando. Non vengono mai usati per chiamare le API dell'applicazione: per quello c'è il JWT
interno.

Conseguenza pratica: **i permessi vengono sempre dal database locale**, mai da Azure né da Active
Directory. L'IdP dice "questa persona è Mario Rossi"; che cosa Mario Rossi possa fare lo decide
l'applicazione.

## L'identità di login: `Username`

Tutte e tre le strategie, alla fine, cercano l'utente locale **per `Username`** — una sola colonna,
`NOT NULL` e **unica**, che contiene la stringa con cui quell'utente accede:

| Strategia | Cosa finisce in `Username` |
|---|---|
| Username + password | Lo username locale scelto in fase di creazione utente (può essere una email, ma non è obbligatorio) |
| Account Microsoft | La `preferred_username` del token Azure — di fatto la email aziendale |
| Identità Windows | `DOMINIO\utente` (o l'UPN), come lo restituisce il sistema |

Il backend **non interpreta** il contenuto: fa un confronto esatto sul valore normalizzato. La
normalizzazione è centralizzata in un unico helper, `Username.Normalize`, applicato sia in scrittura
(creazione/modifica utente, seed) sia in lettura (ogni handler di login):

```csharp
// Features/_Shared/Helpers/Username.cs
public static string Normalize(string? value) => (value ?? string.Empty).Trim().ToLowerInvariant();
```

Regola: **trim + minuscolo**. Serve perché Postgres confronta le stringhe in modo case-sensitive
(SQL Server no) e perché Windows non distingue il maiuscolo/minuscolo nei nomi account. Domini
diversi restano identità diverse: `AZIENDA\mrossi` e `NOMEPC\mrossi` sono due utenti distinti;
`AZIENDA\MRossi` e `azienda\mrossi` sono lo stesso.

> **`Email` non è la chiave di login.** È **opzionale** (`string?`) e puramente anagrafica: serve per
> la visualizzazione e per eventuali notifiche, non per accedere. È indicizzata per le ricerche ma
> **non unica**. Chi crea un utente decide che cosa mettere in `Username` a seconda di come
> quell'utente entrerà.

## Quale strategia usare

| | Username + password | Account Microsoft (MSAL) | Identità Windows |
|---|---|---|---|
| Dove vivono le credenziali | Nel database, come hash BCrypt | In Azure AD | In Active Directory / account Windows locale |
| Single Sign-On | No | Sì, con l'ecosistema Microsoft 365 | Sì, sulla rete aziendale Windows |
| MFA, recupero password, policy | Da implementare | Li gestisce Microsoft | Li gestisce Active Directory |
| Prerequisito per l'utente | Esistere nell'applicazione | Esistere in Azure AD **e** nell'applicazione, con `Username` = la sua email aziendale | Esistere nell'applicazione con `Username` = `DOMINIO\utente` |
| Setup | Nessuno | Registrazione dell'app su Azure ([guida](azure-app-registration.md)) | Nessuno (il pacchetto Negotiate fa il fallback NTLM anche fuori dominio) |
| Adatta a | Sviluppo, installazioni autonome, prototipi | Aziende già su Microsoft 365 | Applicazioni intranet su rete Windows / Active Directory |

In esercizio: **sviluppo con username e password, produzione con account Microsoft o identità
Windows** a seconda dell'infrastruttura del cliente.

### Come si passa dall'una all'altra

Qui c'è un punto che sorprende, ed è bene saperlo perché fa risparmiare tempo:

> **Il backend non ha una strategia.** Tutti e tre gli endpoint (`/login`, `/msal-login`,
> `/windows-login`) sono **sempre** attivi, e il backend emette e valida sempre e solo i propri JWT.
> Non esiste alcun interruttore lato server.
>
> In `appsettings.local.json.example` compare una chiave `Auth:Strategy`: **non è letta da nessuna
> parte del codice**, è lì solo come promemoria di quale schermata si sta usando. Cambiarla non
> cambia il comportamento del backend.

A scegliere è il **frontend**, con `VITE_AUTH_STRATEGY`:

```env
# apps/frontend/.env.local
VITE_AUTH_STRATEGY=jwt       # form username/password
VITE_AUTH_STRATEGY=msal      # pulsante "Accedi con Microsoft"
VITE_AUTH_STRATEGY=windows   # nessun form: SSO Windows automatico all'apertura della pagina
```

In `LoginPage.vue` il form classico compare **solo** con `'jwt'`; `'msal'` mostra il pulsante
Microsoft; `'windows'` non mostra nulla e tenta subito il Single Sign-On, con un pulsante "Riprova"
se qualcosa va storto.

Per usare MSAL servono anche le variabili descritte nella [guida ad Azure](azure-app-registration.md);
il backend, dal canto suo, ha bisogno di `Auth:Msal:TenantId` e `Auth:Msal:ClientId` per validare il
token in arrivo. Per Windows, invece, **non serve configurare nulla**.

## Il flusso completo

### 1. Accesso con username e password

```
POST /api/auth/login   { username, password }
        │
        ▼  LoginHandler
   ┌───────────────────────────────────────────────┐
   │ 1. Normalizza lo username e cerca l'utente    │
   │ 2. Se non è attivo → 401                      │
   │ 3. Verifica la password con BCrypt            │
   │ 4. Risolve i permessi (vedi sotto)            │
   │ 5. Genera il JWT + il refresh token           │
   └───────────────────────────────────────────────┘
        │
        ▼
   200 OK  { accessToken, expiresAt, userId, username, email, displayName, language, permissions }
   Set-Cookie: refreshToken=…  (HttpOnly)
```

L'errore su username inesistente e quello su password sbagliata sono **lo stesso messaggio**
("Credenziali non valide"): distinguerli permetterebbe di scoprire quali utenti sono registrati.

### 2. Accesso con account Microsoft

```
Frontend → Azure AD (login, MFA, consenso)  →  access token firmato da Microsoft
        │
        ▼
POST /api/auth/msal-login   { azureToken }
        │
        ▼  MsalLoginHandler
   ┌────────────────────────────────────────────────────────────┐
   │ 1. Scarica le chiavi pubbliche del tenant (JWKS) e le      │
   │    tiene in cache                                          │
   │ 2. VALIDA il token: firma, issuer, audience, scadenza      │
   │ 3. Estrae preferred_username (o email)                     │
   │ 4. Cerca l'utente LOCALE con quello Username → se no, 401  │
   │ 5. Se non è attivo → 401                                   │
   │ 6. Risolve i permessi, genera il JWT interno + refresh     │
   └────────────────────────────────────────────────────────────┘
```

> **Il backend valida il token di Azure per intero.** Non si fida di quanto ha già fatto il frontend:
> verifica la firma con le chiavi pubbliche di Microsoft, l'emittente, il destinatario e la scadenza.

```csharp
// MsalLoginHandler.cs — la validazione, per esteso
var openIdConfig = await configManager.GetConfigurationAsync(cancellationToken);

var validationParameters = new TokenValidationParameters
{
    ValidIssuer = $"https://login.microsoftonline.com/{tenantId}/v2.0",
    IssuerSigningKeys = openIdConfig.SigningKeys,     // chiavi pubbliche di Azure (JWKS)
    ValidateIssuer = true,
    ValidateAudience = true,
    AudienceValidator = (audiences, _, _) =>
        audiences.Any(a => a == clientId || a == $"api://{clientId}"),
    ValidateLifetime = true,
    ValidateIssuerSigningKey = true,
    ClockSkew = TimeSpan.FromMinutes(2)
};

handler.ValidateToken(request.AzureToken, validationParameters, out var validatedToken);
```

Due dettagli che spiegano perché è scritto così:

- **`AudienceValidator` custom.** A seconda di come è configurata l'app su Azure, il claim `aud` può
  contenere il ClientId nudo oppure `api://{clientId}`. Accettarli entrambi evita l'errore
  `IDX10214: Audience validation failed` quando lo scope non è ancora stato esposto.
- **Cache dei metadata per tenant.** I `ConfigurationManager` stanno in un dizionario statico: sono
  loro a scaricare e rinfrescare le chiavi JWKS. Ricrearli a ogni login significherebbe riscaricare
  le chiavi a ogni login.

### 3. Accesso con identità Windows

```
Browser  ── POST /api/auth/windows-login (senza corpo) ──▶  backend
        ◀── 401  WWW-Authenticate: Negotiate ────────────
        ── ripete la richiesta con il ticket Kerberos/NTLM ▶  middleware Negotiate
                                                              autentica → HttpContext.User
        │
        ▼  WindowsLoginHandler
   ┌────────────────────────────────────────────────────────────┐
   │ 1. Legge l'identità: "DOMINIO\utente" da HttpContext.User  │
   │    (in Development: header X-Dev-Windows-User, vedi sotto) │
   │ 2. Normalizza e cerca l'utente LOCALE con quello Username  │
   │    → se non c'è, 401                                       │
   │ 3. Se non è attivo → 401                                   │
   │ 4. Risolve i permessi, genera il JWT interno + refresh     │
   └────────────────────────────────────────────────────────────┘
```

Nessun corpo nella richiesta: l'identità viaggia nell'header `Authorization: Negotiate …` che il
**browser** aggiunge da solo rispondendo al `401`. Perché parta serve `withCredentials: true` sul
client (già impostato in `axios.ts`) e che il browser consideri l'host "intranet" — Chrome/Edge lo
fanno di default per `localhost` e per i domini della rete aziendale; Firefox va configurato
(`network.negotiate-auth.trusted-uris`).

Lato .NET, lo schema Negotiate è **aggiuntivo**, non il default:

```csharp
// AuthExtensions.cs
services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)   // JWT resta il default
    .AddJwtBearer(options => { /* … */ })
    .AddNegotiate();                                                  // usato solo da /windows-login
```

```csharp
// AuthEndpoints.cs — l'endpoint richiede esplicitamente lo schema Negotiate
group.MapPost("/windows-login", async (/* … */) => { /* … */ })
    .RequireAuthorization(new AuthorizeAttribute
    {
        AuthenticationSchemes = NegotiateDefaults.AuthenticationScheme
    })
    .RequireRateLimiting("auth-policy");
```

Tutti gli altri endpoint continuano a usare JWT Bearer. Su Windows il pacchetto
`Microsoft.AspNetCore.Authentication.Negotiate` funziona **anche fuori dominio**, con il fallback NTLM
sull'account locale della macchina.

> **Bypass di sviluppo.** In `Development` — e solo lì — l'endpoint accetta l'header
> `X-Dev-Windows-User: DOMINIO\utente` e lo usa come identità, saltando del tutto l'handshake. Serve
> per i test di integrazione, per `curl`/Postman (dove non c'è un browser che negozia Kerberos) e per
> simulare utenti diversi senza cambiare l'account Windows della macchina. In `Production` il ramo è
> irraggiungibile: `IWebHostEnvironment.IsDevelopment()` è `false` e l'header viene ignorato.

### 4. Uso del token, e rinnovo

L'access token dura **60 minuti** (configurabile). Alla scadenza si usa il refresh token, che vive in
un cookie e dura **7 giorni**.

```
POST /api/auth/refresh          (il cookie viaggia da solo)
        │
        ▼  RefreshTokenHandler
   ┌──────────────────────────────────────────────┐
   │ 1. Cerca il refresh token nel database       │
   │ 2. Se scaduto → 401                          │
   │ 3. Utente inesistente o disattivato → 401    │
   │ 4. REVOCA il token appena usato  ← rotation  │
   │ 5. Ririsolve i permessi (aggiornati!)        │
   │ 6. Emette un nuovo JWT + un nuovo refresh    │
   └──────────────────────────────────────────────┘
```

**Rotation.** Ogni refresh consuma il token e ne emette uno nuovo: chi rubasse un refresh token
potrebbe usarlo una volta sola, e solo se arriva prima del legittimo proprietario.

**I permessi vengono ririsolti a ogni refresh**: una modifica ai ruoli di un utente diventa effettiva
al più tardi dopo un'ora, senza bisogno che l'utente rifaccia il login.

### 5. Uscita

`POST /api/auth/logout` revoca il refresh token e cancella il cookie. È **idempotente**: se il token
non c'è più, non è un errore. L'access token già emesso resta tecnicamente valido fino alla scadenza —
è la natura dei JWT — ma il frontend lo elimina e senza refresh token non se ne ottengono altri.

## Come si risolvono i permessi

È la stessa identica sequenza in tutti gli handler (login, msal-login, windows-login, refresh):

```
     Utente
       ├── RoleIds            (ruoli assegnati direttamente)
       └── GroupIds → Gruppi → RoleIds   (ruoli ereditati dai gruppi)
                                  │
                     unione + deduplica
                                  │
                               Ruoli → PermissionIds
                                  │
                            Permessi → Key   ("users.read", "groups.write", …)
                                  │
                    un claim "permissions" per ciascuno, dentro il JWT
```

Il JWT che ne esce:

```json
{
  "sub": "42",                             // id dell'utente (int)
  "username": "azienda\\mrossi",           // l'identità di login
  "email": "mario@example.com",            // presente solo se l'utente ha una email
  "name": "Mario Rossi",
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "permissions": ["users.read", "groups.write"],
  "iss": "MioProgetto",
  "aud": "MioProgettoClients",
  "exp": 1695315600
}
```

`iss` e `aud` derivano dal `project_slug` scelto alla generazione, e sono configurabili in
`Auth:Jwt:Issuer` e `Auth:Jwt:Audience`.

Gli endpoint verificano il claim, non il ruolo:

```csharp
group.MapDelete("/{id:int}", …)
    .RequireAuthorization(p => p.RequireClaim("permissions", "groups.delete"));
```

## Configurazione

```json
// appsettings.local.json (gitignored) — in produzione: variabili d'ambiente
{
  "Auth": {
    "Jwt": {
      "Secret": "…almeno 32 caratteri, casuale…",
      "Issuer": "MioProgetto",
      "Audience": "MioProgettoClients",
      "ExpiresInMinutes": 60,
      "RefreshExpiresInDays": 7
    },
    "Msal": {
      "Instance": "https://login.microsoftonline.com/",
      "TenantId": "…",
      "ClientId": "…"     // l'app registration dell'API — non quella della SPA
    }
    // Windows: nessuna sezione. L'autenticazione integrata non legge alcuna chiave.
  }
}
```

| Parametro | Note |
|---|---|
| `Jwt:Secret` | **Obbligatorio.** Se manca, l'applicazione non si avvia. Minimo 32 caratteri |
| `Jwt:ExpiresInMinutes` | Default 60. Valori sensati: 15–60 |
| `Jwt:RefreshExpiresInDays` | Default 7. Decide per quanto l'utente resta connesso senza riautenticarsi |
| `Msal:ClientId` | Il ClientId dell'**API** su Azure: è quello che il backend si aspetta come `aud` del token |
| *(Windows)* | Nessun parametro. Serve solo il pacchetto NuGet `Microsoft.AspNetCore.Authentication.Negotiate` |

Generare un secret:

```bash
openssl rand -base64 32
```

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Max 256) }))
```

### Il pacchetto Negotiate e la versione

L'autenticazione Windows dipende da `Microsoft.AspNetCore.Authentication.Negotiate`, pinnato nel
template a **10.0.10**. Le versioni `10.0.0`–`10.0.9` sono soggette a due avvisi di sicurezza di
gravità alta (`GHSA-8prm-248r-h957`, `GHSA-2p3q-h3hg-jcqq`) che riguardano l'uso di Negotiate con
LDAP per il recupero dei ruoli: `dotnet build` li segnala come `NU1903`. La 10.0.10 li chiude — non
abbassare quella versione.

## Simulare l'autenticazione Windows in locale

Windows Auth **funziona sulla macchina di sviluppo** anche senza un dominio Active Directory: su
Windows il pacchetto Negotiate fa il fallback NTLM con l'account locale.

**Opzione A — Kestrel + NTLM locale (consigliata per iniziare).**
`dotnet run` normale. Il browser chiama `POST http://localhost:<porta>/api/auth/windows-login`,
riceve `401 WWW-Authenticate: Negotiate` e Chrome/Edge rispediscono in automatico le credenziali
dell'account Windows corrente (`localhost` è zona intranet). `HttpContext.User.Identity.Name` diventa
`NOMEPC\tuoutente`: perché il login riesca, serve un utente nel seed con
`Username = "nomepc\\tuoutente"` (minuscolo). Firefox va configurato in `about:config`
(`network.negotiate-auth.trusted-uris` = `localhost`).

**Opzione B — header di sviluppo (per test automatici e per iterare).**
Con `ASPNETCORE_ENVIRONMENT=Development`:

```bash
curl -X POST http://localhost:<porta>/api/auth/windows-login \
  -H "X-Dev-Windows-User: admin" \
  -c cookies.txt
```

Non serve un browser, e si può simulare qualsiasi utente cambiando il valore dell'header.

**Opzione C — IIS Express (più simile alla produzione su IIS).**
In `launchSettings.json`, profilo IIS Express:

```json
"windowsAuthentication": true,
"anonymousAuthentication": true
```

IIS Express completa l'handshake e popola `HttpContext.User` prima del codice applicativo.

**CORS in locale**: già a posto. In Development ogni origin `localhost` è ammesso con
`AllowCredentials()`. Il cross-origin fra frontend e backend non impedisce l'invio delle
credenziali, perché il browser considera comunque `localhost` intranet.

## Sicurezza — che cosa è in piedi

| Protezione | Come |
|---|---|
| Password | Hash **BCrypt** (lento, con salt): dall'hash non si risale alla password |
| Firma del JWT | HMAC-SHA256 con il secret; alla validazione `ClockSkew = 0`, nessuna tolleranza sulla scadenza |
| Refresh token | 64 byte casuali crittografici, salvati nel database, **ruotati** a ogni uso, revocabili |
| Cookie | `HttpOnly` (JavaScript non lo può leggere, neanche in caso di XSS), `Secure` fuori da sviluppo, `Path=/api/auth` |
| Brute force | Rate limiting **per IP** su login, msal-login, windows-login e refresh: 10 tentativi ogni 15 minuti |
| Enumerazione utenti | Messaggio di errore identico per username sconosciuto e password errata |
| Account disattivati | `IsActive` verificato al login **e a ogni refresh** |
| Token Azure | Firma (JWKS), issuer, audience e scadenza validati **dal backend** |
| Identità Windows | Handshake Negotiate gestito dal middleware ASP.NET; header di bypass attivo **solo** in Development |

### Il cookie e il `SameSite`

```csharp
ctx.Response.Cookies.Append("refreshToken", refreshToken, new CookieOptions
{
    HttpOnly = true,
    Secure = !isDev,
    // In produzione frontend e backend stanno spesso su origin diverse (cross-site):
    // con SameSite=Lax il browser NON invierebbe il cookie sulle chiamate XHR.
    SameSite = isDev ? SameSiteMode.Lax : SameSiteMode.None,
    Path = "/api/auth",
    MaxAge = TimeSpan.FromDays(days)
});
```

Vale la pena fermarsi un attimo. In produzione il cookie è `SameSite=None`, **non** `Lax`: quando il
frontend e il backend sono pubblicati su due domini diversi ogni chiamata è cross-site, e con `Lax`
il browser non allegherebbe mai il cookie. `None` **richiede** `Secure`, cioè HTTPS.

Il prezzo è che `SameSite` non offre più protezione CSRF; a proteggere restano il fatto che il cookie
serve **solo** su `/api/auth` e che le API vere vogliono il Bearer token, che vive in `localStorage`
e non viaggia da solo.

## Sul frontend

```typescript
// plugins/axios.ts
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,        // senza questo il cookie del refresh — e l'handshake Windows — non partono
})

api.interceptors.request.use(config => {
  const authStore = useAuthStore()
  if (authStore.token) config.headers.Authorization = `Bearer ${authStore.token}`
  config.headers['Accept-Language'] = authStore.language ?? 'it'
  return config
})

// 401 → logout. NON un retry automatico con refresh.
let isLoggingOut = false
api.interceptors.response.use(
  res => res,
  async error => {
    if (error.response?.status === 401 && !isLoggingOut) {
      isLoggingOut = true
      try { await useAuthStore().logout() } finally { isLoggingOut = false }
    }
    return Promise.reject(error)
  },
)
```

> **Attenzione a questo comportamento**: su `401` il frontend **disconnette l'utente**, non tenta il
> refresh. `authStore.refresh()` esiste ed è disponibile per un rinnovo preventivo, ma non è agganciato
> all'interceptor. In pratica, a token scaduto l'utente viene rimandato al login. È una scelta da
> rivalutare in un progetto dove le sessioni lunghe contano.

Lo store `auth.store.ts` conserva in `localStorage` token, scadenza, `username`, `email` (se presente),
gli altri dati dell'utente e i permessi. Le azioni di login sono tre: `login()`, `loginWithMsal()`,
`loginWithWindows()`. Il navigation guard del router controlla `meta.requiresAuth` e `meta.permission`
prima di ogni navigazione, e il composable `usePermission` espone `can('permesso')` per i template.

Nella gestione utenti il campo obbligatorio è **Username** (con un suggerimento su cosa scriverci:
username locale, email per MSAL, `DOMINIO\utente` per Windows); **Email** è facoltativo.

## Diagnostica

| Sintomo | Causa più probabile |
|---|---|
| **401 subito dopo il login** | Il JWT è scaduto (60 minuti) o il `Jwt:Secret` non è lo stesso con cui era stato firmato — tipico dopo un riavvio con secret diverso |
| **401 su `/api/auth/refresh`** | Il cookie non è arrivato. Controlla `withCredentials: true` sul client, `Secure`/`SameSite` sul server e che la richiesta sia su HTTPS in produzione |
| **"Nessun utente locale con username …"** | *MSAL o Windows.* L'identità è valida ma non c'è un utente locale con quello `Username`. Va creato nel pannello, con lo `Username` esatto (per MSAL: la email aziendale; per Windows: `DOMINIO\utente`) |
| **"Token Azure non valido: IDX10214"** | Il claim `aud` del token non corrisponde a `Auth:Msal:ClientId`. È il caso classico di SPA e API confuse: vedi la [guida ad Azure](azure-app-registration.md) |
| **"Token Azure non valido: IDX10223"** o scadenza | Orologio del server disallineato (la tolleranza è 2 minuti) o token già scaduto |
| **SSO Windows: 401 e nessun popup** | Il browser non invia le credenziali. Chrome/Edge: l'host non è in zona intranet. Firefox: manca `network.negotiate-auth.trusted-uris`. In alternativa usa l'header `X-Dev-Windows-User` in Development |
| **SSO Windows: `NU1903` a `dotnet build`** | Pacchetto Negotiate su una versione < 10.0.10: aggiorna |
| **Il pulsante Microsoft non appare** | `VITE_AUTH_STRATEGY` non vale esattamente `msal` |
| **Il form username/password non appare** | `VITE_AUTH_STRATEGY` vale `msal` o `windows`: rimettilo a `jwt` |
| **401 "Account disabilitato"** | `IsActive = false` sull'utente |

Per guardare dentro un token: [jwt.ms](https://jwt.ms) (Azure) o [jwt.io](https://jwt.io) — mai con
token di produzione.

## I file

| File | Ruolo |
|---|---|
| `Features/Auth/AuthEndpoints.cs` | Le rotte, il rate limiting, il cookie, il bypass dev di Windows |
| `Features/Auth/Login/LoginHandler.cs` | Username + password, BCrypt |
| `Features/Auth/MsalLogin/MsalLoginHandler.cs` | Validazione del token Azure, lookup dell'utente locale |
| `Features/Auth/WindowsLogin/WindowsLoginHandler.cs` | Identità Windows → lookup dell'utente locale per `Username` |
| `Features/Auth/RefreshToken/RefreshTokenHandler.cs` | Rotation e ririsoluzione dei permessi |
| `Features/Auth/Logout/LogoutHandler.cs` | Revoca |
| `Features/Auth/Shared/JwtTokenHelper.cs` | Generazione del JWT e del refresh token |
| `Features/_Shared/Helpers/Username.cs` | Normalizzazione dell'identità di login (trim + minuscolo) |
| `Features/_Shared/Extensions/AuthExtensions.cs` | Registrazione di JwtBearer + Negotiate e delle policy |
| `plugins/axios.ts` · `stores/auth.store.ts` · `services/msal.service.ts` | Il lato frontend |
