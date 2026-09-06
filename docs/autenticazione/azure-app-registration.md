# App registration su Azure

Guida operativa per far funzionare l'accesso con account Microsoft. Serve una sola volta, per
ambiente. Il funzionamento a valle è descritto in [JWT e MSAL](autenticazione.md).

> **Prerequisito**: un account Azure con il ruolo *Global Administrator* o *Application
> Administrator*. Il portale è su [portal.azure.com](https://portal.azure.com); il servizio si chiama
> **Microsoft Entra ID** (l'ex Azure Active Directory: stessa cosa, nome nuovo).

> **Le voci del portale sono in inglese.** Questa guida riporta i nomi dei menu e dei pulsanti come
> compaiono nel portale in lingua inglese, con la traduzione italiana tra parentesi dove può servire.
> Se il tuo portale è in italiano, l'etichetta tra parentesi è quella che vedi.

## Il modello: due app, non una

È il punto in cui ci si perde, quindi conviene chiarirlo subito. In produzione si usano **due
app registration distinte**:

| App registration | Che cos'è | Chi la usa |
|---|---|---|
| **SPA** | Il frontend Vue che apre la finestra di login | `VITE_MSAL_CLIENT_ID` |
| **API** | Il backend, cioè il *destinatario* del token | `Auth:Msal:ClientId` (backend) e `VITE_MSAL_API_CLIENT_ID` (frontend, per chiedere il token giusto) |

Il motivo è nel claim `aud` (*audience*) del token: dice **a chi** il token è destinato. Il backend
accetta solo token il cui `aud` è la propria app registration. Se la SPA chiede un token senza
specificare lo scope dell'API, Azure emette un token destinato **alla SPA**, e il backend
giustamente lo rifiuta — è l'errore `IDX10214`.

```
   SPA (ClientId A)                              API (ClientId B)
        │                                              ▲
        │  chiede un token per lo scope               │  aud = B  ✔ accettato
        │  api://B/access_as_user                     │
        ▼                                              │
   Azure AD  ──────────  token con aud = B  ───────────┘
```

**Si può usare una sola app** per entrambi i ruoli: in quel caso `VITE_MSAL_API_CLIENT_ID` resta
vuoto e il frontend assume che SPA e API condividano lo stesso ClientId. È la configurazione più
semplice, va benissimo per lo sviluppo. La separazione è preferibile in produzione, perché isola i
permessi dei due componenti.

Il resto della guida descrive il caso completo, con due app.

## 1. Registrare l'app dell'API

1. **Microsoft Entra ID** → **App registrations** (*Registrazioni app*) → **+ New registration**
   (*+ Nuova registrazione*).
2. **Name** (*Nome*): `<Progetto>-API` (per esempio `MioProgetto-API`).
3. **Supported account types** (*Tipi di account supportati*): **Accounts in this organizational
   directory only** (*Solo account nella directory organizzativa*), cioè single tenant — è la scelta
   giusta se tutti gli utenti appartengono alla stessa organizzazione.
4. **Redirect URI** (*URI di reindirizzamento*): nessuno, l'API non ne ha bisogno.
5. **Register** (*Registra*).

Dalla pagina **Overview** (*Panoramica*) annota **Application (client) ID** (*ID applicazione
(client)*) e **Directory (tenant) ID** (*ID directory (tenant)*).

### Esporre l'API e lo scope

1. **Expose an API** (*Esponi un'API*) → accanto ad *Application ID URI* (*URI ID applicazione*)
   clicca **Add** (*Aggiungi*) e accetta la proposta di Azure (`api://{clientId}`) → **Save**
   (*Salva*).
2. **+ Add a scope** (*+ Aggiungi un ambito*):

   | Campo | Valore |
   |---|---|
   | **Scope name** (*Nome ambito*) | `access_as_user` |
   | **Who can consent?** (*Chi può consentire*) | **Admins and users** (*Amministratori e utenti*) |
   | **Admin consent display name** (*Nome visualizzato del consenso amministratore*) | Accedi all'applicazione come utente |
   | **Admin consent description** (*Descrizione del consenso amministratore*) | Consente all'app di accedere all'applicazione per conto dell'utente connesso |
   | **State** (*Stato*) | **Enabled** (*Abilitato*) |

Lo scope completo diventa `api://{API_CLIENT_ID}/access_as_user`: è quello che la SPA chiederà.

### Forzare i token in versione 2.0

**Da fare, altrimenti il login fallisce con `IDX10205: Issuer validation failed`.**

Il backend valida l'issuer del token contro l'endpoint **v2.0**:

```csharp
// MsalLoginHandler.cs
ValidIssuer = $"https://login.microsoftonline.com/{tenantId}/v2.0",
```

Ma un'app registration appena creata ha `requestedAccessTokenVersion` a `null`, e con quel
valore Azure emette **access token in formato v1.0**, il cui issuer è
`https://sts.windows.net/{tenantId}/` — diverso, quindi la validazione scatta e il backend
risponde `401 "Token Azure non valido: IDX10205"`.

Sull'app **`<Progetto>-API`** → **Manifest**, trova l'oggetto `api` e porta
`requestedAccessTokenVersion` a `2`:

```jsonc
"api": {
    "requestedAccessTokenVersion": 2,      // era null
    "acceptMappedClaims": null,
    "knownClientApplications": [],
    "oauth2PermissionScopes": [ /* … lo scope access_as_user già definito … */ ],
    "preAuthorizedApplications": []
}
```

> A seconda della versione dell'editor del manifest la proprietà può comparire al livello
> radice come `accessTokenAcceptedVersion` invece che dentro `api`: è la stessa impostazione,
> mettila comunque a `2`.

**Save** (*Salva*). Poi, sul client, fai **logout e svuota `localStorage`** prima di
riprovare: MSAL tiene in cache l'access token e senza pulizia riuserebbe quello v1.0.

Verifica su [jwt.ms](https://jwt.ms): nel token devono comparire `"ver": "2.0"` e
`"iss": "https://login.microsoftonline.com/{tenant}/v2.0"`.

## 2. Registrare l'app della SPA

1. **+ New registration** (*+ Nuova registrazione*), **Name** (*Nome*) `<Progetto>-SPA`, single tenant.
2. **Authentication** (*Autenticazione*) → **+ Add a platform** (*+ Aggiungi una piattaforma*) →
   **Single-page application** (*Applicazione a pagina singola (SPA)*).

   > Deve essere **Single-page application**, non *Web*. La piattaforma Web usa il flusso implicito e
   > produce l'errore `AADSTS700054`. La SPA usa Authorization Code con PKCE, che è più sicuro e non
   > richiede alcun client secret.

3. **Redirect URIs** (*URI di reindirizzamento*): **deve coincidere esattamente** con
   `window.location.origin + '/login'`.

   ```
   http://localhost:5173/login             sviluppo (con frontend_port = 5173)
   https://<frontend>.onrender.com/login   produzione
   ```

   Attenzione a protocollo, porta, path e trailing slash: ogni differenza produce
   `redirect_uri_mismatch` (o `AADSTS50011`, che è la stessa cosa detta in altro modo).

4. Nella stessa pagina, sotto **Implicit grant and hybrid flows** (*Concessione implicita e flussi
   ibridi*): lascia **entrambe le caselle deselezionate**.

### Dare alla SPA il permesso di chiamare l'API

1. Nell'app **SPA** → **API permissions** (*Autorizzazioni API*) → **+ Add a permission**
   (*+ Aggiungi un'autorizzazione*).
2. Scheda **My APIs** (*Le mie API*) → seleziona l'app `<Progetto>-API`.
3. **Delegated permissions** (*Autorizzazioni delegate*) → spunta `access_as_user` → **Add
   permissions** (*Aggiungi autorizzazioni*).
4. Clicca **Grant admin consent for &lt;tenant&gt;** (*Concedi consenso amministratore per
   &lt;tenant&gt;*) e conferma.

Senza il consenso amministratore ogni utente dovrà accettare i permessi al primo accesso; con il
consenso, la cosa è trasparente. Se lo stato resta *Not granted* (*Non concesso*), l'accesso
fallisce con `AADSTS65001`.

## 3. Configurare il progetto

### Backend

```json
// appsettings.local.json (sviluppo) — in produzione: variabili d'ambiente
{
  "Auth": {
    "Msal": {
      "TenantId": "<ID directory (tenant)>",
      "ClientId": "<ClientId dell'app API>"
    }
  }
}
```

> `Auth:Msal:ClientId` è il ClientId dell'**API**, non della SPA. È il valore che il backend confronta
> con il claim `aud` del token in arrivo (accettandolo sia nudo sia nella forma `api://{clientId}`).

### Frontend

```env
# apps/frontend/.env.local
VITE_API_BASE_URL=http://localhost:5080     # la porta scelta come api_port
VITE_AUTH_STRATEGY=msal
VITE_MSAL_CLIENT_ID=<ClientId dell'app SPA>
VITE_MSAL_TENANT_ID=<ID directory (tenant)>
VITE_MSAL_API_CLIENT_ID=<ClientId dell'app API>   # vuoto se SPA e API sono la stessa app
```

### La corrispondenza, in un colpo d'occhio

| Azure | Backend | Frontend |
|---|---|---|
| **Directory (tenant) ID** (*ID directory (tenant)*) | `Auth:Msal:TenantId` | `VITE_MSAL_TENANT_ID` |
| **Application (client) ID** dell'app **API** | `Auth:Msal:ClientId` | `VITE_MSAL_API_CLIENT_ID` |
| **Application (client) ID** dell'app **SPA** | — | `VITE_MSAL_CLIENT_ID` |

L'authority non si configura: il frontend la costruisce da sé come
`https://login.microsoftonline.com/{VITE_MSAL_TENANT_ID}`.

## 4. Creare l'utente nell'applicazione

Azure verifica **l'identità**; i **permessi** vengono dal database locale. Quindi:

> L'utente deve esistere **anche** nell'applicazione, con `Username` uguale all'identità
> dell'account Azure — il claim `preferred_username`, di norma l'UPN, cioè la email aziendale — e
> deve avere ruoli assegnati, direttamente o tramite un gruppo.

Se manca, l'accesso fallisce con *"Nessun utente locale con username …"*. Se c'è ma non ha ruoli,
l'accesso riesce e l'utente non vede nulla.

> Attenzione al campo giusto: la corrispondenza si fa su **`Username`**, non sul campo `Email`, che
> nell'applicazione è un dato anagrafico opzionale. Vedi
> [JWT, MSAL e Windows](autenticazione.md#l-identita-di-login-username).

## 5. Verificare

```bash
pnpm serve:backend      # sulla porta scelta alla generazione (api_port)
pnpm serve:frontend     # sulla porta scelta alla generazione (frontend_port)
```

Nella pagina di accesso deve comparire il pulsante **Accedi con Microsoft**. Dopo il login, in
DevTools → Network:

```
POST /api/auth/msal-login      { "azureToken": "eyJ…" }
  → 200 OK  { "accessToken": "eyJ…", "permissions": [ … ] }

GET  /api/…                    Authorization: Bearer eyJ…   ← da qui in poi, il JWT interno
```

Se qualcosa non torna, incolla il token Azure su [jwt.ms](https://jwt.ms) e guarda il claim `aud`:
deve essere il ClientId dell'**API** (o `api://{clientId}`). È la diagnosi più rapida.

### Checklist

- [ ] App **API** registrata, con `api://{clientId}` e lo scope `access_as_user`
- [ ] App **API**: `requestedAccessTokenVersion` = `2` nel Manifest (token v2.0)
- [ ] App **SPA** registrata, piattaforma **Single-page application**, redirect URI identico a quello reale
- [ ] La SPA ha il permesso delegato `access_as_user` sull'API, **con Grant admin consent** (*consenso amministratore*)
- [ ] Backend: `Auth:Msal:TenantId` e `Auth:Msal:ClientId` (= app API)
- [ ] Frontend: `VITE_AUTH_STRATEGY=msal`, `VITE_MSAL_CLIENT_ID` (= app SPA), `VITE_MSAL_TENANT_ID`,
      `VITE_MSAL_API_CLIENT_ID` (= app API)
- [ ] L'utente Azure esiste anche nell'applicazione, con `Username` = la sua email aziendale, e ha dei ruoli

## Produzione

Aggiungi l'URI di produzione fra i redirect URI della SPA (**in HTTPS**: obbligatorio).

Meglio ancora: **app registration separate per ambiente** — `<Progetto>-SPA-Dev` e
`<Progetto>-SPA-Prod` — così gli ambienti restano isolati e possono avere policy diverse.

I valori non vanno nei file versionati: sul backend usa le variabili d'ambiente
(`Auth__Msal__TenantId`, `Auth__Msal__ClientId`, `Auth__Jwt__Secret`), sul frontend le variabili di
build (le `VITE_*` sono iniettate **al momento del build**, non a runtime: cambiarle richiede un
nuovo build). Vedi [Deploy su Render](../deploy/render.md).

## Domande ricorrenti

**Serve un client secret?**
No, e non va creato. La SPA è un *public client*: non può custodire segreti, e infatti usa
Authorization Code con PKCE, che non ne richiede. Nemmeno l'API ne ha bisogno, perché non chiama
Azure: si limita a validare i token con le chiavi pubbliche.

**Serve la sezione "Certificates & secrets" (*Certificati e segreti*)?**
No, per lo stesso motivo.

**Posso limitare chi accede?**
Sì, in due punti. Su Azure: **Enterprise applications** (*Applicazioni aziendali*) → **Properties**
(*Proprietà*) → **Assignment required?** (*Assegnazione utenti obbligatoria*) → **Yes**, poi in
**Users and groups** (*Utenti e gruppi*) assegna solo le persone o i gruppi desiderati.
Nell'applicazione: chi non ha un utente locale non entra comunque.

**Posso usare account Microsoft personali (outlook.com)?**
Solo se in **Supported account types** (*Tipi di account supportati*) hai scelto un tipo di account
che li include. Per l'uso aziendale, *single tenant* è la scelta corretta.

## Errori comuni

| Errore | Causa | Rimedio |
|---|---|---|
| `redirect_uri_mismatch` · `AADSTS50011` | L'URI nel browser non è identico a quello registrato | Confronta protocollo, porta, path, trailing slash |
| `AADSTS700054` | Piattaforma **Web** invece di **Single-page application** | Rimuovi la piattaforma Web, aggiungi la SPA |
| `AADSTS65001` | Manca il consenso amministratore | **API permissions** (*Autorizzazioni API*) → **Grant admin consent** (*Concedi consenso amministratore*) |
| `IDX10205: Issuer validation failed` (issuer `sts.windows.net/…`) | L'app **API** emette token v1.0: `requestedAccessTokenVersion` è `null` | Manifest dell'app API → `requestedAccessTokenVersion: 2`, poi logout + svuota `localStorage` |
| `IDX10214: Audience validation failed` | Il token è destinato alla SPA, non all'API | Imposta `VITE_MSAL_API_CLIENT_ID` e verifica che lo scope richiesto sia `api://{API}/access_as_user` |
| *Nessun utente locale con username …* | L'utente non esiste nell'applicazione | Crealo con `Username` = la email aziendale |
| Accede, ma non vede nulla | L'utente locale non ha ruoli | Assegnagli ruoli, direttamente o via gruppo |

## Riferimenti

| Risorsa | Link |
|---|---|
| Portale Azure | <https://portal.azure.com> |
| Documentazione Entra ID | <https://learn.microsoft.com/it-it/entra/identity/> |
| Authorization Code con PKCE | <https://learn.microsoft.com/it-it/entra/identity-platform/v2-oauth2-auth-code-flow> |
| Ispezionare un token Azure | <https://jwt.ms> |
