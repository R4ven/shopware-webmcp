# shopware-webmcp

Shopware 6 Storefront-Plugin, das den Shop über **WebMCP**
(`navigator.modelContext`) für KI-Agenten bedienbar macht. Sobald das Plugin
aktiv ist, findet jeder Browser-Agent auf jeder Storefront-Seite eine fertige
MCP-Schnittstelle vor – ohne dass pro Shop oder pro Agent etwas konfiguriert
werden muss.

## Was ist WebMCP?

WebMCP ist der Vorschlag, MCP-Tools (Model Context Protocol) direkt im Browser
über `navigator.modelContext` bereitzustellen. Eine Website „deklariert" damit
Tools, die ein im Browser laufender KI-Agent (Extension, Agent-Browser, …)
aufrufen kann. Dieses Plugin registriert solche Tools für die typischen
Shop-Aktionen und backt sie mit der Shopware **Store-API**.

## Bereitgestellte Tools

| Tool | Zweck |
| --- | --- |
| `search_products` | Produkte per Suchbegriff finden (Name, Preis, ID) |
| `get_product` | Produktdetails per Produkt-ID |
| `list_categories` | Hauptnavigation / Kategorien auflisten |
| `get_cart` | Aktuellen Warenkorb anzeigen |
| `add_to_cart` | Produkt in den Warenkorb legen |
| `update_cart_item` | Menge einer Warenkorb-Position ändern |
| `remove_from_cart` | Position aus dem Warenkorb entfernen |

Alle Cart-Tools arbeiten über das `sw-context-token` der laufenden Session auf
**demselben Warenkorb** wie der Nutzer im Browser.

## Funktionsweise

1. `Resources/views/storefront/base.html.twig` erweitert das Storefront-Base-Template
   und injiziert am Body-Ende die Laufzeit-Konfiguration
   (`window.swagWebMcpConfig`: Store-API-URL, Sales-Channel-Access-Key,
   Context-Token) sowie das WebMCP-Skript.
2. `Resources/public/swag-web-mcp.js` registriert daraus die Tools über
   `navigator.modelContext.provideContext(...)`. Unterstützt der Browser die API
   noch nicht nativ, wird ein leichtes Polyfill installiert, damit die Tools
   trotzdem unter `navigator.modelContext` und `window.swagWebMcp` auffindbar
   sind.

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

Per Composer (sofern als Paket eingebunden):

```bash
composer require swag/web-mcp
bin/console plugin:install --activate SwagWebMcp
```

## Schnelltest

Storefront öffnen, Browser-Konsole prüfen – dort erscheint:

```
[WebMCP] 7 Tools aktiv: search_products, get_product, ...
```

Direkt in der Konsole testen:

```js
// Tools auflisten
window.SwagWebMcp.getTools();

// Tool manuell aufrufen
await window.SwagWebMcp.callTool('search_products', { query: 'Notebook', limit: 5 });
await window.SwagWebMcp.callTool('add_to_cart', { productId: '<id>', quantity: 1 });
await window.SwagWebMcp.callTool('get_cart', {});
```

Auf das `webmcp:ready`-Event hören:

```js
window.addEventListener('webmcp:ready', (e) => console.log('Tools:', e.detail.tools));
```

## Erweiterung durch andere Plugins (B2B etc.)

Das Funktionsset unterscheidet sich je nach Kunde — z. B. Shopware **B2B
Commerce** mit Employees, bei denen je nach Rolle nicht alle Funktionen
verfügbar sind. Deshalb ist die MCP-Schnittstelle **erweiterbar**: Andere
Plugins steuern eigene Tools bei, ohne dieses Plugin zu ändern.

### Client-seitig: Tools registrieren (Command-Queue)

Ladereihenfolge-unabhängig über `window.SwagWebMcp.push(...)`:

```js
(window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {
    mcp.registerTool({
        name: 'b2b_request_quote',
        description: 'Wandelt den Warenkorb in eine Angebotsanfrage um.',
        inputSchema: { type: 'object', properties: { comment: { type: 'string' } } },
        // Optionales Gate: Tool erscheint nur, wenn verfügbar/berechtigt.
        isAvailable: function () { return mcp.config.b2b && mcp.config.b2b.enabled; },
        run: function (args) { return mcp.storeApi('POST', '/quote/request', args); }
    });
});
```

Die `mcp`-API bietet:

| Methode | Zweck |
| --- | --- |
| `registerTool(spec)` | Tool hinzufügen (ersetzt gleichnamiges); gibt eine Unregister-Funktion zurück |
| `unregisterTool(name)` | Tool entfernen — **auch Core-Tools** (z. B. `add_to_cart` in reiner B2B-Storefront) |
| `getTools()` | Namen aller registrierten Tools |
| `callTool(name, args)` | Tool manuell ausführen |
| `refresh()` | `isAvailable`-Gates neu auswerten und neu publizieren (z. B. nach Login) |
| `storeApi(method, path, body)` | Store-API-Aufruf mit identischer Auth-/Context-Token-Logik |
| `config` | `window.swagWebMcpConfig` inkl. der von Plugins ergänzten Felder |

**Bedingte Verfügbarkeit:** Mit `isAvailable()` (sync oder Promise) blendest du
Tools je nach B2B-Rolle/Berechtigung ein oder aus. Nur verfügbare Tools werden
an den Agenten publiziert.

Ein vollständiges, kopierbares Beispiel liegt in
[`examples/b2b-extension.example.js`](examples/b2b-extension.example.js).

### Server-seitig: B2B-Kontext in die Config geben

Ein anderes Plugin kann den Twig-Block `swag_web_mcp_config_extend` überschreiben
und so z. B. Berechtigungen mitgeben, ohne das Base-Template zu ersetzen:

```twig
{% sw_extends '@Storefront/storefront/base.html.twig' %}
{% block swag_web_mcp_config_extend %}
    window.swagWebMcpConfig.b2b = {
        enabled: {{ b2bActive ? 'true' : 'false' }},
        permissions: {{ employeePermissions|json_encode|raw }}
    };
{% endblock %}
```

### Eigene Core-Tools anpassen

Die mitgelieferten Tools stehen in `src/Resources/public/swag-web-mcp.js` im
`coreTools`-Array und durchlaufen dieselbe Registry — sie lassen sich also von
Erweiterungen per `unregisterTool(name)` entfernen oder per gleichnamigem
`registerTool(...)` überschreiben.

## Kompatibilität

- Shopware 6.5 / 6.6 / 6.7
- Tools nutzen ausschließlich öffentliche Store-API-Routen.

## Lizenz

MIT
