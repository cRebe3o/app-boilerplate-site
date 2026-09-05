# Autenticazione — JWT e MSAL

DelVoltone sa autenticare gli utenti in due modi: con **email e password** custoditi nel proprio
database, oppure con un **account Microsoft** (Azure AD / Entra ID). Sono strategie diverse solo nel
primo passo. Da lì in poi il sistema è identico.

## La cosa da capire per prima

**Il backend emette sempre un JWT proprio.** Sempre, con entrambe le strategie.

```
   Email + password                Account Microsoft
          │                                │
          │                     token Azure AD (firmato da Microsoft)
          ▼                                ▼
   POST /api/auth/login          POST /api/auth/msal-login
          │                                │
          │  verifica BCrypt      valida il token con le chiavi pubbliche di Azure,
          │                       poi cerca l'utente locale con quella email
          └────────────────┬───────────────┘
                           ▼
              Risolve i permessi dell'utente
              Emette un JWT interno (HS256) + un refresh token
                           │
                           ▼
              Da qui in avanti tutto è identico:
              Authorization: Bearer <JWT interno>
```

Il token di Azure serve **solo** per il login iniziale, per stabilire *chi è* chi sta bussando. Non
viene mai usato per chiamare le API di DelVoltone: per quello c'è il JWT interno.

Conseguenza pratica: **i permessi vengono sempre dal database locale**, mai da Azure. Azure dice
"questa persona è Mario Rossi"; che cosa Mario Rossi possa fare lo decide DelVoltone.

## Quale strategia usare

| | Email + password | Account Microsoft (MSAL) |
|---|---|---|
| Dove vivono le credenziali | Nel database, come hash BCrypt | In Azure AD |
| Single Sign-On | No | Sì, con l'ecosistema Microsoft 365 |
| MFA, recupero password, policy | Da implementare | Li gestisce Microsoft |
| Prerequisito per l'utente | Esistere in DelVoltone | Esistere in Azure AD **e** in DelVoltone, con la stessa email |
| Setup | Nessuno | Registrazione dell'app su Azure ([guida](azure-app-registration.md)) |
| Adatta a | Sviluppo, installazioni autonome, prototipi | Aziende già su Microsoft 365 |

In esercizio: **sviluppo con email e password, produzione con account Microsoft**.

### Come si passa dall'una all'altra

Qui c'è un punto che sorprende, ed è bene saperlo perché fa risparmiare tempo:

> **Il backend non ha una strategia.** Entrambi gli endpoint (`/login` e `/msal-login`) sono
> **sempre** attivi, e il backend emette e valida sempre e solo i propri JWT. Non esiste alcun
> interruttore lato server.
>
> Fino al 12/07/2026 in `appsettings.json` c'era una chiave `Auth:Strategy`: non era letta da nessuna
> parte del codice ed è stata **rimossa**, perché lasciava credere il contrario.

A scegliere è il **frontend**, con `VITE_AUTH_STRATEGY`:

```env
# apps/frontend/.env.local
VITE_AUTH_STRATEGY=jwt     # form email/password
VITE_AUTH_STRATEGY=msal    # pulsante "Accedi con Microsoft"
```

Il confronto in `LoginPage.vue` è con la stringa `'msal'`: qualunque altro valore mostra il form
classico. Per usare MSAL servono anche le variabili descritte nella
[guida ad Azure](azure-app-registration.md); il backend, dal canto suo, ha bisogno di
`Auth:Msal:TenantId` e `Auth:Msal:ClientId` per poter validare il token in arrivo.

## Il flusso completo

### 1. Accesso con email e password

```
POST /api/auth/login   { email, password }
        │
        ▼  LoginHandler
   ┌───────────────────────────────────────────────┐
   │ 1. Cerca l'utente per email                   │
   │ 2. Se non è attivo → 401                      │
   │ 3. Verifica la password con BCrypt            │
   │ 4. Risolve i permessi (vedi sotto)            │
   │ 5. Genera il JWT + il refresh token           │
   └───────────────────────────────────────────────┘
        │
        ▼
   200 OK  { accessToken, expiresAt, userId, email, displayName, language, permissions }
   Set-Cookie: refreshToken=…  (HttpOnly)
```

L'errore su email inesistente e quello su password sbagliata sono **lo stesso messaggio**
("Credenziali non valide"): distinguerli permetterebbe di scoprire quali email sono registrate.

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
   │ 3. Estrae l'email (preferred_username, o email)            │
   │ 4. Cerca l'utente LOCALE con quella email → se non c'è, 401│
   │ 5. Se non è attivo → 401                                   │
   │ 6. Risolve i permessi, genera il JWT interno + refresh     │
   └────────────────────────────────────────────────────────────┘
```

> **Il backend valida il token di Azure per intero.** Non si fida di quanto ha già fatto il frontend:
> verifica la firma con le chiavi pubbliche di Microsoft, l'emittente, il destinatario e la scadenza.
> Se una versione precedente di questa documentazione diceva il contrario — che il backend si limita
> a leggere il token — era **sbagliata**: il codice fa la cosa giusta.

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

### 3. Uso del token, e rinnovo

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

### 4. Uscita

`POST /api/auth/logout` revoca il refresh token e cancella il cookie. È **idempotente**: se il token
non c'è più, non è un errore. L'access token già emesso resta tecnicamente valido fino alla scadenza —
è la natura dei JWT — ma il frontend lo elimina e senza refresh token non se ne ottengono altri.

## Come si risolvono i permessi

È la stessa identica sequenza in tutti e tre gli handler (login, msal-login, refresh):

```
     Utente
       ├── RoleIds            (ruoli assegnati direttamente)
       └── GroupIds → Gruppi → RoleIds   (ruoli ereditati dai gruppi)
                                  │
                     unione + deduplica
                                  │
                               Ruoli → PermissionIds
                                  │
                            Permessi → Key   ("valleys.read", "users.write", …)
                                  │
                    un claim "permissions" per ciascuno, dentro il JWT
```

Il JWT che ne esce:

```json
{
  "sub": "42",                             // id dell'utente (int)
  "email": "mario@example.com",
  "name": "Mario Rossi",
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "permissions": ["users.read", "valleys.write"],
  "iss": "DelVoltone",
  "aud": "DelVoltoneClients",
  "exp": 1695315600
}
```

Gli endpoint verificano il claim, non il ruolo:

```csharp
group.MapDelete("/{id:int}", …)
    .RequireAuthorization(p => p.RequireClaim("permissions", "valleys.delete"));
```

## Configurazione

```json
// appsettings.local.json (gitignored) — in produzione: variabili d'ambiente
{
  "Auth": {
    "Jwt": {
      "Secret": "…almeno 32 caratteri, casuale…",
      "Issuer": "DelVoltone",
      "Audience": "DelVoltoneClients",
      "ExpiresInMinutes": 60,
      "RefreshExpiresInDays": 7
    },
    "Msal": {
      "Instance": "https://login.microsoftonline.com/",
      "TenantId": "…",
      "ClientId": "…"     // l'app registration dell'API — non quella della SPA
    }
  }
}
```

| Parametro | Note |
|---|---|
| `Jwt:Secret` | **Obbligatorio.** Se manca, l'applicazione non si avvia. Minimo 32 caratteri |
| `Jwt:ExpiresInMinutes` | Default 60. Valori sensati: 15–60 |
| `Jwt:RefreshExpiresInDays` | Default 7. Decide per quanto l'utente resta connesso senza riautenticarsi |
| `Msal:ClientId` | Il ClientId dell'**API** su Azure: è quello che il backend si aspetta come `aud` del token |

Generare un secret:

```bash
openssl rand -base64 32
```

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Max 256) }))
```

## Sicurezza — che cosa è in piedi

| Protezione | Come |
|---|---|
| Password | Hash **BCrypt** (lento, con salt): dall'hash non si risale alla password |
| Firma del JWT | HMAC-SHA256 con il secret; alla validazione `ClockSkew = 0`, nessuna tolleranza sulla scadenza |
| Refresh token | 64 byte casuali crittografici, salvati nel database, **ruotati** a ogni uso, revocabili |
| Cookie | `HttpOnly` (JavaScript non lo può leggere, neanche in caso di XSS), `Secure` fuori da sviluppo, `Path=/api/auth` |
| Brute force | Rate limiting **per IP** su login, msal-login e refresh: 10 tentativi ogni 15 minuti |
| Enumerazione utenti | Messaggio di errore identico per email sconosciuta e password errata |
| Account disattivati | `IsActive` verificato al login **e a ogni refresh** |
| Token Azure | Firma (JWKS), issuer, audience e scadenza validati **dal backend** |

### Il cookie e il `SameSite`

```csharp
ctx.Response.Cookies.Append("refreshToken", refreshToken, new CookieOptions
{
    HttpOnly = true,
    Secure = !isDev,
    // In produzione frontend e backend stanno su origin diverse (cross-site):
    // con SameSite=Lax il browser NON invierebbe il cookie sulle chiamate XHR.
    SameSite = isDev ? SameSiteMode.Lax : SameSiteMode.None,
    Path = "/api/auth",
    MaxAge = TimeSpan.FromDays(days)
});
```

Vale la pena fermarsi un attimo. In produzione il cookie è `SameSite=None`, **non** `Lax`: il
frontend (`del-voltone-frontend.onrender.com`) e il backend (`del-voltone-backend.onrender.com`) sono
due origin diverse, quindi ogni chiamata è cross-site e con `Lax` il browser non allegherebbe mai il
cookie. `None` **richiede** `Secure`, cioè HTTPS — che in produzione c'è.

Il prezzo è che `SameSite` non offre più protezione CSRF; a proteggere restano il fatto che il cookie
serve **solo** su `/api/auth` e che le API vere vogliono il Bearer token, che vive in `localStorage`
e non viaggia da solo.

## Sul frontend

```typescript
// plugins/axios.ts
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,        // senza questo il cookie del refresh non parte
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
> all'interceptor. In pratica, a token scaduto l'utente viene rimandato al login.

Lo store `auth.store.ts` conserva in `localStorage` token, scadenza, dati dell'utente e permessi; il
navigation guard del router controlla `meta.requiresAuth` e `meta.permission` prima di ogni
navigazione, e il composable `usePermission` espone `can('permesso')` per i template.

## Diagnostica

| Sintomo | Causa più probabile |
|---|---|
| **401 subito dopo il login** | Il JWT è scaduto (60 minuti) o il `Jwt:Secret` non è lo stesso con cui era stato firmato — tipico dopo un riavvio con secret diverso |
| **401 su `/api/auth/refresh`** | Il cookie non è arrivato. Controlla `withCredentials: true` sul client, `Secure`/`SameSite` sul server e che la richiesta sia su HTTPS in produzione |
| **"Nessun utente locale con email …"** | *Solo MSAL.* L'utente esiste su Azure ma non in DelVoltone. Va creato nel pannello, con la **stessa** email |
| **"Token Azure non valido: IDX10214"** | Il claim `aud` del token non corrisponde a `Auth:Msal:ClientId`. È il caso classico di SPA e API confuse: vedi la [guida ad Azure](azure-app-registration.md) |
| **"Token Azure non valido: IDX10223"** o scadenza | Orologio del server disallineato (la tolleranza è 2 minuti) o token già scaduto |
| **Il pulsante Microsoft non appare** | `VITE_AUTH_STRATEGY` non vale esattamente `msal` |
| **Il form email/password non appare** | `VITE_AUTH_STRATEGY=msal`: rimettilo a `jwt` |
| **401 "Account disabilitato"** | `IsActive = false` sull'utente |

Per guardare dentro un token: [jwt.ms](https://jwt.ms) (Azure) o [jwt.io](https://jwt.io) — mai con
token di produzione.

## I file

| File | Ruolo |
|---|---|
| `Features/Auth/AuthEndpoints.cs` | Le quattro rotte, il rate limiting, il cookie |
| `Features/Auth/Login/LoginHandler.cs` | Email + password, BCrypt |
| `Features/Auth/MsalLogin/MsalLoginHandler.cs` | Validazione del token Azure, lookup dell'utente locale |
| `Features/Auth/RefreshToken/RefreshTokenHandler.cs` | Rotation e ririsoluzione dei permessi |
| `Features/Auth/Logout/LogoutHandler.cs` | Revoca |
| `Features/Auth/Shared/JwtTokenHelper.cs` | Generazione del JWT e del refresh token |
| `Features/_Shared/Extensions/AuthExtensions.cs` | Registrazione del JwtBearer e delle policy |
| `plugins/axios.ts` · `stores/auth.store.ts` · `services/msal.service.ts` | Il lato frontend |
