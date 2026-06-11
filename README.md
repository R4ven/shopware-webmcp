# shopware-webmcp

Shopware 6 Storefront-Plugin, das den Shop über **WebMCP**
(`navigator.modelContext`) für KI-Agenten bedienbar macht. Sobald das Plugin
aktiv ist, findet jeder Browser-Agent auf jeder Storefront-Seite eine fertige
MCP-Schnittstelle vor – ohne dass pro Shop oder pro Agent etwas programmiert
werden muss.

## Was ist WebMCP?

WebMCP ist der Vorschlag, MCP-Tools (Model Context Protocol) direkt im Browser
über `navigator.modelContext` bereitzustellen. Eine Website „deklariert" damit
Tools, die ein im Browser laufender KI-Agent (Extension, Agent-Browser, …)
aufrufen kann. Dieses Plugin erzeugt solche Tools und backt sie mit der Shopware
**Store-API**.

## Schema-getrieben statt hardcodiert

Die Tools sind **nicht** fest im Code hinterlegt. Stattdessen liest das Plugin
beim Laden das Live-Schema der Store-API
(`GET /store-api/_info/openapi3.json`) und generiert daraus automatisch ein
MCP-Tool pro Operation:

- **Name** ← `operationId`, **Beschreibung** ← `summary`/`description`,
  **Eingabeschema** ← Pfad-/Query-Parameter und Request-Body der Operation.
- **Alle Routen, die der Shop real anbietet, werden erfasst** – auch die
  installierter Plugins. Z. B. **Shopware B2B Commerce** (Quotes, Employees,
  Organisationseinheiten) erscheint automatisch, sobald es installiert ist; es
  müssen keine Routen geraten oder gepflegt werden.

Welche Operationen tatsächlich als Tool an den Agenten gehen, steuert die
**Admin-Konfiguration** pro Sales-Channel (siehe unten).

Aufrufe laufen über das `sw-context-token` der laufenden Session – Cart-/Account-
Operationen wirken also auf **denselben Kontext** wie der Nutzer im Browser.

## Admin-Konfiguration

Im Shopware-Admin unter *Einstellungen → System → Plugins → WebMCP* (pro
Sales-Channel):

| Einstellung | Bedeutung | Default |
| --- | --- | --- |
| **Tools aus dem Store-API-Schema generieren** | Schema-Generierung an/aus | an |
| **Allowlist** | Nur passende Operationen anbieten (ein Muster/Zeile; leer = alle) | leer |
| **Denylist** | Passende Operationen ausschließen (nach Allowlist) | `*login*`, `*logout*`, `*register*`, `*password*`, `*recovery*`, `*newsletter*` |
| **Verändernde Methoden einbeziehen** | PUT/PATCH/DELETE zulassen (sonst nur GET/POST) | aus |
| **Maximale Anzahl Tools** | Sicherheitslimit | 100 |

**Muster:** Abgleich (ohne Groß-/Kleinschreibung) gegen `operationId`, Pfad und
`METHODE pfad`. `*` ist Platzhalter; ein Muster ohne `*` wirkt als
Teilstring-Treffer. Beispiele:

- B2B-Commerce-Tools freischalten: Allowlist `*quote*`, `*employee*`,
  `*organization*`
- Nur Lesezugriffe auf Produkte/Kategorien: Allowlist `/product*`, `/category*`,
  `/search`
- Account-Funktionen ausschließen: Denylist `*account*`, `*customer*`

> Hinweis: Die meisten Store-API-**Lesezugriffe** nutzen `POST` (z. B. `/search`,
> `/product-listing`). Der Schalter „Verändernde Methoden" filtert daher nur
> `PUT`/`PATCH`/`DELETE`; für eine feinere Eingrenzung die Deny-/Allowlist nutzen.

## Funktionsweise

1. `Resources/views/storefront/base.html.twig` erweitert das Storefront-Base-Template
   und injiziert am Body-Ende die Laufzeit-Konfiguration (`window.swagWebMcpConfig`:
   Store-API-Zugang + die Admin-Einstellungen via Twig-`config()`) sowie das Skript.
2. `Resources/public/swag-web-mcp.js` lädt das OpenAPI-Schema, generiert/filtert
   die Tools und publiziert sie über `navigator.modelContext.provideContext(...)`.
   Ohne native WebMCP-Unterstützung wird ein leichtes Polyfill installiert, sodass
   die Tools unter `navigator.modelContext` und `window.SwagWebMcp` auffindbar sind.

Es ist **kein Storefront-Webpack-Build nötig** – das Skript wird als statisches
Asset ausgeliefert (`assets:install` reicht, das macht Shopware beim Aktivieren
automatisch).

## Installation

Plugin nach `custom/plugins/SwagWebMcp` legen, dann:

```bash
bin/console plugin:refresh
bin/console plugin:install --activate SwagWebMcp
bin/console assets:install
bin/console cache:clear
```

## Schnelltest

Storefront öffnen, Browser-Konsole prüfen – dort erscheint z. B.:

```
[WebMCP] 42 von 180 Store-API-Operationen als Tools registriert.
[WebMCP] 42 Tools aktiv.
```

Direkt in der Konsole testen:

```js
// Tools auflisten
window.SwagWebMcp.getTools();

// Ein Tool manuell aufrufen (Argumente = Pfad-/Query-Parameter + ggf. body)
await window.SwagWebMcp.callTool('readProductListing', { body: { limit: 5 } });
```

Auf das `webmcp:ready`-Event hören:

```js
window.addEventListener('webmcp:ready', (e) => console.log('Tools:', e.detail.tools));
```

## Argument-Konvention der generierten Tools

Für jede Operation gilt:

- **Pfad-Parameter** (`/product/{productId}`) und **Query-Parameter** liegen als
  Felder oben im Eingabeobjekt (`{ productId: "..." }`).
- Ein vorhandener **Request-Body** liegt unter `body` (`{ body: { ... } }`).

Das Tool ersetzt Pfad-Parameter, hängt Query-Parameter an und sendet `body` als
JSON.

## Erweiterung durch andere Plugins

Die Schema-Generierung deckt die Standard-Operationen ab. Für **zusammengesetzte
Abläufe** oder Tools mit aufgeräumter Ein-/Ausgabe (die es im Schema nicht als
einzelne Operation gibt) bleibt die Erweiterungs-API nutzbar – ladereihenfolge-
unabhängig über eine Command-Queue:

```js
(window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {
    mcp.registerTool({
        name: 'quick_buy',
        description: 'Sucht ein Produkt und legt den besten Treffer in den Warenkorb.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        isAvailable: function () { return true; },            // optionales Gate
        run: function (args) { /* ... mehrere storeApi-Aufrufe ... */ }
    });
});
```

Die `mcp`-API:

| Methode | Zweck |
| --- | --- |
| `registerTool(spec)` | Tool hinzufügen (ersetzt gleichnamiges); gibt Unregister-Funktion zurück |
| `unregisterTool(name)` | Tool entfernen — **auch generierte Schema-Tools** |
| `getTools()` | Namen aller registrierten Tools |
| `callTool(name, args)` | Tool manuell ausführen |
| `refresh()` | `isAvailable`-Gates neu auswerten und neu publizieren |
| `storeApi(method, path, body)` | Store-API-Aufruf mit identischer Auth-/Context-Token-Logik |
| `config` | `window.swagWebMcpConfig` |

**Bedingte Verfügbarkeit:** Mit `isAvailable()` (sync oder Promise) lassen sich
Tools dynamisch ein-/ausblenden (z. B. abhängig vom Login).

Server-seitig kann ein anderes Plugin den Twig-Block `swag_web_mcp_config_extend`
überschreiben, um zusätzliche Felder an `window.swagWebMcpConfig` zu hängen.

Vollständiges Beispiel: [`examples/custom-tool.example.js`](examples/custom-tool.example.js).

## Kompatibilität

- Shopware 6.5 / 6.6 / 6.7
- Greift ausschließlich auf die Store-API des jeweiligen Sales-Channels zu.
- B2B-Commerce-Operationen erscheinen automatisch, sobald das Commercial-Plugin
  installiert ist und sie im Schema enthalten sind.

## Sicherheitshinweis

Generierte Tools spiegeln die Store-API 1:1 wider. Da ein Browser-Agent sie im
Namen der laufenden Session aufruft, sollte die Deny-/Allowlist sensible
Operationen (Login, Registrierung, Passwort/Recovery, Newsletter, ggf.
Account-/Adressänderungen) bewusst ausschließen. Die Defaults schließen die
gängigsten davon bereits aus.

## Lizenz

MIT
