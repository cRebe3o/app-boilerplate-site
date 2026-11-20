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
normalizzazione non è affidata a un helper da ricordarsi di chiamare — `Username` è un **value
object**, e la garanzia è per costruzione:

```csharp
// <Progetto>.Domain/Users/Username.cs
public sealed record Username
{
    public const int MaxLength = 256;

    public string Value { get; }

    private Username(string value) => Value = value;

    /// <summary>Crea l'username normalizzato. Lancia se vuoto o troppo lungo.</summary>
    public static Username From(string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();

        if (normalized.Length == 0)
            throw new InvariantViolationException(ErrorCode.UsernameRequired, "Username is required.");
        if (normalized.Length > MaxLength)
            throw new InvariantViolationException(ErrorCode.UsernameTooLong,
                $"Username too long (max {MaxLength} characters).", ("maxLength", MaxLength));

        return new Username(normalized);
    }
}
```

Il commento nel file spiega che cosa si guadagna rispetto a un helper statico:

> Come value object, la normalizzazione è garantita PER COSTRUZIONE: non esiste un `Username` non
> normalizzato, quindi non esiste il bug "ho dimenticato di chiamare `Normalize`" che con un helper
> statico era sempre possibile.

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

Le decisioni sono due, in due posti diversi: il **backend** decide quali metodi sono attivi, il
**frontend** quale schermata mostrare fra quelli.

**Il backend: quali metodi sono attivi.** Emette e valida sempre e solo i propri JWT, e ogni
endpoint di login esiste quando ha ciò che gli serve:

| Endpoint | Attivo | Altrimenti |
|---|---|---|
| `/login` | con `Auth:Password:Enabled` a `true`, il default | 404 |
| `/msal-login` | con `Auth:Msal:TenantId` e `Auth:Msal:ClientId` valorizzati | 404 |
| `/windows-login` | con `Auth:Windows:Enabled` a `true`: già così in `appsettings.Development.json`, fuori da Development va acceso | 404 |

Il login Windows è spento di base perché, acceso, chiunque abbia un account Windows valido per il
server può provare a entrare. Il login con password si spegne quando si entra con Microsoft o
Windows: altrimenti una password locale, scelta da chi crea l'utente, scavalcherebbe l'identity
provider e la sua seconda verifica. Con `access_mode` `private` è **spento in produzione**
(`appsettings.Production.json`); per riaccenderlo, `Auth__Password__Enabled=true`.

`GET /api/auth/methods`, anonimo, dice quali sono attivi (`{ password, microsoft, windows }`): il
frontend lo legge per sapere che cosa mostrare. I valori si leggono dalla configurazione a ogni
richiesta, quindi una modifica in `appsettings.local.json` vale senza riavviare il backend; il
frontend li legge una volta per caricamento della pagina. Se all'avvio nessun metodo è attivo
(password spenta, Microsoft non configurato, Windows spento), l'API parte con un avviso nel log.

**Con la password spenta:**

- `/api/auth/login` risponde 404 e la pagina di login non mostra il form, ma una riga che dice
  perché (`Auth:Password:Enabled`) e di impostare `VITE_AUTH_STRATEGY` su Microsoft o Windows;
- gli utenti si creano **senza password**: una password nella richiesta dà 400
  `PasswordLoginDisabled`, e "Nuovo utente" non ha il campo;
- il cambio password, quello dell'amministratore e il proprio, risponde 404, e i pulsanti
  spariscono;
- l'admin del seed nasce senza password ed entra con Microsoft (`Seed:AdminUsername` è allora la
  sua email aziendale) o con l'utente Windows; il seed lo scrive nel log, e la pagina di login non
  mostra le credenziali di sviluppo.

Le password già salvate restano nel database ma non servono più.

**Il frontend: quale schermata.** Si sceglie con `VITE_AUTH_STRATEGY`, fra i metodi attivi:

```env
# apps/frontend/.env.local
VITE_AUTH_STRATEGY=jwt       # form username/password
VITE_AUTH_STRATEGY=msal      # pulsante "Accedi con Microsoft"
VITE_AUTH_STRATEGY=windows   # nessun form: SSO Windows automatico all'apertura della pagina
```

In `LoginPage.vue` il form classico compare **solo** con `'jwt'`; `'msal'` mostra il pulsante
Microsoft; `'windows'` non mostra un form e tenta subito il Single Sign-On, con il pulsante "Accedi
con Windows" se qualcosa va storto.

Con la home non pubblica (`VITE_APP_ACCESS_MODE=private`) anche `'msal'` non aspetta il clic: la
pagina di login va direttamente a Microsoft. Si ferma sulla pagina in tre casi: di ritorno da
Microsoft con un errore (accesso annullato, consenso negato), che viene mostrato; dopo una
sessione scaduta, che la pagina spiega; dopo "Esci".

**Dopo "Esci" non si rientra da soli**, né con Windows né con Microsoft: la pagina mostra il
pulsante e aspetta un clic, anche ricaricandola, fino al login successivo. Altrimenti uscire
sarebbe impossibile: il browser ha ancora l'identità Windows o la sessione Microsoft.
`authStore.endedByLogout()` dice se l'ultima sessione è finita così.

Per usare MSAL servono anche le variabili descritte nella [guida ad Azure](azure-app-registration.md);
il backend, dal canto suo, ha bisogno di `Auth:Msal:TenantId` e `Auth:Msal:ClientId` per validare il
token in arrivo. Per Windows basta `Auth:Windows:Enabled`, già attivo in sviluppo: fuori da
Development si imposta `Auth__Windows__Enabled=true`.

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

L'errore su username inesistente e quello su password sbagliata sono **lo stesso codice**
(`InvalidCredentials`, "Username o password non corretti"): distinguerli permetterebbe di scoprire
quali utenti sono registrati. "Account disabilitato" (`AccountDisabled`) arriva solo a chi ha dato la
password giusta, e un test in `LoginHandlerTests` lo garantisce.

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

#### Il round-trip del redirect, lato frontend

Quel primo "Frontend → Azure AD" nel diagramma nasconde un giro completo del browser fuori
dall'applicazione e ritorno. MSAL Browser lo fa in modalità **redirect** (non popup): la SPA
viene *scaricata*, si apre `login.microsoftonline.com`, e al ritorno la SPA **si ricarica da
zero** su `/login`. Il codice che tiene insieme i due tronconi è distribuito su quattro file.

```
[click "Accedi con Microsoft"]  LoginPage.vue → loginWithMsal()
        │
        ▼  msalService.loginRedirect()
   await msalReady                       ← initialize() + handleRedirectPromise() già risolti
   msalInstance.loginRedirect(loginRequest)   scopes: ["api://<apiClientId>/access_as_user"]
        │
        ▼  il browser LASCIA la SPA
   login.microsoftonline.com    (login, MFA, consenso)
        │
        ▼  redirect a redirectUri = window.location.origin + "/login"
   /login#code=…                la SPA si RICARICA da zero
        │
        ▼  plugins/msal.ts, a modulo caricato:
   msalReady = initialize().then(() => handleRedirectPromise())
        │                     handleRedirectPromise() vede il #code=…, lo scambia con Azure
        │                     per un access token e lo mette nella cache (sessionStorage)
        ▼  LoginPage.vue  onMounted(), strategia === "msal":
   const token = await msalService.handleRedirectResult()
        │                     → result?.accessToken  (null se non stiamo tornando da un redirect)
        ▼
   authStore.loginWithMsal(token)  →  POST /api/auth/msal-login { azureToken: token }
```

Il pezzo di configurazione che rende possibile il ritorno è il `redirectUri`:

```typescript
// plugins/msal.ts
export const msalInstance = new PublicClientApplication({
  auth: {
    clientId: import.meta.env.VITE_MSAL_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_MSAL_TENANT_ID}`,
    redirectUri: window.location.origin + '/login',   // Azure rimanda QUI dopo il login
  },
  cache: { cacheLocation: 'sessionStorage' },   // i token di Microsoft muoiono con la scheda
})

// initialize() e handleRedirectPromise() vengono eseguiti una volta sola, all'import del
// modulo: ogni consumatore aspetta `msalReady` invece di richiamarli.
export const msalReady = msalInstance.initialize().then(() => msalInstance.handleRedirectPromise())
```

Tre punti che non si intuiscono dal diagramma:

- **`handleRedirectPromise()` va chiamato sempre, non solo "se torno da un redirect".** È lui a
  decidere: se nell'URL c'è un `#code=…` completa lo scambio e restituisce il risultato, altrimenti
  restituisce `null`. Nel template è incapsulato in `msalReady` in modo che parta a ogni caricamento
  della pagina, prima di qualunque altra logica MSAL.
- **Lo scope decide l'`aud` del token.** `loginRequest.scopes` chiede
  `api://<apiClientId>/access_as_user`, e `apiClientId` è `VITE_MSAL_API_CLIENT_ID` (con fallback su
  `VITE_MSAL_CLIENT_ID` quando SPA e API condividono la stessa app registration). È questo valore che
  il backend si aspetta di ritrovare in `aud` — se non combacia, è l'`IDX10214` della sezione
  precedente.
- **`handleRedirectResult()` è a colpo singolo.** Un flag `redirectConsumed` fa sì che restituisca il
  token una volta sola: serve a non riutilizzare il risultato di un vecchio redirect dopo un logout.
  Nota anche che in `LoginPage.vue` la variabile si chiama `idToken` ma contiene l'**access token** —
  è ciò che `handleRedirectResult()` ritorna e ciò che il backend valida come "token Azure".

Da `authStore.loginWithMsal(token)` in poi il flusso rientra nel tracciato comune: `_setSession()`
salva il **JWT interno** in `localStorage`, `router.push('/home')`, e ogni richiesta successiva porta
`Authorization: Bearer <JWT interno>`. Il token Azure ha esaurito il suo compito e non viene più
toccato; il rinnovo passa dal cookie di refresh, non da un nuovo giro su Microsoft.

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
// AuthEndpoints.cs — l'endpoint chiede lui l'handshake Negotiate
group.MapPost("/windows-login", async (/* … */) =>
{
    if (!config.GetValue<bool>("Auth:Windows:Enabled"))
        return Results.NotFound();                         // login Windows spento

    var windows = await ctx.AuthenticateAsync(NegotiateDefaults.AuthenticationScheme);
    if (windows.Succeeded)
        ctx.User = windows.Principal;
    var accountName = WindowsAccountName(ctx, env);         // l'handshake, o l'header di sviluppo

    if (string.IsNullOrWhiteSpace(accountName))             // nessuna identità: il browser ritenta
        return Results.Challenge(new AuthenticationProperties(), [NegotiateDefaults.AuthenticationScheme]);
    /* … WindowsLoginCommand, cookie, risposta … */
})
.AllowAnonymous()
.RequireRateLimiting(RateLimits.Session);
```

Tutti gli altri endpoint continuano a usare JWT Bearer. Su Windows il pacchetto
`Microsoft.AspNetCore.Authentication.Negotiate` funziona **anche fuori dominio**, con il fallback NTLM
sull'account locale della macchina.

> **Bypass di sviluppo.** In `Development`, e **solo da questo computer** (richiesta da loopback),
> l'endpoint accetta l'header `X-Dev-Windows-User: DOMINIO\utente` e lo usa come identità, senza
> handshake. Serve per `curl`/Postman, dove non c'è un browser che negozia Kerberos, e per simulare
> utenti diversi senza cambiare l'account Windows della macchina. Da un altro computer l'header non
> vale, anche in Development: chiunque in rete potrebbe dichiararsi admin. Fuori da Development il
> ramo è irraggiungibile.

### 4. Uso del token, e rinnovo

L'access token dura **60 minuti** (configurabile). Alla scadenza si usa il refresh token, che vive in
un cookie e dura **7 giorni**.

```
POST /api/auth/refresh          (il cookie viaggia da solo)
        │
        ▼  RefreshTokenHandler
   ┌──────────────────────────────────────────────┐
   │ 1. Cerca il refresh token (per hash)         │
   │ 2. Già speso → revoca TUTTI quelli           │
   │    dell'utente, 401                          │
   │ 3. Se scaduto → 401                          │
   │ 4. Utente inesistente o disattivato → 401    │
   │ 5. REVOCA il token appena usato  ← rotation  │
   │ 6. Ririsolve i permessi (aggiornati!)        │
   │ 7. Emette un nuovo JWT + un nuovo refresh    │
   └──────────────────────────────────────────────┘
```

**Nel database c'è l'hash, non il token.** Il refresh token si salva come hash SHA-256: chi legge
la tabella non ha token da usare.

**Rotation.** Ogni refresh consuma il token e ne emette uno nuovo. Se torna indietro un token già
speso, o il cookie è stato rubato o qualcun altro lo usa insieme all'utente: non si sa quale dei
due sia quello vero, quindi si chiudono **tutte** le sessioni dell'utente, compresa quella nata dal
rinnovo. Chi ruba un cookie vecchio chiude la sessione invece di affiancarla.

**Il token di accesso vale finché l'utente è quello di quando è stato emesso.** A ogni richiesta
l'autenticazione controlla che l'utente esista, sia attivo e abbia password, ruoli e gruppi di
allora (`UserSessions`). Il confronto passa da un'impronta nel token, il claim `sst`, senza colonne
nel database; lo stato di ogni utente resta in cache per un minuto, e `UnitOfWork` lo toglie dalla
cache quando salva l'utente. Così un utente eliminato, disattivato, con la password o i ruoli
cambiati riceve 401 alla richiesta successiva, invece di usare il token fino alla scadenza. Con
più istanze dell'API l'effetto arriva entro il minuto della cache.

Il cambio di ruoli o gruppi revoca anche i refresh token, come eliminazione, disattivazione e cambio
password: l'utente rientra con un login. Un permesso aggiunto o tolto **a un ruolo** non cambia
l'impronta degli utenti che lo hanno: arriva con il refresh successivo, al più tardi dopo un'ora.

### 5. Cambio della propria password

Ognuno cambia la propria password da "Cambia la mia password", nel menu dell'utente, con
`POST /api/auth/password { currentPassword, newPassword }`. Basta aver fatto accesso, senza
permessi; è diverso dal cambio fatto da un amministratore, che chiede `users.write` e non chiede la
password attuale.

- **Serve la password attuale.** Chi trova una sessione aperta, o ruba un token di accesso, non si
  prende l'account cambiandola. Se è sbagliata la risposta è 400 `CurrentPasswordWrong`, un errore
  sul campo e non un 401: la sessione resta valida.
- **La nuova segue `PasswordRules`**, le stesse regole della creazione.
- **Le altre sessioni si chiudono.** I refresh token dell'utente si cancellano e i token di accesso
  già emessi non valgono più, perché l'impronta `sst` contiene la password. Questa sessione continua
  con un token e un cookie nuovi, nella risposta. I refresh token si cancellano invece di revocarli:
  un token revocato, presentato da un'altra scheda, sembrerebbe rubato e chiuderebbe anche questa
  sessione.
- **Stesso limite di frequenza del login con password**, perché con un token rubato si potrebbe
  provare una password attuale dopo l'altra.
- Con `Auth:Password:Enabled` spento risponde 404 e la voce del menu non c'è. Chi entra con
  Microsoft o Windows non ha una password locale: riceve 409 `NoLocalPassword`.

### 6. Uscita

`POST /api/auth/logout` revoca il refresh token e cancella il cookie. È **idempotente**: se il token
non c'è più, non è un errore. L'access token già emesso resta tecnicamente valido fino alla scadenza —
è la natura dei JWT — ma il frontend lo elimina e senza refresh token non se ne ottengono altri.

Il frontend chiama `/api/auth/logout` solo quando l'utente preme "Esci". Una sessione scaduta esce
solo in locale, senza revocare niente: il cookie che il browser ha in quel momento potrebbe essere
quello appena rinnovato da un'altra scheda (vedi [Sul frontend](#sul-frontend)).

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
  "sst": "Xk2pQ9rT0bWc8vLs1aZy3w==",            // impronta di password, ruoli e gruppi (UserSessions)
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

Un endpoint che non dichiara niente **chiede comunque l'accesso**: è la regola di riserva
(`SetFallbackPolicy` in `AuthExtensions`), che prima non c'era, e un endpoint dimenticato era
pubblico. Gli endpoint anonimi lo dicono con `.AllowAnonymous()`: login, refresh, `methods`,
`/openapi`, il tramite di Grafana. I pannelli montati come middleware (lavori programmati, ingresso
di Grafana) decidono da sé, e un indirizzo che non esiste resta 404.

`EndpointAuthorizationTests` (in `Architecture.Tests`) controlla che ogni endpoint stia in uno di
tre casi: chiede un permesso del catalogo del seed, sta nell'elenco `Anonymous`, oppure sta
nell'elenco `SignedInOnly`, per quelli a cui basta l'accesso (come il cambio della propria
password). Un endpoint nuovo che non rientra in nessuno dei tre fa fallire i test finché non si
decide quale.

### Chi può dare ruoli e permessi

Con `users.write` si modifica un utente, ma non si assegna qualunque cosa. Le regole stanno in
`IAdministrationRules`, che ogni handler che assegna ruoli, gruppi o permessi usa:

- **nessuno cambia i propri ruoli o gruppi** (`OwnAccessNotEditable`);
- **solo un SuperAdmin** assegna il ruolo SuperAdmin, direttamente o con un gruppo, e modifica,
  elimina o cambia la password di un SuperAdmin (`SuperAdminRequired`);
- **nessuno dà permessi che non ha**, né con un ruolo, né con un gruppo, né aggiungendo un permesso
  a un ruolo (`PermissionsNotHeld`).

I tre codici rispondono 403. Senza queste regole un Admin poteva farsi SuperAdmin da solo.

Due regole riguardano i ruoli stessi:

- **I permessi riservati al SuperAdmin non vanno a nessun altro ruolo**, nemmeno personalizzato:
  `permissions.*`, e `jobs.dashboard` e `telemetry.dashboard` quando il progetto ha lavori
  programmati e Grafana (`Permission.SuperAdminOnlyResources`). Darli risponde 403
  `SuperAdminOnlyPermission`, e la pagina Ruoli li mostra bloccati (`superAdminOnly` nella risposta
  di `/api/permissions`). Se un ruolo li ha già, il seed glieli toglie all'avvio e lo scrive nel log
  ("Seed: tolti ai ruoli i permessi riservati al SuperAdmin").
- **Dei ruoli di sistema si cambiano i permessi, non nome e descrizione** (`SystemRoleNotEditable`).
  Il SuperAdmin non si tocca: ha sempre tutti i permessi, e la sua pagina è in sola lettura. Così un
  permesso nuovo, che su un database esistente il seed dà solo al SuperAdmin, si assegna ad Admin e
  Viewer dalla pagina Ruoli.

Il catalogo dei permessi (`GET /api/permissions`) si legge con `permissions.read` **o** con
`roles.read`: chi modifica i ruoli deve vedere i permessi da dare, e un Admin non ha
`permissions.read`.

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
    },
    "Password": {
      "Enabled": true     // false: si entra solo con Microsoft o Windows
    },
    "Windows": {
      "Enabled": false    // true in appsettings.Development.json
    }
  }
}
```

| Parametro | Note |
|---|---|
| `Jwt:Secret` | **Obbligatorio.** Se manca, l'applicazione non si avvia. Fuori da Development deve essere casuale, lungo almeno 32 caratteri e diverso da quello di esempio (`CAMBIA_…`), altrimenti l'API non parte: chi conosce il segreto firma token validi per qualunque utente |
| `Jwt:ExpiresInMinutes` | Default 60. Valori sensati: 15–60 |
| `Jwt:RefreshExpiresInDays` | Default 7. Decide per quanto l'utente resta connesso senza riautenticarsi |
| `Msal:TenantId` · `Msal:ClientId` | Il ClientId dell'**API** su Azure: è quello che il backend si aspetta come `aud` del token. Vuoti, `/msal-login` risponde 404 |
| `Password:Enabled` | Default `true`. Spento: `/login` e i cambi password rispondono 404, gli utenti nascono senza password. Con `access_mode` `private` è `false` in `appsettings.Production.json`; si riaccende con `Auth__Password__Enabled=true`. Vedi [Come si passa dall'una all'altra](#come-si-passa-dall-una-all-altra) |
| `Windows:Enabled` | Accende `/windows-login`. `true` in `Development`, `false` altrove: fuori da Development si imposta `Auth__Windows__Enabled=true`. Serve anche il pacchetto NuGet `Microsoft.AspNetCore.Authentication.Negotiate`, già nel progetto |

Generare un secret:

```bash
openssl rand -base64 32
```

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Max 256) }))
```

### Il pacchetto Negotiate e la versione

L'autenticazione Windows dipende da `Microsoft.AspNetCore.Authentication.Negotiate`, pinnato nel
template a **10.0.15** — la stessa patch di tutti gli altri pacchetti `Microsoft.*`, che vanno
aggiornati insieme. Le versioni `10.0.0`–`10.0.9` sono soggette a due avvisi di sicurezza di
gravità alta (`GHSA-8prm-248r-h957`, `GHSA-2p3q-h3hg-jcqq`) che riguardano l'uso di Negotiate con
LDAP per il recupero dei ruoli: `dotnet build` li segnala come `NU1903`. Dalla 10.0.10 sono chiusi.
Le versioni fino alla 10.0.12 hanno un altro avviso alto (`GHSA-vrrp-6v32-2p8g`), chiuso dalla
10.0.13 — non scendere sotto quella versione. `pnpm verify` fallisce se accade.

## Simulare l'autenticazione Windows in locale

Windows Auth **funziona sulla macchina di sviluppo** anche senza un dominio Active Directory: su
Windows il pacchetto Negotiate fa il fallback NTLM con l'account locale.

**Opzione A — Kestrel + NTLM locale (consigliata per iniziare).**
`dotnet run` normale (in Development `Auth:Windows:Enabled` è già `true`). Il browser chiama `POST http://localhost:<porta>/api/auth/windows-login`,
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

Non serve un browser, e si può simulare qualsiasi utente cambiando il valore dell'header. Vale
solo da questo computer: la stessa richiesta da un'altra macchina ignora l'header.

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
| Password | Hash **BCrypt** (lento, con salt): dall'hash non si risale alla password. Massimo 64 caratteri in creazione e nel cambio password (`PasswordRules`): BCrypt usa solo i primi 72 byte, e oltre due password con lo stesso inizio darebbero lo stesso hash. Il login non ha massimo, così chi ha già una password più lunga entra. Creazione e cambio password chiedono le stesse regole: almeno una maiuscola e una cifra |
| Firma del JWT | HMAC-SHA256 con il secret; alla validazione `ClockSkew = 0`, nessuna tolleranza sulla scadenza |
| Segreto del JWT | Controllato all'avvio: fuori da Development, se è quello di esempio o più corto di 32 caratteri, l'API non parte |
| Refresh token | 64 byte casuali crittografici, salvati come **hash SHA-256**, **ruotati** a ogni uso, revocabili. Il riuso di un token già speso revoca tutti quelli dell'utente |
| Token di accesso | Valido solo finché l'utente esiste, è attivo e ha password, ruoli e gruppi di quando è stato emesso (`UserSessions`, claim `sst`) |
| Cookie | `HttpOnly` (JavaScript non lo può leggere, neanche in caso di XSS), `Secure` fuori da sviluppo, `Path=/api/auth` |
| Brute force | Rate limiting **per indirizzo del client** (`RateLimits` in `Api/Extensions`). Login con username e password: 10 tentativi ogni 15 minuti in produzione (100 in `Development`, per non intralciare il prova-riprova). Refresh, msal-login e windows-login: 300 ogni 15 minuti, perché non hanno una password da indovinare e un ufficio dietro un solo IP deve poter accedere tutto insieme. Dietro un proxy l'indirizzo vero arriva solo con `ForwardedHeaders` configurato: vedi [Configurazione](../progetto/configurazione.md#forwardedheaders) |
| Enumerazione utenti | Codice di errore identico per username sconosciuto e password errata; l'account disabilitato si rivela solo con la password giusta |
| Account disattivati | `IsActive` verificato al login, a ogni refresh **e a ogni richiesta** |
| Ruoli e permessi | Nessuno cambia i propri, solo un SuperAdmin tocca il ruolo SuperAdmin, nessuno dà permessi che non ha (`IAdministrationRules`); i permessi riservati al SuperAdmin non vanno a nessun altro ruolo (`SuperAdminOnlyPermission`) |
| Endpoint senza dichiarazione | Chiedono l'accesso (regola di riserva); gli anonimi lo dichiarano con `.AllowAnonymous()`, e un test li elenca |
| Login con password | Spegnibile (`Auth:Password:Enabled`), spento in produzione con `access_mode` `private`: una password locale non scavalca l'identity provider |
| Cambio della propria password | Chiede la password attuale, chiude le altre sessioni, stesso limite di frequenza del login |
| Token Azure | Firma (JWKS), issuer, audience e scadenza validati **dal backend**. Nel browser i token di Microsoft stanno in `sessionStorage` |
| Identità Windows | Login attivo solo con `Auth:Windows:Enabled`; handshake Negotiate gestito dal middleware ASP.NET; header di bypass solo in Development e solo da questo computer |
| Intestazioni HTTP | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` su ogni risposta; su `/api` anche una CSP e `Cache-Control: no-store`; HSTS fuori da Development |
| Swagger e schema OpenAPI | Solo in Development, o con `OpenApi:Enabled` |

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

// 401 → un solo refresh condiviso, poi si ripete la richiesta; si esce solo se la sessione è persa
api.interceptors.response.use(
  res => res,
  async error => {
    if (error.response?.status === 401 && !isLoggingOut && !isAuthRequest) {
      if (!originalRequest._retry) {
        originalRequest._retry = true
        const failedToken = /* il token che il server ha rifiutato, dall'header Authorization */
        refreshPromise ??= authStore.refresh({ failedToken }).finally(() => { refreshPromise = null })
        const result = await refreshPromise
        if (result.outcome === 'refreshed') return api(originalRequest)
        if (result.outcome === 'unavailable')                     // rete assente, 5xx, 429…
          return Promise.reject(extractServerFailure(result.error) ? result.error : new SessionNotRenewedError(result.error))
      }
      await authStore.expireSession()                             // sessione persa: uscita solo in locale
    }
    return Promise.reject(error)
  },
)
```

Un token scaduto **non** manda al login: l'interceptor chiama `/api/auth/refresh` con il cookie e
ripete la richiesta una volta. Più richieste che ricevono 401 insieme condividono lo stesso refresh.
Si esce solo quando il refresh dice che la sessione non c'è più (401). Se invece il server non
risponde, risponde con un 5xx o rifiuta il rinnovo con un altro 4xx (di solito 429, troppi rinnovi),
la sessione resta e fallisce solo la richiesta: rete assente e 5xx hanno il loro messaggio, il 4xx
diventa `SessionNotRenewedError`, "Non è stato possibile rinnovare la sessione. Riprova tra poco."
Nessun toast: lo mostra l'avviso della pagina.

Quando la sessione è persa, `authStore.expireSession()` la svuota solo in locale e porta alla
pagina di login, che dice "La sessione è scaduta: accedi di nuovo." Non chiama `/api/auth/logout`.

**Più schede.** Le schede dello stesso browser condividono `localStorage` e il cookie di refresh, che
cambia a ogni rinnovo. Se due schede rinnovassero insieme, la seconda manderebbe un cookie già
revocato e riceverebbe 401. Per questo `authStore.refresh` rinnova una scheda alla volta, con
`navigator.locks`. La scheda che arriva per seconda trova in `localStorage` un token diverso da
quello rifiutato e usa quello, senza chiamare il server. Nei browser senza `navigator.locks`, dopo
un 401 il rinnovo aspetta un momento un token nuovo scritto da un'altra scheda. Le schede si
allineano con l'evento `storage`:

| In una scheda | Nelle altre |
|---|---|
| rinnovo | usano il token nuovo |
| "Esci" | escono anche loro e tornano alla home, senza messaggio |
| sessione scaduta | escono e vanno al login, con il messaggio |

Il motivo dell'uscita sta in `localStorage`, nella chiave `sessionEnd`.

Dopo un salvataggio che può cambiare i permessi dell'utente corrente (gruppi, ruoli, utenti), la
pagina chiama `authStore.refreshAfterSave()`, che rinnova la sessione per avere i permessi nuovi e
dice "Salvato". Il rinnovo chiama sempre il server, anche se un'altra scheda ha appena rinnovato.
Se non riesce, l'avviso dice che i permessi si aggiorneranno al prossimo accesso. Se la sessione è
scaduta, il toast dice "Salvato. La sessione è scaduta: accedi di nuovo." e l'utente va al login,
senza un secondo messaggio.

Lo store `auth.store.ts` conserva in `localStorage` token, scadenza, `username`, `email` (se presente),
gli altri dati dell'utente e i permessi. Le azioni di login sono tre: `login()`, `loginWithMsal()`,
`loginWithWindows()`. Si esce con `logout()` ("Esci", che revoca il cookie) o con `expireSession()`
(sessione scaduta). Il navigation guard del router controlla `meta.requiresAuth` e `meta.permission`
prima di ogni navigazione, e il composable `usePermission` espone `can('permesso')` per i template.

Nella gestione utenti il campo obbligatorio è **Username** (con un suggerimento su cosa scriverci:
username locale, email per MSAL, `DOMINIO\utente` per Windows); **Email** è facoltativo.

## Diagnostica

| Sintomo | Causa più probabile |
|---|---|
| **401 subito dopo il login** | Il JWT è scaduto (60 minuti) o il `Jwt:Secret` non è lo stesso con cui era stato firmato — tipico dopo un riavvio con secret diverso |
| **401 a una richiesta qualsiasi, con la sessione ancora nei tempi** | L'utente è stato disattivato, eliminato, o ha cambiato password, ruoli o gruppi: il token non vale più. Si rientra con un login |
| **Dopo l'aggiornamento alla 7.0 tutti sono usciti** | Atteso, una volta sola: i refresh token salvati prima non valgono più (ora c'è l'hash) e i token di accesso senza claim `sst` vengono rifiutati |
| **`/msal-login` o `/windows-login` rispondono 404** | Login non attivo: mancano `Auth:Msal:TenantId`/`ClientId`, o `Auth:Windows:Enabled` non è `true` |
| **L'API non parte: "Auth:Jwt:Secret non valido fuori da Development"** | Segreto di esempio o più corto di 32 caratteri: generane uno (sopra) |
| **403 assegnando un ruolo, un gruppo o un permesso** | `OwnAccessNotEditable`, `SuperAdminRequired` o `PermissionsNotHeld`: vedi [Chi può dare ruoli e permessi](#chi-puo-dare-ruoli-e-permessi) |
| **Il login con password si blocca per tutti dopo pochi errori** | L'API è dietro un proxy e `ForwardedHeaders` non è configurato: tutti i client hanno l'indirizzo del proxy e condividono il limite. Vedi [Configurazione](../progetto/configurazione.md#forwardedheaders) |
| **401 su `/api/auth/refresh`** | Il cookie non è arrivato. Controlla `withCredentials: true` sul client, `Secure`/`SameSite` sul server e che la richiesta sia su HTTPS in produzione |
| **"Nessun utente locale con username …"** | *MSAL o Windows.* L'identità è valida ma non c'è un utente locale con quello `Username`. Va creato nel pannello, con lo `Username` esatto (per MSAL: la email aziendale; per Windows: `DOMINIO\utente`) |
| **"Token Azure non valido: IDX10214"** | Il claim `aud` del token non corrisponde a `Auth:Msal:ClientId`. È il caso classico di SPA e API confuse: vedi la [guida ad Azure](azure-app-registration.md). Lato SPA l'`aud` lo fissa lo scope in `loginRequest` (`VITE_MSAL_API_CLIENT_ID`) |
| **Torno da Microsoft ma resto sul login, nessun errore** | `handleRedirectPromise()` non è stato eseguito al ricaricamento della pagina (in `msal.ts` è dentro `msalReady`), oppure il `redirectUri` dell'app su Azure non è **esattamente** `origin + /login` |
| **`AADSTS50011: redirect URI mismatch`** | Il `redirectUri` calcolato (`window.location.origin + '/login'`) non è tra quelli registrati sull'app SPA in Entra ID — vanno aggiunti sia l'URL locale sia quello di produzione |
| **"Token Azure non valido: IDX10205"** (issuer `sts.windows.net/…`) | L'app registration dell'API emette token **v1.0**: nel suo Manifest `requestedAccessTokenVersion` è `null` invece di `2`. Vedi la [guida ad Azure](azure-app-registration.md#forzare-i-token-in-versione-20) |
| **"Token Azure non valido: IDX10223"** o scadenza | Orologio del server disallineato (la tolleranza è 2 minuti) o token già scaduto |
| **SSO Windows: 401 e nessun popup** | Il browser non invia le credenziali. Chrome/Edge: l'host non è in zona intranet. Firefox: manca `network.negotiate-auth.trusted-uris`. In alternativa usa l'header `X-Dev-Windows-User` in Development, da questo computer |
| **SSO Windows: `NU1903` a `dotnet build`** | Pacchetto Negotiate su una versione < 10.0.10: aggiorna |
| **Il pulsante Microsoft non appare** | `VITE_AUTH_STRATEGY` non vale esattamente `msal` |
| **Il form username/password non appare** | `VITE_AUTH_STRATEGY` vale `msal` o `windows`: rimettilo a `jwt`. Se la pagina dice che l'accesso con username e password non è attivo, è spento nel backend (`Auth:Password:Enabled`, spento in produzione con `access_mode` `private`) |
| **404 su `/api/auth/login` o sul cambio password** | `Auth:Password:Enabled` è `false`: si entra con Microsoft o Windows |
| **400 `PasswordLoginDisabled` creando un utente** | Password spenta nel backend: l'utente si crea senza password |
| **409 `NoLocalPassword` su "Cambia la mia password"** | L'utente entra con Microsoft o Windows e non ha una password locale |
| **403 `SuperAdminOnlyPermission`** | Si è provato a dare a un ruolo un permesso riservato al SuperAdmin: vedi [Chi può dare ruoli e permessi](#chi-puo-dare-ruoli-e-permessi) |
| **Un endpoint nuovo risponde 401 a chi non ha fatto accesso** | Regola di riserva: se deve essere pubblico, `.AllowAnonymous()` e la riga in `Anonymous` di `EndpointAuthorizationTests` |
| **"Nessun metodo di accesso attivo" nel log all'avvio** | Password spenta, `Auth:Msal` non configurato e Windows spento: nessuno può entrare. Tipico con `access_mode` `private` in produzione prima di configurare Microsoft |
| **401 "Account disabilitato"** | `IsActive = false` sull'utente |

Per guardare dentro un token: [jwt.ms](https://jwt.ms) (Azure) o [jwt.io](https://jwt.io) — mai con
token di produzione.

## I file

| File | Ruolo |
|---|---|
| `Api/Endpoints/AuthEndpoints.cs` | Le rotte, il rate limiting, il cookie, il bypass dev di Windows |
| `Application/Auth/Login/LoginHandler.cs` | Username + password, BCrypt |
| `Application/Auth/MsalLogin/MsalLoginHandler.cs` | Validazione del token Azure, lookup dell'utente locale |
| `Application/Auth/WindowsLogin/WindowsLoginHandler.cs` | Identità Windows → lookup dell'utente locale per `Username` |
| `Application/Auth/RefreshToken/RefreshTokenHandler.cs` | Rotation e ririsoluzione dei permessi |
| `Application/Auth/Logout/LogoutHandler.cs` | Revoca |
| `Application/Abstractions/Identity/` | Le astrazioni: `ITokenService`, `IPasswordHasher`, `IPermissionResolver`, `IExternalTokenValidator`, `ICurrentUser` |
| `Infrastructure/Identity/JwtTokenService.cs` | Generazione del JWT e del refresh token |
| `Infrastructure/Identity/UserSessions.cs` | L'impronta `sst` e il controllo, a ogni richiesta, che il token valga ancora |
| `Application/Common/AdministrationRules.cs` | Chi può assegnare ruoli, gruppi e permessi |
| `Infrastructure/Identity/BcryptPasswordHasher.cs` | Hashing delle password |
| `Infrastructure/Identity/AzureAdTokenValidator.cs` | Validazione del token Azure |
| `Infrastructure/Identity/PermissionResolver.cs` | Ruoli diretti + ereditati dai gruppi → permessi |
| `Infrastructure/Identity/CurrentUser.cs` | L'utente della richiesta, letto dai claim: tiene ASP.NET fuori da Application |
| `Domain/Users/Username.cs` | L'identità di login come value object (trim + minuscolo per costruzione) |
| `Api/Extensions/AuthExtensions.cs` | Registrazione di JwtBearer + Negotiate e delle policy |
| `plugins/msal.ts` | Istanza `PublicClientApplication`, `redirectUri`, `msalReady` (initialize + handleRedirectPromise) |
| `services/msal.service.ts` | `loginRedirect()` e `handleRedirectResult()` — lo scope che fissa l'`aud`, il flag a colpo singolo |
| `plugins/axios.ts` · `stores/auth.store.ts` · `pages/auth/LoginPage.vue` | Bearer token, sessione in `localStorage`, scelta della schermata via `VITE_AUTH_STRATEGY` |
