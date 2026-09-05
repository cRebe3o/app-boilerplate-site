# App registration su Azure

Guida operativa per far funzionare l'accesso con account Microsoft. Serve una sola volta, per
ambiente. Il funzionamento a valle è descritto in [JWT e MSAL](autenticazione.md).

> **Prerequisito**: un account Azure con il ruolo *Amministratore globale* o *Amministratore
> applicazioni*. Il portale è su [portal.azure.com](https://portal.azure.com); il servizio si chiama
> **Microsoft Entra ID** (l'ex Azure Active Directory: stessa cosa, nome nuovo).

## Il modello: due app, non una

È il punto in cui ci si perde, quindi conviene chiarirlo subito. In produzione DelVoltone usa **due
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

1. **Microsoft Entra ID** → **Registrazioni app** → **+ Nuova registrazione**.
2. Nome: `DelVoltone-API` (o come preferisci).
3. Tipi di account supportati: **Solo questa directory organizzativa** (single tenant) — è la scelta
   giusta se tutti gli utenti appartengono alla stessa organizzazione.
4. Nessun URI di reindirizzamento: l'API non ne ha bisogno.
5. **Registra**.

Dalla pagina **Panoramica** annota **ID applicazione (client)** e **ID directory (tenant)**.

### Esporre l'API e lo scope

1. **Esponi un'API** → accanto a *URI ID applicazione* clicca **Aggiungi** e accetta la proposta di
   Azure (`api://{clientId}`) → **Salva**.
2. **+ Aggiungi un ambito**:

   | Campo | Valore |
   |---|---|
   | Nome ambito | `access_as_user` |
   | Chi può consentire | Amministratori e utenti |
   | Nome visualizzato | Accedi a DelVoltone come utente |
   | Descrizione | Consente all'app di accedere a DelVoltone per conto dell'utente connesso |
   | Stato | Abilitato |

Lo scope completo diventa `api://{API_CLIENT_ID}/access_as_user`: è quello che la SPA chiederà.

## 2. Registrare l'app della SPA

1. **+ Nuova registrazione**, nome `DelVoltone-SPA`, single tenant.
2. **Autenticazione** → **+ Aggiungi una piattaforma** → **Applicazione a pagina singola (SPA)**.

   > Deve essere **SPA**, non *Web*. La piattaforma Web usa il flusso implicito e produce l'errore
   > `AADSTS700054`. La SPA usa Authorization Code con PKCE, che è più sicuro e non richiede alcun
   > client secret.

3. URI di reindirizzamento: **deve coincidere esattamente** con `window.location.origin + '/login'`.

   ```
   http://localhost:5173/login          sviluppo
   https://<frontend>.onrender.com/login   produzione
   ```

   Attenzione a protocollo, porta, path e trailing slash: ogni differenza produce
   `redirect_uri_mismatch` (o `AADSTS50011`, che è la stessa cosa detta in altro modo).

4. Nella stessa pagina, sotto *Concessione implicita e flussi ibridi*: lascia **entrambe le caselle
   deselezionate**.

### Dare alla SPA il permesso di chiamare l'API

1. Nell'app **SPA** → **Autorizzazioni API** → **+ Aggiungi un'autorizzazione**.
2. Scheda **Le mie API** → seleziona `DelVoltone-API`.
3. **Autorizzazioni delegate** → spunta `access_as_user` → **Aggiungi autorizzazioni**.
4. Clicca **Concedi consenso amministratore** e conferma.

Senza il consenso amministratore ogni utente dovrà accettare i permessi al primo accesso; con il
consenso, la cosa è trasparente. Se lo stato resta *Non concesso*, l'accesso fallisce con
`AADSTS65001`.

## 3. Configurare DelVoltone

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
VITE_API_BASE_URL=http://localhost:5000
VITE_AUTH_STRATEGY=msal
VITE_MSAL_CLIENT_ID=<ClientId dell'app SPA>
VITE_MSAL_TENANT_ID=<ID directory (tenant)>
VITE_MSAL_API_CLIENT_ID=<ClientId dell'app API>   # vuoto se SPA e API sono la stessa app
```

### La corrispondenza, in un colpo d'occhio

| Azure | Backend | Frontend |
|---|---|---|
| ID directory (tenant) | `Auth:Msal:TenantId` | `VITE_MSAL_TENANT_ID` |
| ClientId dell'app **API** | `Auth:Msal:ClientId` | `VITE_MSAL_API_CLIENT_ID` |
| ClientId dell'app **SPA** | — | `VITE_MSAL_CLIENT_ID` |

L'authority non si configura: il frontend la costruisce da sé come
`https://login.microsoftonline.com/{VITE_MSAL_TENANT_ID}`.

## 4. Creare l'utente in DelVoltone

Azure verifica **l'identità**; i **permessi** vengono dal database locale. Quindi:

> L'utente deve esistere **anche** in DelVoltone, con la **stessa email** dell'account Azure
> (quella del claim `preferred_username`, di norma l'UPN), e deve avere ruoli assegnati —
> direttamente o tramite un gruppo.

Se manca, l'accesso fallisce con *"Nessun utente locale con email …"*. Se c'è ma non ha ruoli,
l'accesso riesce e l'utente non vede nulla.

## 5. Verificare

```bash
pnpm serve:backend      # http://localhost:5000
pnpm serve:frontend     # http://localhost:5173
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
- [ ] App **SPA** registrata, piattaforma **SPA**, redirect URI identico a quello reale
- [ ] La SPA ha il permesso delegato `access_as_user` sull'API, **con consenso amministratore**
- [ ] Backend: `Auth:Msal:TenantId` e `Auth:Msal:ClientId` (= app API)
- [ ] Frontend: `VITE_AUTH_STRATEGY=msal`, `VITE_MSAL_CLIENT_ID` (= app SPA), `VITE_MSAL_TENANT_ID`,
      `VITE_MSAL_API_CLIENT_ID` (= app API)
- [ ] L'utente Azure esiste anche in DelVoltone, con la stessa email, e ha dei ruoli

## Produzione

Aggiungi l'URI di produzione fra i redirect URI della SPA (**in HTTPS**: obbligatorio).

Meglio ancora: **app registration separate per ambiente** — `DelVoltone-SPA-Dev` e
`DelVoltone-SPA-Prod` — così gli ambienti restano isolati e possono avere policy diverse.

I valori non vanno nei file versionati: sul backend usa le variabili d'ambiente
(`Auth__Msal__TenantId`, `Auth__Msal__ClientId`, `Auth__Jwt__Secret`), sul frontend le variabili di
build (le `VITE_*` sono iniettate **al momento del build**, non a runtime: cambiarle richiede un
nuovo build). Vedi [Deploy su Render](../deploy/render.md).

## Domande ricorrenti

**Serve un client secret?**
No, e non va creato. La SPA è un *public client*: non può custodire segreti, e infatti usa
Authorization Code con PKCE, che non ne richiede. Nemmeno l'API ne ha bisogno, perché non chiama
Azure: si limita a validare i token con le chiavi pubbliche.

**Serve la sezione "Certificati e segreti"?**
No, per lo stesso motivo.

**Posso limitare chi accede?**
Sì, in due punti. Su Azure: *Applicazioni aziendali* → *Assegnazione utenti obbligatoria* → assegna
solo le persone o i gruppi desiderati. Su DelVoltone: chi non ha un utente locale non entra comunque.

**Posso usare account Microsoft personali (outlook.com)?**
Solo se nella registrazione hai scelto un tipo di account che li include. Per l'uso aziendale,
*single tenant* è la scelta corretta.

## Errori comuni

| Errore | Causa | Rimedio |
|---|---|---|
| `redirect_uri_mismatch` · `AADSTS50011` | L'URI nel browser non è identico a quello registrato | Confronta protocollo, porta, path, trailing slash |
| `AADSTS700054` | Piattaforma **Web** invece di **SPA** | Rimuovi la piattaforma Web, aggiungi la SPA |
| `AADSTS65001` | Manca il consenso amministratore | *Autorizzazioni API* → **Concedi consenso amministratore** |
| `IDX10214: Audience validation failed` | Il token è destinato alla SPA, non all'API | Imposta `VITE_MSAL_API_CLIENT_ID` e verifica che lo scope richiesto sia `api://{API}/access_as_user` |
| *Nessun utente locale con email …* | L'utente non esiste in DelVoltone | Crealo con la stessa email |
| Accede, ma non vede nulla | L'utente locale non ha ruoli | Assegnagli ruoli, direttamente o via gruppo |

## Riferimenti

| Risorsa | Link |
|---|---|
| Portale Azure | <https://portal.azure.com> |
| Documentazione Entra ID | <https://learn.microsoft.com/it-it/entra/identity/> |
| Authorization Code con PKCE | <https://learn.microsoft.com/it-it/entra/identity-platform/v2-oauth2-auth-code-flow> |
| Ispezionare un token Azure | <https://jwt.ms> |
