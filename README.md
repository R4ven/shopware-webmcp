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
[WebMCP] 7 Tools für Agenten registriert: search_products, get_product, ...
```

Direkt in der Konsole testen:

```js
// Tools auflisten
navigator.modelContext._tools // (Polyfill) bzw. window.swagWebMcp.tools

// Tool manuell aufrufen
await window.swagWebMcp.callTool('search_products', { query: 'Notebook', limit: 5 });
await window.swagWebMcp.callTool('add_to_cart', { productId: '<id>', quantity: 1 });
await window.swagWebMcp.callTool('get_cart', {});
```

Auf das `webmcp:ready`-Event hören:

```js
window.addEventListener('webmcp:ready', (e) => console.log('Tools:', e.detail.tools));
```

## Anpassen / Erweitern

Weitere Tools fügst du in `src/Resources/public/swag-web-mcp.js` im
`tools`-Array hinzu (jeweils `name`, `description`, `inputSchema` und eine
`run(args)`-Funktion, die ein Promise mit dem Ergebnis liefert). Die WebMCP-
Verdrahtung und Fehlerbehandlung passieren generisch darum herum.

## Kompatibilität

- Shopware 6.5 / 6.6 / 6.7
- Tools nutzen ausschließlich öffentliche Store-API-Routen.

## Lizenz

MIT
