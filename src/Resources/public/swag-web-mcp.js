/**
 * Shopware Storefront WebMCP Bootstrap + Erweiterungs-API
 * -------------------------------------------------------
 * Registriert beim Laden der Seite eine Reihe von MCP-Tools ueber die
 * WebMCP-API (navigator.modelContext), sodass jeder Browser-Agent im Shop
 * sofort eine fertige Schnittstelle zum Suchen, Stoebern und Bestellen hat.
 *
 * ERWEITERBARKEIT
 * ---------------
 * Andere Plugins (z. B. B2B-Commerce) koennen eigene Tools beisteuern, ohne
 * diese Datei zu aendern. Ueber eine Command-Queue ist das ladereihenfolge-
 * unabhaengig:
 *
 *     (window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {
 *         mcp.registerTool({
 *             name: 'b2b_request_quote',
 *             description: '...',
 *             inputSchema: { type: 'object', properties: { ... } },
 *             // Optionales Gate: Tool erscheint nur, wenn verfuegbar/berechtigt.
 *             isAvailable: function () { return mcp.config.b2b === true; },
 *             // Bekommt Argumente, liefert ein Promise mit dem Ergebnis.
 *             run: function (args) { return mcp.storeApi('POST', '/...', args); }
 *         });
 *     });
 *
 * mcp stellt dabei bereit:
 *   - registerTool(spec)         Tool hinzufuegen (ersetzt gleichnamiges Tool)
 *   - unregisterTool(name)       Tool entfernen (auch Core-Tools)
 *   - getTools()                 Namen aller registrierten Tools
 *   - callTool(name, args)       Tool manuell ausfuehren
 *   - refresh()                  Verfuegbarkeit neu auswerten + neu publizieren
 *   - storeApi(method, path, body)  Store-API-Aufruf mit Auth/Context-Token
 *   - config                     window.swagWebMcpConfig (inkl. Plugin-Felder)
 *
 * Falls der Browser/Agent die WebMCP-API noch nicht nativ unterstuetzt, wird
 * ein leichtgewichtiges Polyfill installiert, das die Tools trotzdem unter
 * navigator.modelContext und window.SwagWebMcp auffindbar macht.
 */
(function () {
    'use strict';

    var config = window.swagWebMcpConfig || {};

    if (!config.storeApiUrl || !config.accessKey) {
        console.warn('[WebMCP] Fehlende Konfiguration (storeApiUrl/accessKey) – Tools werden nicht registriert.');
        return;
    }

    // Context-Token im Speicher halten, damit Warenkorb-Aenderungen konsistent bleiben.
    var contextToken = config.contextToken || null;

    /**
     * Schlanker Fetch-Wrapper fuer die Store-API. Auch fuer Erweiterungs-Tools
     * nutzbar (mcp.storeApi), damit diese dieselbe Auth/Context-Logik bekommen.
     */
    function storeApi(method, path, body) {
        var headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'sw-access-key': config.accessKey
        };
        if (contextToken) {
            headers['sw-context-token'] = contextToken;
        }

        var options = {
            method: method,
            headers: headers,
            credentials: 'same-origin'
        };
        if (body !== undefined && body !== null) {
            options.body = JSON.stringify(body);
        }

        return fetch(config.storeApiUrl + path, options).then(function (response) {
            var token = response.headers.get('sw-context-token');
            if (token) {
                contextToken = token;
            }

            return response.text().then(function (text) {
                var data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        data = text;
                    }
                }
                if (!response.ok) {
                    var message = 'Store-API Fehler ' + response.status;
                    if (data && data.errors && data.errors.length) {
                        message += ': ' + data.errors.map(function (err) {
                            return err.detail || err.title;
                        }).join('; ');
                    }
                    throw new Error(message);
                }
                return data;
            });
        });
    }

    // --- Mapper / Helfer -----------------------------------------------------

    function formatMoney(amount) {
        if (typeof amount !== 'number') {
            return String(amount);
        }
        var currency = config.currencyCode || '';
        return amount.toFixed(2) + (currency ? ' ' + currency : '');
    }

    function productPrice(product) {
        if (!product) {
            return null;
        }
        if (product.calculatedPrice && typeof product.calculatedPrice.unitPrice === 'number') {
            return product.calculatedPrice.unitPrice;
        }
        if (product.calculatedCheapestPrice && typeof product.calculatedCheapestPrice.unitPrice === 'number') {
            return product.calculatedCheapestPrice.unitPrice;
        }
        return null;
    }

    function mapProduct(product) {
        if (!product) {
            return null;
        }
        var price = productPrice(product);
        return {
            id: product.id,
            productNumber: product.productNumber,
            name: (product.translated && product.translated.name) || product.name,
            description: (product.translated && product.translated.description) || product.description || null,
            price: price,
            priceFormatted: price !== null ? formatMoney(price) : null,
            available: product.available !== false,
            stock: typeof product.availableStock === 'number' ? product.availableStock : null
        };
    }

    function mapCart(cart) {
        if (!cart) {
            return null;
        }
        var items = (cart.lineItems || []).map(function (item) {
            return {
                lineItemId: item.id,
                referencedId: item.referencedId,
                label: item.label,
                quantity: item.quantity,
                unitPrice: item.price ? item.price.unitPrice : null,
                totalPrice: item.price ? item.price.totalPrice : null,
                totalPriceFormatted: item.price ? formatMoney(item.price.totalPrice) : null
            };
        });
        var total = cart.price ? cart.price.totalPrice : null;
        return {
            token: cart.token,
            itemCount: items.length,
            lineItems: items,
            total: total,
            totalFormatted: total !== null ? formatMoney(total) : null
        };
    }

    // --- Standard-Tools (Core) ----------------------------------------------
    // Diese werden ueber dieselbe Registry wie Erweiterungs-Tools eingespielt,
    // koennen also von Plugins per unregisterTool(name) auch entfernt werden.

    var coreTools = [
        {
            name: 'search_products',
            description: 'Sucht Produkte im Shop anhand eines Suchbegriffs und liefert Name, Preis und Produkt-ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Der Suchbegriff, z. B. "Sommerjacke".' },
                    limit: { type: 'integer', description: 'Maximale Trefferzahl (Standard 10).', minimum: 1, maximum: 50 }
                },
                required: ['query']
            },
            run: function (args) {
                return storeApi('POST', '/search', {
                    search: args.query,
                    limit: args.limit || 10
                }).then(function (result) {
                    var elements = (result && result.elements) || [];
                    return {
                        total: result ? result.total : elements.length,
                        products: elements.map(mapProduct)
                    };
                });
            }
        },
        {
            name: 'get_product',
            description: 'Liefert Detailinformationen zu einem Produkt anhand seiner Produkt-ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    productId: { type: 'string', description: 'Die ID des Produkts (z. B. aus search_products).' }
                },
                required: ['productId']
            },
            run: function (args) {
                return storeApi('POST', '/product/' + encodeURIComponent(args.productId), {}).then(function (result) {
                    var product = result && (result.product || result);
                    return { product: mapProduct(product) };
                });
            }
        },
        {
            name: 'list_categories',
            description: 'Liefert die Hauptnavigation/Kategorien des Shops, um durch das Sortiment zu navigieren.',
            inputSchema: {
                type: 'object',
                properties: {
                    depth: { type: 'integer', description: 'Verschachtelungstiefe (Standard 2).', minimum: 1, maximum: 3 }
                }
            },
            run: function (args) {
                return storeApi('POST', '/navigation/main-navigation/main-navigation', {
                    depth: args.depth || 2
                }).then(function (result) {
                    var elements = (result && (result.elements || result)) || [];
                    return {
                        categories: elements.map(function (cat) {
                            return {
                                id: cat.id,
                                name: (cat.translated && cat.translated.name) || cat.name,
                                childCount: cat.childCount || 0,
                                level: cat.level
                            };
                        })
                    };
                });
            }
        },
        {
            name: 'get_cart',
            description: 'Zeigt den aktuellen Warenkorb mit Positionen, Mengen und Gesamtsumme.',
            inputSchema: { type: 'object', properties: {} },
            run: function () {
                return storeApi('GET', '/checkout/cart', null).then(function (cart) {
                    return mapCart(cart);
                });
            }
        },
        {
            name: 'add_to_cart',
            description: 'Legt ein Produkt in den Warenkorb. Erwartet die Produkt-ID und optional eine Menge.',
            inputSchema: {
                type: 'object',
                properties: {
                    productId: { type: 'string', description: 'Die ID des hinzuzufuegenden Produkts.' },
                    quantity: { type: 'integer', description: 'Menge (Standard 1).', minimum: 1 }
                },
                required: ['productId']
            },
            run: function (args) {
                return storeApi('POST', '/checkout/cart/line-item', {
                    items: [{
                        type: 'product',
                        referencedId: args.productId,
                        quantity: args.quantity || 1
                    }]
                }).then(function (cart) {
                    return mapCart(cart);
                });
            }
        },
        {
            name: 'update_cart_item',
            description: 'Aendert die Menge einer Warenkorb-Position. Erwartet die lineItemId (aus get_cart) und die neue Menge.',
            inputSchema: {
                type: 'object',
                properties: {
                    lineItemId: { type: 'string', description: 'Die ID der Warenkorb-Position.' },
                    quantity: { type: 'integer', description: 'Die neue Menge.', minimum: 1 }
                },
                required: ['lineItemId', 'quantity']
            },
            run: function (args) {
                return storeApi('PATCH', '/checkout/cart/line-item', {
                    items: [{
                        id: args.lineItemId,
                        quantity: args.quantity
                    }]
                }).then(function (cart) {
                    return mapCart(cart);
                });
            }
        },
        {
            name: 'remove_from_cart',
            description: 'Entfernt eine Position aus dem Warenkorb. Erwartet die lineItemId aus get_cart.',
            inputSchema: {
                type: 'object',
                properties: {
                    lineItemId: { type: 'string', description: 'Die ID der zu entfernenden Warenkorb-Position.' }
                },
                required: ['lineItemId']
            },
            run: function (args) {
                return storeApi('DELETE', '/checkout/cart/line-item', {
                    ids: [args.lineItemId]
                }).then(function (cart) {
                    return mapCart(cart);
                });
            }
        }
    ];

    // --- Registry & WebMCP-Verdrahtung ---------------------------------------

    // Liste der Tool-Spezifikationen (Core + Erweiterungen). Jede Spec bekommt
    // unter __webmcp ihr fertig gebautes WebMCP-Tool-Objekt.
    var registry = [];

    function toToolResult(data) {
        return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: data
        };
    }

    function toToolError(error) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Fehler: ' + (error && error.message ? error.message : String(error)) }]
        };
    }

    /**
     * Baut aus einer Tool-Spezifikation das WebMCP-Tool-Objekt mit async execute().
     * Unterstuetzt sowohl run() (vereinfachtes Ergebnis-Promise) als auch ein
     * bereits fertiges execute() (volles WebMCP-Format).
     */
    function buildWebMcpTool(spec) {
        var execute = typeof spec.execute === 'function'
            ? spec.execute
            : function (args) {
                return Promise.resolve()
                    .then(function () { return spec.run(args || {}); })
                    .then(toToolResult)
                    .catch(toToolError);
            };

        return {
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema || { type: 'object', properties: {} },
            execute: execute
        };
    }

    function internalRegister(spec) {
        if (!spec || typeof spec.name !== 'string' || !spec.name) {
            console.warn('[WebMCP] Tool ohne gueltigen Namen ignoriert.', spec);
            return;
        }
        if (typeof spec.run !== 'function' && typeof spec.execute !== 'function') {
            console.warn('[WebMCP] Tool "' + spec.name + '" ohne run()/execute() ignoriert.');
            return;
        }
        spec.__webmcp = buildWebMcpTool(spec);

        // Gleichnamiges Tool ersetzen (erlaubt Override durch andere Plugins).
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].name === spec.name) {
                registry[i] = spec;
                return;
            }
        }
        registry.push(spec);
    }

    function ensureModelContext() {
        if (navigator.modelContext) {
            return navigator.modelContext;
        }

        var registered = [];
        var polyfill = {
            __isPolyfill: true,
            _tools: registered,
            registerTool: function (tool) {
                registered.push(tool);
                return function unregister() {
                    var index = registered.indexOf(tool);
                    if (index >= 0) {
                        registered.splice(index, 1);
                    }
                };
            },
            provideContext: function (ctx) {
                registered.length = 0;
                if (ctx && Array.isArray(ctx.tools)) {
                    ctx.tools.forEach(function (tool) {
                        registered.push(tool);
                    });
                }
            }
        };

        try {
            Object.defineProperty(navigator, 'modelContext', {
                value: polyfill,
                configurable: true,
                writable: false
            });
        } catch (e) {
            window.modelContext = polyfill;
        }

        return navigator.modelContext || polyfill;
    }

    var modelContext = ensureModelContext();
    var activeUnregister = [];

    function applyToModelContext(toolObjects) {
        try {
            if (typeof modelContext.provideContext === 'function') {
                modelContext.provideContext({ tools: toolObjects });
            } else if (typeof modelContext.registerTool === 'function') {
                activeUnregister.forEach(function (fn) {
                    try { fn(); } catch (e) { /* ignorieren */ }
                });
                activeUnregister = toolObjects.map(function (tool) {
                    return modelContext.registerTool(tool) || function () {};
                });
            }
        } catch (e) {
            console.error('[WebMCP] Konnte Tools nicht publizieren:', e);
        }
    }

    var publishScheduled = false;

    function schedulePublish() {
        if (publishScheduled) {
            return;
        }
        publishScheduled = true;
        Promise.resolve().then(function () {
            publishScheduled = false;
            publish();
        });
    }

    function publish() {
        // Verfuegbarkeit jeder Spec auswerten (optionales isAvailable-Gate).
        var checks = registry.map(function (spec) {
            if (typeof spec.isAvailable !== 'function') {
                return Promise.resolve({ spec: spec, ok: true });
            }
            return Promise.resolve()
                .then(function () { return spec.isAvailable(); })
                .then(function (ok) { return { spec: spec, ok: !!ok }; })
                .catch(function () { return { spec: spec, ok: false }; });
        });

        Promise.all(checks).then(function (results) {
            var active = results
                .filter(function (r) { return r.ok; })
                .map(function (r) { return r.spec.__webmcp; });

            applyToModelContext(active);

            var names = active.map(function (tool) { return tool.name; });
            window.dispatchEvent(new CustomEvent('webmcp:ready', { detail: { tools: names } }));
            console.info('[WebMCP] ' + names.length + ' Tools aktiv: ' + names.join(', '));
        });
    }

    // --- Oeffentliche Erweiterungs-API + Command-Queue -----------------------

    var api = {
        version: '1.1.0',
        config: config,
        storeApi: storeApi,
        registerTool: function (spec) {
            internalRegister(spec);
            schedulePublish();
            var name = spec && spec.name;
            return function unregister() {
                api.unregisterTool(name);
            };
        },
        unregisterTool: function (name) {
            for (var i = 0; i < registry.length; i++) {
                if (registry[i].name === name) {
                    registry.splice(i, 1);
                    schedulePublish();
                    return true;
                }
            }
            return false;
        },
        getTools: function () {
            return registry.map(function (spec) { return spec.name; });
        },
        callTool: function (name, args) {
            for (var i = 0; i < registry.length; i++) {
                if (registry[i].name === name) {
                    return registry[i].__webmcp.execute(args || {});
                }
            }
            return Promise.reject(new Error('Unbekanntes Tool: ' + name));
        },
        refresh: function () {
            schedulePublish();
        },
        // Command-Queue-Schnittstelle: fuehrt Callback sofort mit der API aus.
        push: function (callback) {
            if (typeof callback === 'function') {
                try {
                    callback(api);
                } catch (e) {
                    console.error('[WebMCP] Fehler in Erweiterungs-Callback:', e);
                }
            }
            return api;
        }
    };

    // Eventuell vor dem Core geladene Erweiterungen standen als Array-Queue bereit.
    var pending = window.SwagWebMcp;
    window.SwagWebMcp = api;
    window.swagWebMcp = api; // Alias (Abwaertskompatibilitaet)

    // Core-Tools registrieren.
    coreTools.forEach(internalRegister);

    // Gepufferte Erweiterungs-Callbacks abarbeiten.
    if (pending && typeof pending.length === 'number') {
        Array.prototype.slice.call(pending).forEach(function (callback) {
            api.push(callback);
        });
    }

    // Signalisiert Erweiterungen, die ueber Events arbeiten, dass die API bereit ist.
    window.dispatchEvent(new CustomEvent('swag-web-mcp:ready', { detail: { mcp: api } }));

    // Erste Publikation (nach Microtask, damit synchron nachgeladene Tools mit rein kommen).
    schedulePublish();
})();
